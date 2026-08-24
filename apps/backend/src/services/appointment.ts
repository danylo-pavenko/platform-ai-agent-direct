/**
 * Salon appointment persistence + CRM mirror (CleverBOX / BeautyPro booking).
 * Also mirrors a local Order(kind=booking) + Telegram notify for managers.
 */

import pino from 'pino';
import { prisma, toInputJsonValue } from '../lib/prisma.js';
import { isCrmWriteEnabled } from '../lib/crm-write.js';
import { resolveCrmProvider } from '../lib/crm-routing.js';
import { asCrmId } from '../lib/crm-ids.js';
import { getCrmAdapter } from './crm/index.js';
import { resolveBookingBranchForAppointment } from './booking-branch.js';
import { notifyCrmFallback, notifyOrder } from './telegram-notify.js';
import {
  applyServiceMasterAssignments,
  normalizeAppointmentServices,
  servicesToJson,
  uniqueMasterIds,
  type AppointmentServiceLine,
  type ServiceMasterAssignment,
} from '../lib/appointment-services.js';
import { persistCrmBuyerIdFromBooking } from './client-crm-link.js';
import { sendText } from './instagram.js';
import { markFirstOutboundAt } from '../lib/conversation-metrics.js';
import { normalizeToUaDate, parseAgentDate } from './crm/beautypro-free-time.js';
import type { OrderLineItem } from '../lib/order-normalize.js';
import { normalizeOrderItems } from '../lib/order-normalize.js';
import { providerDisplayName } from '../lib/crm-providers.js';
import { isBeautyproTimeConflictError } from './crm/beautypro-appointment.js';
import { formatTimeConflictToolResult } from '../lib/booking-time-conflict.js';
import { getAvailableSlotsForContext } from './service-search.js';
import { applyPersonalDurations } from './personal-duration.js';
import {
  buildBookingOrderSummary,
  mergeAppointmentServiceLines,
  mergeOrderLineItems,
} from '../lib/booking-merge.js';

const log = pino({ name: 'appointment' });

export class AppointmentUpdateError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AppointmentUpdateError';
  }
}

const BOOKING_ORDER_DEDUPE_MS = 2 * 60 * 1000;

export type BookAppointmentOptions = {
  clientIgUserId?: string | null;
  /** Prefer the model's reply as the IG confirmation text. */
  clientMessage?: string | null;
  skipClientMessage?: boolean;
};

export type BookAppointmentResult = {
  appointmentId: string;
  crmSynced: boolean;
  toolResult: string;
};

