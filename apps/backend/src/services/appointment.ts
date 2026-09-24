/**
 * Salon appointment persistence + CRM mirror (CleverBOX / BeautyPro booking).
 * Also mirrors a local Order(kind=booking) + Telegram notify for managers.
 */

import pino from 'pino';
import { prisma, toInputJsonValue } from '../lib/prisma.js';
import { isCrmWriteEnabled } from '../lib/crm-write.js';
import { resolveCrmProvider } from '../lib/crm-routing.js';
import { asCrmId, crmProviderRequiresGuid, crmProviderRequiresNumericId, formatInvalidCrmIdToolResult, isCrmGuid, isCrmGuidPrefix, isCrmNumericId, resolveCrmEntityId, shouldResolveBookingCrmIds } from '../lib/crm-ids.js';
import { getCrmAdapter } from './crm/index.js';
import { resolveBookingBranchForAppointment } from './booking-branch.js';
import { notifyCrmFallback, notifyOrder, notifyBookingLifecycle } from './telegram-notify.js';
import {
  applyServiceMasterAssignments,
  normalizeAppointmentServices,
  servicesToJson,
  uniqueMasterIds,
  type AppointmentServiceLine,
  type ServiceMasterAssignment,
} from '../lib/appointment-services.js';
import { persistCrmBuyerIdFromBooking } from './client-crm-link.js';
import { effectiveChatDisplayName } from '../lib/client-person-name.js';
import { sendText } from './instagram.js';
import { persistIgOutboundMessage } from './ig-outbound-persist.js';
import { markFirstOutboundAt } from '../lib/conversation-metrics.js';
import { normalizeToUaDate, parseAgentDate } from './crm/beautypro-free-time.js';
import type { OrderLineItem } from '../lib/order-normalize.js';
import { normalizeOrderItems } from '../lib/order-normalize.js';
import { providerDisplayName } from '../lib/crm-providers.js';
import { isBeautyproTimeConflictError } from './crm/beautypro-appointment.js';
import { formatTimeConflictToolResult } from '../lib/booking-time-conflict.js';
import { lookupAvailableSlotsForContext } from './service-search.js';
import { persistBookingSlotOffer, clearConversationBookingOffer, loadFreshBookingSlotOffer } from './booking-slot-offer-store.js';
import { collectOfferCrmIds, collectOfferNameHints } from '../lib/booking-slot-offer.js';
import { loadSyncedServices } from '../lib/synced-services.js';
import { applyPersonalDurations } from './personal-duration.js';
import { getAgentConfig } from '../lib/agent-config.js';
import {
  buildBookingOrderSummary,
  mergeAppointmentServiceLines,
  mergeOrderLineItems,
} from '../lib/booking-merge.js';
import {
  buildBookingConfirmationText,
  normalizeServiceStartTime,
} from '../lib/booking-confirmation.js';
import {
  buildServiceNameCatalog,
  resolveServiceDisplayName,
} from '../lib/service-display-name.js';
import {
  checkBookingMasterServiceFit,
  formatMasterServiceMismatchToolResult,
} from '../lib/master-service-fit.js';
import {
  checkBookingMastersSchedule,
  scheduleMismatchToToolResult,
} from '../lib/booking-schedule-check.js';

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
  const serviceNameCatalog = buildServiceNameCatalog(await loadSyncedServices());
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
    const rawName = typeof o.name === 'string' ? o.name : undefined;
    const name = id
      ? resolveServiceDisplayName(rawName, id, serviceNameCatalog)
      : (rawName?.trim() || 'Послуга');
    const price = typeof o.price === 'number' ? o.price : 0;
    if (!id) return [];
    const masterId = asCrmId(o.master_id) ?? fallbackMasterId;
    const startTime = normalizeServiceStartTime(
      typeof o.start_time === 'string'
        ? o.start_time
        : typeof o.startTime === 'string'
          ? o.startTime
          : undefined,
    );
    return [{ id, durationMin, name, price, masterId, startTime }];
  });

  if (!customerName || !phone || !rawDate || !time || services.length === 0) {
    log.warn({ conversationId }, 'book_appointment missing required fields');
    return null;
  }

  if (!effectiveChatDisplayName(customerName)) {
    log.warn(
      { conversationId, customerName },
      'book_appointment rejected customer_name — not a chat person name',
    );
    return {
      appointmentId: '',
      crmSynced: false,
      toolResult:
        '[book_appointment] failed: INVALID_CUSTOMER_NAME. customer_name must be a person name (row «Імʼя:» or as said in chat), not an Instagram profile headline. Ask their name, update_client_info(full_name), then book again.',
    };
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

  const crmProvider = await resolveCrmProvider('booking', {
    toolProvider:
      typeof args.crm_provider === 'string' ? args.crm_provider : undefined,
  });

  const shouldResolveIds = shouldResolveBookingCrmIds(crmProvider);
  if (shouldResolveIds) {
    const offer = await loadFreshBookingSlotOffer(conversationId);
    const catalog = await loadSyncedServices().catch(() => []);
    const candidates = [
      ...collectOfferCrmIds(offer),
      ...catalog.filter((s) => s.provider === crmProvider).map((s) => s.id),
    ];
    const names = collectOfferNameHints(offer);
    const resolveOpts = {
      requireGuid: crmProviderRequiresGuid(crmProvider),
      requireNumeric: crmProviderRequiresNumericId(crmProvider),
      names,
    };
    for (const line of services) {
      const svc = resolveCrmEntityId(line.id, candidates, resolveOpts);
      if (!svc.ok) {
        log.warn({ conversationId, fail: svc, field: 'service_id', crmProvider }, 'book_appointment: INVALID_CRM_ID');
        return {
          appointmentId: '',
          crmSynced: false,
          toolResult: formatInvalidCrmIdToolResult(svc),
        };
      }
      if (svc.expandedFrom) {
        log.info(
          { conversationId, from: svc.expandedFrom, to: svc.id, crmProvider },
          'book_appointment: expanded truncated service_id',
        );
      }
      line.id = svc.id;
      if (line.masterId) {
        const master = resolveCrmEntityId(line.masterId, candidates, resolveOpts);
        if (!master.ok) {
          log.warn({ conversationId, fail: master, field: 'master_id', crmProvider }, 'book_appointment: INVALID_CRM_ID');
          return {
            appointmentId: '',
            crmSynced: false,
            toolResult: formatInvalidCrmIdToolResult(master),
          };
        }
        if (master.expandedFrom) {
          log.info(
            { conversationId, from: master.expandedFrom, to: master.id, crmProvider },
            'book_appointment: expanded truncated master_id',
          );
        }
        line.masterId = master.id;
      }
    }
  }

  // Soft-guard: refuse master_id that CRM grades mark as unavailable for the service
  // (e.g. manicure Anastasia booked for hair toning when two share a name).
  const mismatches = await checkBookingMasterServiceFit({
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      masterId: s.masterId,
    })),
    branchId: resolved.crmExternalId,
  });
  if (mismatches.length > 0) {
    log.warn(
      { conversationId, mismatches },
      'book_appointment: MASTER_SERVICE_MISMATCH — refusing CRM write',
    );
    return {
      appointmentId: '',
      crmSynced: false,
      toolResult: formatMasterServiceMismatchToolResult(mismatches),
    };
  }

  const scheduleMismatch = await checkBookingMastersSchedule({
    date,
    time,
    branchId: resolved.crmExternalId,
    services: services.map((s) => ({
      id: s.id,
      durationMin: s.durationMin,
      masterId: s.masterId,
      name: s.name,
      startTime: s.startTime,
    })),
    timeZone: (await getAgentConfig()).timezone,
  });
  if (scheduleMismatch) {
    log.warn(
      { conversationId, scheduleMismatch },
      'book_appointment: schedule guard — refusing (day closed or slot not in free_time)',
    );
    return {
      appointmentId: '',
      crmSynced: false,
      toolResult: scheduleMismatchToToolResult(scheduleMismatch),
    };
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

  if (!writeEnabled) {
    await prisma.appointment
      .update({
        where: { id: appointment.id },
        data: { crmSyncStatus: 'skipped' },
      })
      .catch((err) => {
        log.warn({ err, appointmentId: appointment.id }, 'Failed to mark appointment CRM skipped');
      });
  }

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
    await clearConversationBookingOffer(conversationId);
    const igUserId = options?.clientIgUserId?.trim();
    const skipDuplicateConfirm = mergedIntoExisting && addedServiceCount === 0;
    if (igUserId && !options?.skipClientMessage && !skipDuplicateConfirm) {
      const confirmationText = buildBookingConfirmationText({
        date,
        time,
        services: mergedServices.map((s) => ({
          name: resolveServiceDisplayName(s.name, s.id, serviceNameCatalog),
          startTime: s.startTime,
        })),
        clientMessage: options?.clientMessage,
      });
      try {
        const igMessageIds = await sendText(igUserId, confirmationText);
        await persistIgOutboundMessage({
          conversationId,
          sender: 'bot',
          text: confirmationText,
          igMessageIds,
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
          ? `[book_appointment] ok id=${appointment.id}${mergedIntoExisting ? ' merged' : ''}\n${personal.notes.join('\n')}\n[platform] Запис створено. НЕ пропонуй інші години/варіанти в цій відповіді і не викликай get_available_slots знову, доки клієнт не попросить перенести.`
          : `[book_appointment] ok id=${appointment.id}${mergedIntoExisting ? ' merged' : ''}\n[platform] Запис створено. НЕ пропонуй інші години/варіанти в цій відповіді і не викликай get_available_slots знову, доки клієнт не попросить перенести.`,
    };
  }

  // CRM failed — never send «записали» to the client from this path.
  let toolResult = `[book_appointment] failed: ${(crmError ?? 'CRM sync failed').slice(0, 400)}`;
  if (
    crmError &&
    (crmError.includes('MASTER_DAY_CLOSED') || crmError.includes('SLOT_NOT_AVAILABLE'))
  ) {
    toolResult = crmError;
  } else if (crmError && isBeautyproTimeConflictError(crmError)) {
    try {
      const { text: alternativesText, offer } = await lookupAvailableSlotsForContext({
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
        timeZone: (await getAgentConfig()).timezone,
      });
      if (offer) await persistBookingSlotOffer(conversationId, offer);
      else await clearConversationBookingOffer(conversationId);
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
      // Already booked in CRM + confirmed to the client — no manager approve gate.
      status: 'confirmed',
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
    startTime: s.startTime || appointment.scheduledTime,
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
      const startTime =
        normalizeServiceStartTime(
          typeof o.startTime === 'string'
            ? o.startTime
            : typeof o.start_time === 'string'
              ? o.start_time
              : undefined,
        ) ?? appointment.scheduledTime;
      if (!id) return [];
      return [{
        id,
        durationMin,
        startTime,
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

async function findActiveBookingAppointment(conversationId: string) {
  return prisma.appointment.findFirst({
    where: {
      conversationId,
      status: { in: ['confirmed', 'synced'] },
    },
    orderBy: { createdAt: 'desc' },
    include: { client: true, branch: true },
  });
}

async function markLocalAppointmentCancelled(appointmentId: string): Promise<void> {
  await prisma.appointment.update({
    where: { id: appointmentId },
    data: { status: 'cancelled' },
  });
  await prisma.order.updateMany({
    where: { kind: 'booking', note: { contains: `appointmentId=${appointmentId}` } },
    data: {
      status: 'cancelled',
      isArchived: true,
      archivedAt: new Date(),
    },
  });
}

/**
 * Admin / ops: cancel a booking by Appointment id.
 * Local cancel always; CRM cancel only when opts.cancelCrm === true.
 * Does not message the Instagram client.
 */
export async function cancelAppointmentById(
  appointmentId: string,
  opts?: { reason?: string; notifyTelegram?: boolean; cancelCrm?: boolean },
): Promise<{
  appointmentId: string;
  crmCancelled: boolean;
  crmError: string | null;
  crmSkipped: boolean;
}> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { client: true },
  });
  if (!appointment) {
    throw new AppointmentUpdateError('Запис не знайдено', 404);
  }
  if (appointment.status === 'cancelled') {
    throw new AppointmentUpdateError('Запис уже скасовано', 400);
  }

  const reason =
    opts?.reason?.trim() || 'Скасовано менеджером в адмінці';

  let crmCancelled = false;
  let crmError: string | null = null;
  let crmSkipped = true;

  if (opts?.cancelCrm === true) {
    crmSkipped = false;
    if (!appointment.crmRecordId) {
      crmError = 'Немає CRM record id — скасовано лише локально';
    } else if (!(await isCrmWriteEnabled())) {
      crmError = 'CRM write вимкнено — скасовано лише локально';
    } else {
      try {
        const provider = await resolveCrmProvider('booking');
        const crm = getCrmAdapter(provider);
        if (!crm.cancelBooking) {
          crmError = `CRM ${provider} не підтримує скасування запису`;
        } else {
          await crm.cancelBooking(appointment.crmRecordId, 'cancel');
          crmCancelled = true;
        }
      } catch (err) {
        crmError = err instanceof Error ? err.message : String(err);
        log.warn(
          { err, appointmentId },
          'Admin cancelAppointment CRM failed — continuing with local cancel',
        );
      }
    }
  }

  await markLocalAppointmentCancelled(appointment.id);

  if (opts?.notifyTelegram !== false) {
    notifyBookingLifecycle({
      kind: 'cancelled',
      appointmentId: appointment.id,
      conversationId: appointment.conversationId,
      clientIgUserId: appointment.client.igUserId,
      summary: `${appointment.scheduledDate} ${appointment.scheduledTime}`,
      customerName: appointment.customerName,
      phone: appointment.phone,
      reason: opts?.cancelCrm
        ? reason
        : `${reason} (лише локально, без CRM)`,
    }).catch(() => undefined);
  }

  log.info(
    { appointmentId: appointment.id, crmCancelled, crmError, crmSkipped },
    'Appointment cancelled from admin',
  );

  return { appointmentId: appointment.id, crmCancelled, crmError, crmSkipped };
}

async function sendClientLifecycleMessage(
  conversationId: string,
  igUserId: string | null | undefined,
  text: string,
  skip?: boolean,
): Promise<void> {
  if (skip || !igUserId?.trim()) return;
  try {
    const igMessageIds = await sendText(igUserId, text);
    await persistIgOutboundMessage({
      conversationId,
      sender: 'bot',
      text,
      igMessageIds,
    });
    markFirstOutboundAt(conversationId).catch(() => undefined);
  } catch (err) {
    log.error({ err, conversationId }, 'Failed to send booking lifecycle IG message');
  }
}

export async function handleCancelAppointment(
  conversationId: string,
  clientId: string,
  args: Record<string, unknown>,
  options?: BookAppointmentOptions,
): Promise<BookAppointmentResult | null> {
  const appointment = await findActiveBookingAppointment(conversationId);
  if (!appointment || appointment.clientId !== clientId) {
    return {
      appointmentId: '',
      crmSynced: false,
      toolResult:
        '[cancel_appointment] failed: немає активного запису в цій розмові. Уточни деталі або request_handoff.',
    };
  }

  const reason =
    typeof args.reason === 'string' && args.reason.trim()
      ? args.reason.trim()
      : 'Скасовано клієнтом через Instagram';

  if (appointment.crmRecordId && (await isCrmWriteEnabled())) {
    try {
      const provider = await resolveCrmProvider('booking');
      const crm = getCrmAdapter(provider);
      if (!crm.cancelBooking) {
        return {
          appointmentId: appointment.id,
          crmSynced: false,
          toolResult: `[cancel_appointment] failed: CRM ${provider} не підтримує скасування. request_handoff.`,
        };
      }
      await crm.cancelBooking(appointment.crmRecordId, 'cancel');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, conversationId, appointmentId: appointment.id }, 'cancel_appointment CRM failed');
      return {
        appointmentId: appointment.id,
        crmSynced: false,
        toolResult: `[cancel_appointment] failed: ${msg.slice(0, 400)}. Якщо оплачено або CRM відхилив — request_handoff.`,
      };
    }
  }

  await markLocalAppointmentCancelled(appointment.id);
  notifyBookingLifecycle({
    kind: 'cancelled',
    appointmentId: appointment.id,
    conversationId,
    clientIgUserId: options?.clientIgUserId ?? appointment.client.igUserId,
    summary: `${appointment.scheduledDate} ${appointment.scheduledTime}`,
    customerName: appointment.customerName,
    phone: appointment.phone,
    reason,
  }).catch(() => undefined);

  await sendClientLifecycleMessage(
    conversationId,
    options?.clientIgUserId ?? appointment.client.igUserId,
    `Запис на ${appointment.scheduledDate} о ${appointment.scheduledTime} скасовано. Якщо захочете записатись знову — напишіть, підберемо зручний час.`,
    options?.skipClientMessage,
  );

  return {
    appointmentId: appointment.id,
    crmSynced: true,
    toolResult: `[cancel_appointment] ok id=${appointment.id}`,
  };
}

export async function handleRemoveAppointmentService(
  conversationId: string,
  clientId: string,
  args: Record<string, unknown>,
  options?: BookAppointmentOptions,
): Promise<BookAppointmentResult | null> {
  const appointment = await findActiveBookingAppointment(conversationId);
  if (!appointment || appointment.clientId !== clientId) {
    return {
      appointmentId: '',
      crmSynced: false,
      toolResult:
        '[remove_appointment_service] failed: немає активного запису. Уточни або request_handoff.',
    };
  }

  const serviceId = asCrmId(args.service_id);
  const serviceName =
    typeof args.service_name === 'string' ? args.service_name.trim() : '';
  if (!serviceId && !serviceName) {
    return {
      appointmentId: appointment.id,
      crmSynced: false,
      toolResult: '[remove_appointment_service] failed: потрібен service_id або service_name.',
    };
  }

  const localServices = normalizeAppointmentServices(appointment.services);
  let targetLocal = serviceId
    ? localServices.find((s) => s.id === serviceId)
    : undefined;
  if (!targetLocal && serviceName) {
    const matches = localServices.filter((s) =>
      (s.name ?? '').toLowerCase().includes(serviceName.toLowerCase()),
    );
    if (matches.length === 1) targetLocal = matches[0];
  }
  if (!targetLocal && serviceId) {
    // Still try CRM match by catalog id even if local name differs.
    targetLocal = { id: serviceId, durationMin: 60, name: serviceName || undefined };
  }
  if (!targetLocal) {
    return {
      appointmentId: appointment.id,
      crmSynced: false,
      toolResult:
        '[remove_appointment_service] failed: послугу не знайдено у візиті. Уточни назву/id або request_handoff.',
    };
  }

  let cancelledVisit = false;
  let remainingLocal = localServices.filter((s) => s.id !== targetLocal!.id);

  if (appointment.crmRecordId && (await isCrmWriteEnabled())) {
    try {
      const provider = await resolveCrmProvider('booking');
      const crm = getCrmAdapter(provider);
      if (!crm.removeBookingService) {
        if (localServices.length <= 1 && crm.cancelBooking) {
          await crm.cancelBooking(appointment.crmRecordId, 'cancel');
          cancelledVisit = true;
          remainingLocal = [];
        } else {
          return {
            appointmentId: appointment.id,
            crmSynced: false,
            toolResult: `[remove_appointment_service] failed: CRM ${provider} не вміє знімати окрему послугу. Скасуйте весь запис (cancel_appointment) або request_handoff.`,
          };
        }
      } else {
        const result = await crm.removeBookingService({
          crmRecordId: appointment.crmRecordId,
          serviceCatalogId: targetLocal.id,
        });
        cancelledVisit = result.cancelledVisit;
        if (cancelledVisit) remainingLocal = [];
        else remainingLocal = localServices.filter((s) => s.id !== targetLocal!.id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err, conversationId, appointmentId: appointment.id },
        'remove_appointment_service CRM failed',
      );
      return {
        appointmentId: appointment.id,
        crmSynced: false,
        toolResult: `[remove_appointment_service] failed: ${msg.slice(0, 400)}. Якщо оплачено — request_handoff.`,
      };
    }
  } else if (remainingLocal.length === 0) {
    cancelledVisit = true;
  }

  if (cancelledVisit || remainingLocal.length === 0) {
    await markLocalAppointmentCancelled(appointment.id);
    notifyBookingLifecycle({
      kind: 'cancelled',
      appointmentId: appointment.id,
      conversationId,
      clientIgUserId: options?.clientIgUserId ?? appointment.client.igUserId,
      summary: `${appointment.scheduledDate} ${appointment.scheduledTime}`,
      customerName: appointment.customerName,
      phone: appointment.phone,
      reason: `Прибрано останню послугу: ${targetLocal.name ?? targetLocal.id}`,
    }).catch(() => undefined);
    await sendClientLifecycleMessage(
      conversationId,
      options?.clientIgUserId ?? appointment.client.igUserId,
      `Запис на ${appointment.scheduledDate} о ${appointment.scheduledTime} скасовано (не лишилось послуг).`,
      options?.skipClientMessage,
    );
    return {
      appointmentId: appointment.id,
      crmSynced: true,
      toolResult: `[remove_appointment_service] ok cancelled_visit id=${appointment.id}`,
    };
  }

  await prisma.appointment.update({
    where: { id: appointment.id },
    data: { services: toInputJsonValue(servicesToJson(remainingLocal))! },
  });
  const removedName = targetLocal.name ?? targetLocal.id;
  const marker = `appointmentId=${appointment.id}`;
  const order = await prisma.order.findFirst({
    where: { kind: 'booking', note: { contains: marker } },
    orderBy: { createdAt: 'desc' },
  });
  if (order) {
    const items = normalizeOrderItems(order.items, removedName).filter(
      (item) => item.name !== removedName && !item.name.includes(targetLocal!.id),
    );
    const nextItems =
      items.length > 0
        ? items
        : remainingLocal.map((s) => ({
            name: s.name || 'Послуга',
            price: Number(s.price) || 0,
            qty: 1,
          }));
    await prisma.order.update({
      where: { id: order.id },
      data: { items: toInputJsonValue(nextItems)! },
    });
  }

  notifyBookingLifecycle({
    kind: 'service_removed',
    appointmentId: appointment.id,
    conversationId,
    clientIgUserId: options?.clientIgUserId ?? appointment.client.igUserId,
    summary: `${appointment.scheduledDate} ${appointment.scheduledTime}`,
    customerName: appointment.customerName,
    phone: appointment.phone,
    reason: `Прибрано: ${removedName}`,
  }).catch(() => undefined);

  await sendClientLifecycleMessage(
    conversationId,
    options?.clientIgUserId ?? appointment.client.igUserId,
    `З запису на ${appointment.scheduledDate} о ${appointment.scheduledTime} прибрано: ${removedName}. Інші послуги лишаються.`,
    options?.skipClientMessage,
  );

  return {
    appointmentId: appointment.id,
    crmSynced: true,
    toolResult: `[remove_appointment_service] ok id=${appointment.id} removed=${targetLocal.id} remaining=${remainingLocal.length}`,
  };
}

function isPlausibleToolCrmId(id: string | null): boolean {
  if (!id) return false;
  return isCrmGuid(id) || isCrmNumericId(id) || isCrmGuidPrefix(id);
}

/** ok = every line is a CRM id; junk = none are (e.g. id "reschedule"); mixed = both. */
function classifyProvidedServiceIds(services: unknown): 'empty' | 'ok' | 'junk' | 'mixed' {
  if (!Array.isArray(services) || services.length === 0) return 'empty';
  let ok = 0;
  let bad = 0;
  for (const raw of services) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      bad++;
      continue;
    }
    const id = asCrmId((raw as Record<string, unknown>).id);
    if (isPlausibleToolCrmId(id)) ok++;
    else bad++;
  }
  if (bad === 0) return 'ok';
  if (ok === 0) return 'junk';
  return 'mixed';
}