export async function handleBookAppointment(
  conversationId: string,
  clientId: string,
  args: Record<string, unknown>,
  options?: BookAppointmentOptions,
): Promise<BookAppointmentResult | null> {
  const customerName =
    typeof args.customer_name === 'string' ? args.customer_name.trim() : '';
  const phone = typeof args.phone === 'string' ? args.phone.trim() : '';
  const rawDate = typeof args.date === 'string' ? args.date.trim() : '';
  const time = typeof args.time === 'string' ? args.time.trim() : '';
  const comment = typeof args.comment === 'string' ? args.comment.trim() : undefined;
  const fallbackMasterId = asCrmId(args.master_id) ?? undefined;

  const rawServices = Array.isArray(args.services) ? args.services : [];
  const services: AppointmentServiceLine[] = rawServices.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const o = raw as Record<string, unknown>;
    const id = asCrmId(o.id);
    const durationMin =
      typeof o.duration_min === 'number'
        ? o.duration_min
        : typeof o.long === 'number'
          ? o.long
          : 60;
    const name = typeof o.name === 'string' ? o.name : `Послуга #${id ?? '?'}`;
    const price = typeof o.price === 'number' ? o.price : 0;
    if (!id) return [];
    const masterId = asCrmId(o.master_id) ?? fallbackMasterId;
    return [{ id, durationMin, name, price, masterId }];
  });

  if (!customerName || !phone || !rawDate || !time || services.length === 0) {
    log.warn({ conversationId }, 'book_appointment missing required fields');
    return null;
  }

  const date = normalizeToUaDate(rawDate);
  if (!parseAgentDate(date)) {
    log.warn({ conversationId, rawDate }, 'book_appointment invalid date (need DD.MM.YYYY)');
    return null;
  }

  const personal = await applyPersonalDurations({
    clientId,
    services: services.map((s) => ({
      id: s.id,
      durationMin: s.durationMin,
      masterId: s.masterId,
      name: s.name,
    })),
  });
  for (let i = 0; i < services.length; i++) {
    const next = personal.services[i];
    if (next && services[i]) {
      services[i]!.durationMin = next.durationMin;
    }
  }
  if (personal.notes.length > 0) {
    log.info(
      { conversationId, clientId, notes: personal.notes },
      'book_appointment: personal duration applied',
    );
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { branchId: true },
  });

  const resolved = await resolveBookingBranchForAppointment({
    conversationBranchId: conversation?.branchId,
  });

  if (!resolved?.crmExternalId) {
    log.warn(
      { conversationId, branchId: conversation?.branchId },
      'book_appointment: no CRM location (conversation / default / BeautyPro)',
    );
    return null;
  }

  if (resolved.source !== 'conversation') {
    log.info(
      {
        conversationId,
        source: resolved.source,
        crmExternalId: resolved.crmExternalId,
        branchId: resolved.branchId,
      },
      'book_appointment: using branch fallback (same cascade as slots)',
    );
  }

  // Pin resolved local branch on the conversation for later turns.
  if (resolved.branchId && resolved.branchId !== conversation?.branchId) {
    await prisma.conversation
      .update({
        where: { id: conversationId },
        data: { branchId: resolved.branchId },
      })
      .catch((err) => {
        log.warn({ err, conversationId }, 'Failed to pin conversation branch (non-fatal)');
      });
  }

  const crmProvider = await resolveCrmProvider('booking', {
    toolProvider:
      typeof args.crm_provider === 'string' ? args.crm_provider : undefined,
  });

  const mergeTarget = await prisma.appointment.findFirst({
    where: {
      conversationId,
      scheduledDate: date,
      scheduledTime: time,
      status: { not: 'cancelled' },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      services: true,
      crmRecordId: true,
      crmSyncStatus: true,
      crmSyncError: true,
      crmSyncedAt: true,
      branchId: true,
    },
  });

  let appointment: { id: string };
  let mergedIntoExisting = false;
  let addedServiceCount = 0;
  let previousServiceCount = 0;

  if (mergeTarget) {
    const existingServices = normalizeAppointmentServices(mergeTarget.services);
    previousServiceCount = existingServices.length;
    const { merged, added } = mergeAppointmentServiceLines(existingServices, services);
    addedServiceCount = added.length;
    mergedIntoExisting = true;

    appointment = await prisma.appointment.update({
      where: { id: mergeTarget.id },
      data: {
        services: toInputJsonValue(servicesToJson(merged))!,
        customerName,
        phone,
        comment: comment ?? undefined,
        branchId: resolved.branchId ?? mergeTarget.branchId,
        crmProvider,
        ...(addedServiceCount > 0 && mergeTarget.crmRecordId
          ? { crmSyncStatus: 'pending' as const }
          : {}),
      },
      select: { id: true },
    });

    if (addedServiceCount === 0) {
      log.info(
        { conversationId, appointmentId: appointment.id },
        'book_appointment: idempotent merge — services already on visit',
      );
    } else {
      log.info(
        {
          conversationId,
          appointmentId: appointment.id,
          addedServiceCount,
          previousServiceCount,
        },
        'book_appointment: merged services into existing visit',
      );
    }
  } else {
    appointment = await prisma.appointment.create({
      data: {
        conversationId,
        clientId,
        branchId: resolved.branchId,
        services: toInputJsonValue(services)!,
        scheduledDate: date,
        scheduledTime: time,
        customerName,
        phone,
        comment,
        status: 'confirmed',
        crmProvider,
        crmSyncStatus: 'pending',
      },
      select: { id: true },
    });
  }

  const mergedServices = mergedIntoExisting
    ? normalizeAppointmentServices(
        (
          await prisma.appointment.findUnique({
            where: { id: appointment.id },
            select: { services: true },
          })
        )?.services,
      )
    : services;

  await upsertBookingOrderMirror({
    appointmentId: appointment.id,
    conversationId,
    clientId,
    clientIgUserId: options?.clientIgUserId ?? null,
    customerName,
    phone,
    date,
    time,
    branchName: resolved.displayName,
    services: mergedServices.map((s) => ({
      name: s.name ?? 'Послуга',
      price: s.price ?? 0,
      qty: 1,
    })),
    masterIds: uniqueMasterIds(mergedServices),
    comment,
    mergeIntoExisting: mergedIntoExisting,
  }).catch((err) => {
    log.error({ err, appointmentId: appointment.id }, 'Booking Order mirror failed (non-fatal)');
  });

  const writeEnabled = await isCrmWriteEnabled();
  let crmSynced = !writeEnabled;
  let crmError: string | null = null;

  if (writeEnabled) {
    try {
      if (mergedIntoExisting && mergeTarget?.crmRecordId && addedServiceCount === 0) {
        crmSynced =
          mergeTarget.crmSyncStatus === 'synced' && Boolean(mergeTarget.crmRecordId);
      } else if (mergedIntoExisting && mergeTarget?.crmRecordId && addedServiceCount > 0) {
        await appendAppointmentServicesToCrm(appointment.id, {
          previousServiceCount,
          fallbackCrmExternalId: resolved.crmExternalId,
        });
        const after = await prisma.appointment.findUnique({
          where: { id: appointment.id },
          select: { crmSyncStatus: true, crmSyncError: true, crmRecordId: true },
        });
        crmSynced = after?.crmSyncStatus === 'synced' && Boolean(after.crmRecordId);
        crmError = after?.crmSyncError ?? null;
      } else {
        await mirrorAppointmentToCrm(appointment.id, {
          fallbackCrmExternalId: resolved.crmExternalId,
        });
        const after = await prisma.appointment.findUnique({
          where: { id: appointment.id },
          select: { crmSyncStatus: true, crmSyncError: true, crmRecordId: true },
        });
        crmSynced = after?.crmSyncStatus === 'synced' && Boolean(after.crmRecordId);
        crmError = after?.crmSyncError ?? null;
      }
    } catch (err) {
      crmError = err instanceof Error ? err.message : String(err);
      log.error({ err, appointmentId: appointment.id }, 'Appointment CRM mirror failed');
    }
  }

  if (crmSynced) {
    const igUserId = options?.clientIgUserId?.trim();
    const skipDuplicateConfirm = mergedIntoExisting && addedServiceCount === 0;
    if (igUserId && !options?.skipClientMessage && !skipDuplicateConfirm) {
      const confirmationText =
        options?.clientMessage?.trim() ||
        `Запис підтверджено: ${date} о ${time}. Чекаємо тебе!`;
      try {
        await sendText(igUserId, confirmationText);
        await prisma.message.create({
          data: {
            conversationId,
            direction: 'out',
            sender: 'bot',
            text: confirmationText,
          },
        });
        markFirstOutboundAt(conversationId).catch((err) =>
          log.warn({ err, conversationId }, 'markFirstOutboundAt failed (non-fatal)'),
        );
      } catch (err) {
        log.error(
          { err, conversationId, appointmentId: appointment.id },
          'Failed to send booking confirmation to IG',
        );
      }
    }
    return {
      appointmentId: appointment.id,
      crmSynced: true,
      toolResult:
        personal.notes.length > 0
          ? `[book_appointment] ok id=${appointment.id}${mergedIntoExisting ? ' merged' : ''}\n${personal.notes.join('\n')}`
          : `[book_appointment] ok id=${appointment.id}${mergedIntoExisting ? ' merged' : ''}`,
    };
  }

  // CRM failed — never send «записали» to the client from this path.
  let toolResult = `[book_appointment] failed: ${(crmError ?? 'CRM sync failed').slice(0, 400)}`;
  if (crmError && isBeautyproTimeConflictError(crmError)) {
    try {
      const alternativesText = await getAvailableSlotsForContext({
        date,
        branchCrmId: resolved.crmExternalId,
        services: services.map((s) => ({
          id: s.id,
          durationMin: s.durationMin,
          masterId: s.masterId,
          name: s.name,
        })),
        fullMonth: true,
        excludeTime: time,
        clientId,
      });
      toolResult = formatTimeConflictToolResult({
        failedDate: date,
        failedTime: time,
        alternativesText,
      });
    } catch (err) {
      log.warn({ err, appointmentId: appointment.id }, 'TIME_CONFLICT alternatives lookup failed');
      toolResult = formatTimeConflictToolResult({
        failedDate: date,
        failedTime: time,
        alternativesText: '',
      });
    }
  }

  return {
    appointmentId: appointment.id,
    crmSynced: false,
    toolResult,
  };
}

async function upsertBookingOrderMirror(params: {
  appointmentId: string;
  conversationId: string;
  clientId: string;
  clientIgUserId: string | null;
  customerName: string;
  phone: string;
  date: string;
  time: string;
  branchName?: string | null;
  services: OrderLineItem[];
  masterIds?: string[];
  comment?: string;
  mergeIntoExisting?: boolean;
}): Promise<string | null> {
  const {
    appointmentId,
    conversationId,
    clientId,
    clientIgUserId,
    customerName,
    phone,
    date,
    time,
    branchName,
    services,
    masterIds,
    comment,
    mergeIntoExisting = false,
  } = params;

  const appointmentMarker = `appointmentId=${appointmentId}`;
  const existingByMarker = await prisma.order.findFirst({
    where: {
      conversationId,
      kind: 'booking',
      isArchived: false,
      status: { notIn: ['cancelled'] },
      note: { contains: appointmentMarker },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, items: true, note: true },
  });
  if (existingByMarker) {
    const currentItems = normalizeOrderItems(existingByMarker.items, '');
    const nextItems = mergeOrderLineItems(currentItems, services);
    const serviceNames = nextItems.map((s) => s.name).filter(Boolean);
    const summary = buildBookingOrderSummary({ serviceNames, date, time });
    const noteParts = [
      summary,
      branchName ? `Філія: ${branchName}` : null,
      ...(masterIds ?? []).map((id) => `master_id=${id}`),
      comment ? `Коментар: ${comment}` : null,
      appointmentMarker,
    ].filter(Boolean) as string[];

    await prisma.order.update({
      where: { id: existingByMarker.id },
      data: {
        items: toInputJsonValue(nextItems)!,
        note: noteParts.join('\n'),
        customerName,
        phone,
        npBranch: `${date} ${time}`,
      },
    });
    log.info(
      { conversationId, orderId: existingByMarker.id, appointmentId },
      'booking Order mirror updated (merged items)',
    );
    return existingByMarker.id;
  }

  if (mergeIntoExisting) {
    const sameSlot = await prisma.order.findFirst({
      where: {
        conversationId,
        kind: 'booking',
        isArchived: false,
        status: { notIn: ['cancelled'] },
        note: { contains: `${date} ${time}` },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, items: true },
    });
    if (sameSlot) {
      const currentItems = normalizeOrderItems(sameSlot.items, '');
      const nextItems = mergeOrderLineItems(currentItems, services);
      const serviceNames = nextItems.map((s) => s.name).filter(Boolean);
      const summary = buildBookingOrderSummary({ serviceNames, date, time });
      const noteParts = [
        summary,
        branchName ? `Філія: ${branchName}` : null,
        ...(masterIds ?? []).map((id) => `master_id=${id}`),
        comment ? `Коментар: ${comment}` : null,
        appointmentMarker,
      ].filter(Boolean) as string[];

      await prisma.order.update({
        where: { id: sameSlot.id },
        data: {
          items: toInputJsonValue(nextItems)!,
          note: noteParts.join('\n'),
          customerName,
          phone,
          npBranch: `${date} ${time}`,
        },
      });
      log.info(
        { conversationId, orderId: sameSlot.id, appointmentId },
        'booking Order mirror linked to merged visit',
      );
      return sameSlot.id;
    }
  }

  const since = new Date(Date.now() - BOOKING_ORDER_DEDUPE_MS);
  const recent = await prisma.order.findFirst({
    where: {
      conversationId,
      kind: 'booking',
      isArchived: false,
      status: { notIn: ['cancelled'] },
      createdAt: { gte: since },
      OR: [
        { note: { contains: appointmentMarker } },
        { note: { contains: `${date} ${time}` } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (recent) {
    log.info(
      { conversationId, orderId: recent.id, appointmentId },
      'booking Order deduped — recent matching order',
    );
    return recent.id;
  }

  const summary = buildBookingOrderSummary({
    serviceNames: services.map((s) => s.name).filter(Boolean),
    date,
    time,
  });
  const noteParts = [
    summary,
    branchName ? `Філія: ${branchName}` : null,
    ...(masterIds ?? []).map((id) => `master_id=${id}`),
    comment ? `Коментар: ${comment}` : null,
    appointmentMarker,
  ].filter(Boolean) as string[];

  const items: OrderLineItem[] =
    services.length > 0
      ? services.map((s) => ({
          name: s.name || 'Послуга',
          price: Number(s.price) || 0,
          qty: 1,
        }))
      : [{ name: summary, price: 0, qty: 1 }];

  const order = await prisma.order.create({
    data: {
      conversationId,
      clientId,
      kind: 'booking',
      items: toInputJsonValue(items)!,
      customerName,
      phone,
      note: noteParts.join('\n'),
      status: 'submitted',
      submittedToManagerAt: new Date(),
      crmSyncStatus: 'skipped',
    },
  });

  if (clientIgUserId) {
    notifyOrder({
      orderId: order.id,
      conversationId,
      clientIgUserId,
      kind: 'booking',
      summary,
      items,
      customerName,
      phone,
      city: branchName ?? null,
      npBranch: `${date} ${time}`,
      paymentMethod: null,
    }).catch((err) => {
      log.error(
        { err, orderId: order.id, conversationId },
        'Failed to send booking Telegram notification',
      );
    });
  }

  log.info(
    { orderId: order.id, appointmentId, conversationId },
    'Booking Order mirror created (CRM skipped — Appointment owns CRM)',
  );

  return order.id;
}

export async function reflectAppointmentCrmOnOrder(appointment: {
  id: string;
  crmRecordId: string | null;
  crmSyncStatus: string;
  crmSyncError: string | null;
  crmSyncedAt: Date | null;
}): Promise<void> {
  const marker = `appointmentId=${appointment.id}`;
  const crmSyncStatus = appointment.crmRecordId ? 'synced' : appointment.crmSyncStatus;
  await prisma.order.updateMany({
    where: { kind: 'booking', note: { contains: marker } },
    data: {
      crmSyncStatus: crmSyncStatus as 'pending' | 'synced' | 'failed' | 'skipped',
      crmSyncError: appointment.crmRecordId ? null : appointment.crmSyncError,
      crmSyncedAt: appointment.crmSyncedAt,
    },
  });
}

async function appendAppointmentServicesToCrm(
  appointmentId: string,
  opts: { previousServiceCount: number; fallbackCrmExternalId?: string | null },
): Promise<void> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { branch: true, client: true },
  });
  if (!appointment?.crmRecordId) {
    throw new Error('Appointment CRM record missing for append');
  }

  const provider = await resolveCrmProvider('booking');
  const crm = getCrmAdapter(provider);
  if (!crm.appendBookingServices) {
    throw new Error(`${providerDisplayName(provider)} не підтримує додавання послуг до запису`);
  }

  let branchCrmId =
    appointment.branch?.crmExternalId?.trim() ||
    opts.fallbackCrmExternalId?.trim() ||
    '';
  if (!branchCrmId) {
    const resolved = await resolveBookingBranchForAppointment({
      conversationBranchId: appointment.branchId,
    });
    branchCrmId = resolved?.crmExternalId?.trim() || '';
  }
  if (!branchCrmId) {
    throw new Error('Branch CRM external id missing');
  }

  const rawServices = normalizeAppointmentServices(appointment.services);
  const services = rawServices.map((s) => ({
    id: s.id,
    durationMin: s.durationMin,
    startTime: appointment.scheduledTime,
    masterId: s.masterId,
  }));

  await crm.appendBookingServices({
    crmRecordId: appointment.crmRecordId,
    date: appointment.scheduledDate,
    branchId: branchCrmId,
    clientName: appointment.customerName,
    phone: appointment.phone,
    comment: appointment.comment ?? undefined,
    clientId: appointment.client?.crmBuyerId ?? undefined,
    startTime: appointment.scheduledTime,
    services,
    previousServiceCount: opts.previousServiceCount,
  });

  const syncedAt = new Date();
  await prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      crmSyncStatus: 'synced',
      crmSyncError: null,
      crmSyncedAt: syncedAt,
      status: 'synced',
    },
  });
  await reflectAppointmentCrmOnOrder({
    id: appointmentId,
    crmRecordId: appointment.crmRecordId,
    crmSyncStatus: 'synced',
    crmSyncError: null,
    crmSyncedAt: syncedAt,
  });
}