export async function handleRescheduleAppointment(
  conversationId: string,
  clientId: string,
  args: Record<string, unknown>,
  options?: BookAppointmentOptions,
): Promise<BookAppointmentResult | null> {
  const appointment = await findActiveBookingAppointment(conversationId);
  if (!appointment || appointment.clientId !== clientId) {
    return {
      appointmentId: '',
      crmSynced: false,
      toolResult:
        '[reschedule_appointment] failed: немає активного запису для перенесення. Уточни або request_handoff.',
    };
  }

  const rawDate = typeof args.date === 'string' ? args.date.trim() : '';
  const time = typeof args.time === 'string' ? args.time.trim() : '';
  const date = normalizeToUaDate(rawDate);
  if (!parseAgentDate(date) || !time) {
    return {
      appointmentId: appointment.id,
      crmSynced: false,
      toolResult: '[reschedule_appointment] failed: потрібні date (ДД.ММ.РРРР) і time.',
    };
  }

  const providedQuality = classifyProvidedServiceIds(args.services);
  if (providedQuality === 'mixed') {
    return {
      appointmentId: appointment.id,
      crmSynced: false,
      toolResult:
        '[reschedule_appointment] failed INVALID_CRM_ID — services[].id має бути повний id CRM (UUID або число), не слово reschedule. Старий візит не скасовано.',
    };
  }
  const masterRaw = asCrmId(args.master_id);
  const safeMasterId = masterRaw && isPlausibleToolCrmId(masterRaw) ? masterRaw : undefined;

  if (appointment.crmRecordId && (await isCrmWriteEnabled())) {
    try {
      const provider = await resolveCrmProvider('booking');
      const crm = getCrmAdapter(provider);
      if (!crm.cancelBooking) {
        return {
          appointmentId: appointment.id,
          crmSynced: false,
          toolResult: `[reschedule_appointment] failed: CRM ${provider} не підтримує скасування старого візиту. request_handoff.`,
        };
      }
      await crm.cancelBooking(appointment.crmRecordId, 'move');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err, conversationId, appointmentId: appointment.id },
        'reschedule_appointment cancel-old CRM failed',
      );
      return {
        appointmentId: appointment.id,
        crmSynced: false,
        toolResult: `[reschedule_appointment] failed (cancel old): ${msg.slice(0, 400)}. request_handoff.`,
      };
    }
  }

  await markLocalAppointmentCancelled(appointment.id);

  const existingServices = normalizeAppointmentServices(appointment.services);
  const bookArgs: Record<string, unknown> = {
    customer_name:
      typeof args.customer_name === 'string' && args.customer_name.trim()
        ? args.customer_name.trim()
        : appointment.customerName,
    phone:
      typeof args.phone === 'string' && args.phone.trim()
        ? args.phone.trim()
        : appointment.phone,
    date,
    time,
    comment:
      typeof args.comment === 'string'
        ? args.comment
        : appointment.comment ?? undefined,
    master_id: safeMasterId,
    services: providedQuality === 'ok'
      ? args.services
      : existingServices.map((s) => ({
          id: s.id,
          name: s.name,
          price: s.price,
          duration_min: s.durationMin,
          master_id: s.masterId,
          start_time: s.startTime,
        })),
  };

  const bookResult = await handleBookAppointment(conversationId, clientId, bookArgs, {
    clientIgUserId: options?.clientIgUserId ?? appointment.client.igUserId,
    clientMessage: options?.clientMessage,
    skipClientMessage: options?.skipClientMessage,
  });

  if (!bookResult) {
    return {
      appointmentId: appointment.id,
      crmSynced: false,
      toolResult:
        '[reschedule_appointment] failed: старий візит скасовано, але новий не створено (перевір поля). request_handoff.',
    };
  }

  if (!bookResult.crmSynced) {
    return {
      appointmentId: bookResult.appointmentId || appointment.id,
      crmSynced: false,
      toolResult: bookResult.toolResult.replace(
        '[book_appointment]',
        '[reschedule_appointment]',
      ),
    };
  }

  notifyBookingLifecycle({
    kind: 'rescheduled',
    appointmentId: bookResult.appointmentId,
    conversationId,
    clientIgUserId: options?.clientIgUserId ?? appointment.client.igUserId,
    summary: `${appointment.scheduledDate} ${appointment.scheduledTime} → ${date} ${time}`,
    customerName: String(bookArgs.customer_name),
    phone: String(bookArgs.phone),
    reason: typeof args.reason === 'string' ? args.reason : undefined,
  }).catch(() => undefined);

  return {
    appointmentId: bookResult.appointmentId,
    crmSynced: true,
    toolResult: `[reschedule_appointment] ok id=${bookResult.appointmentId} from=${appointment.id}`,
  };
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