export async function mirrorAppointmentToCrm(
  appointmentId: string,
  opts?: {
    fallbackCrmExternalId?: string | null;
    /** Bypass CRM_WRITE_ENABLED gate (admin retry). Not BeautyPro TIME_CONFLICT force. */
    force?: boolean;
    /**
     * BeautyPro POST ?force=true. Default true (skip TIME_CONFLICT).
     * Pass false only for strict calendar validation.
     */
    forceTimeConflict?: boolean;
  },
): Promise<void> {
  if (!opts?.force && !(await isCrmWriteEnabled())) return;

  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { branch: true, client: true },
  });
  if (!appointment) return;

  if (appointment.crmRecordId) {
    if (appointment.crmSyncStatus !== 'synced') {
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: { crmSyncStatus: 'synced', crmSyncError: null },
      });
    }
    await reflectAppointmentCrmOnOrder({
      id: appointmentId,
      crmRecordId: appointment.crmRecordId,
      crmSyncStatus: 'synced',
      crmSyncError: null,
      crmSyncedAt: appointment.crmSyncedAt,
    });
    return;
  }

  const provider = await resolveCrmProvider('booking');
  const crm = getCrmAdapter(provider);

  if (!crm.createBooking) {
    const message = `${providerDisplayName(provider)} не підтримує створення записів`;
    if (opts?.force) throw new Error(message);
    log.debug({ provider: crm.name }, 'CRM has no booking API — skipping');
    return;
  }

  try {
    let branchCrmId =
      appointment.branch?.crmExternalId?.trim() ||
      opts?.fallbackCrmExternalId?.trim() ||
      '';
    if (!branchCrmId) {
      const resolved = await resolveBookingBranchForAppointment({
        conversationBranchId: appointment.branchId,
      });
      branchCrmId = resolved?.crmExternalId?.trim() || '';
    }
    if (!branchCrmId) {
      throw new Error('Branch CRM external id missing');
    }

    const rawServices = Array.isArray(appointment.services) ? appointment.services : [];
    const services = rawServices.flatMap((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const o = raw as Record<string, unknown>;
      const id = asCrmId(o.id);
      const durationMin = typeof o.durationMin === 'number' ? o.durationMin : 60;
      const masterId = asCrmId(o.masterId) ?? asCrmId(o.master_id) ?? undefined;
      if (!id) return [];
      return [{
        id,
        durationMin,
        startTime: appointment.scheduledTime,
        masterId,
      }];
    });

    let photoNote = '';
    const photos = await prisma.clientReferencePhoto.findMany({
      where: { clientId: appointment.clientId, conversationId: appointment.conversationId },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });
    if (photos.length > 0) {
      photoNote = `\nРеференс-фото: ${photos.map((p) => p.storageKey).join(', ')}`;
    }

    const result = await crm.createBooking({
      date: appointment.scheduledDate,
      branchId: branchCrmId,
      clientName: appointment.customerName,
      phone: appointment.phone,
      comment: [appointment.comment, photoNote].filter(Boolean).join('\n') || undefined,
      services,
      forceTimeConflict: opts?.forceTimeConflict !== false,
    });

    const syncedAt = new Date();
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        crmRecordId: result.crmRecordId,
        crmSyncStatus: 'synced',
        crmSyncError: null,
        crmSyncedAt: syncedAt,
        status: 'synced',
      },
    });
    await reflectAppointmentCrmOnOrder({
      id: appointmentId,
      crmRecordId: result.crmRecordId,
      crmSyncStatus: 'synced',
      crmSyncError: null,
      crmSyncedAt: syncedAt,
    });

    if (result.crmBuyerId) {
      await persistCrmBuyerIdFromBooking(
        appointment.clientId,
        result.crmBuyerId,
        provider,
      ).catch((err) => {
        log.warn({ err, appointmentId }, 'Failed to persist crmBuyerId from booking');
      });
    }
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { crmSyncStatus: 'failed', crmSyncError: errMessage.slice(0, 500), status: 'failed' },
    });
    await reflectAppointmentCrmOnOrder({
      id: appointmentId,
      crmRecordId: null,
      crmSyncStatus: 'failed',
      crmSyncError: errMessage.slice(0, 500),
      crmSyncedAt: null,
    });
    notifyCrmFallback({
      kind: 'order',
      entityId: appointmentId,
      reason: errMessage,
      clientIgUserId: appointment.client.igUserId ?? undefined,
      snapshot: [
        { label: "Ім'я", value: appointment.customerName },
        { label: 'Телефон', value: appointment.phone },
        { label: 'Дата', value: `${appointment.scheduledDate} ${appointment.scheduledTime}` },
        { label: 'Філія', value: appointment.branch?.displayName ?? null },
      ],
    }).catch(() => undefined);
    throw err;
  }
}

export async function updateAppointmentServiceMasters(params: {
  appointmentId: string;
  assignments: ServiceMasterAssignment[];
  force?: boolean;
}): Promise<{ services: AppointmentServiceLine[] }> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: params.appointmentId },
    select: { id: true, services: true, crmRecordId: true, status: true },
  });
  if (!appointment) {
    throw new AppointmentUpdateError('Повʼязаний запис не знайдено', 404);
  }
  if (appointment.status === 'cancelled') {
    throw new AppointmentUpdateError('Скасований запис не змінюється', 400);
  }
  if (appointment.crmRecordId && !params.force) {
    throw new AppointmentUpdateError('Запис уже в CRM — майстрів не змінюємо без force', 400);
  }

  const current = normalizeAppointmentServices(appointment.services);
  let next: AppointmentServiceLine[];
  try {
    next = applyServiceMasterAssignments(current, params.assignments);
  } catch (err) {
    throw new AppointmentUpdateError(
      err instanceof Error ? err.message : 'Некоректне призначення майстра',
      400,
    );
  }
  await prisma.appointment.update({
    where: { id: appointment.id },
    data: { services: toInputJsonValue(servicesToJson(next))! },
  });
  return { services: next };
}

export async function listBookingMasters(): Promise<Array<{ id: string; name: string }>> {
  const provider = await resolveCrmProvider('booking');
  const crm = getCrmAdapter(provider);
  if (!crm.fetchEmployees) return [];
  const rows = await crm.fetchEmployees();
  return rows
    .filter((row) => row.public !== false)
    .map((row) => ({ id: row.id, name: row.name }));
}
