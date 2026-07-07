/**
 * Salon appointment persistence + CRM mirror (CleverBOX slots/save).
 */

import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import { isCrmWriteEnabled } from '../lib/crm-write.js';
import { resolveCrmProvider } from '../lib/crm-routing.js';
import { getCrmAdapter } from './crm/index.js';
import { getBranchById } from './branches.js';
import { notifyCrmFallback } from './telegram-notify.js';

const log = pino({ name: 'appointment' });

export async function handleBookAppointment(
  conversationId: string,
  clientId: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const customerName =
    typeof args.customer_name === 'string' ? args.customer_name.trim() : '';
  const phone = typeof args.phone === 'string' ? args.phone.trim() : '';
  const date = typeof args.date === 'string' ? args.date.trim() : '';
  const time = typeof args.time === 'string' ? args.time.trim() : '';
  const comment = typeof args.comment === 'string' ? args.comment.trim() : undefined;
  const masterId =
    typeof args.master_id === 'number'
      ? args.master_id
      : typeof args.master_id === 'string'
        ? Number(args.master_id)
        : undefined;

  const rawServices = Array.isArray(args.services) ? args.services : [];
  const services = rawServices.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === 'number' ? o.id : Number(o.id);
    const durationMin =
      typeof o.duration_min === 'number'
        ? o.duration_min
        : typeof o.long === 'number'
          ? o.long
          : 60;
    const name = typeof o.name === 'string' ? o.name : `Послуга #${id}`;
    const price = typeof o.price === 'number' ? o.price : 0;
    if (!Number.isFinite(id) || id <= 0) return [];
    return [{ id, durationMin, name, price, masterId: masterId && Number.isFinite(masterId) ? masterId : undefined }];
  });

  if (!customerName || !phone || !date || !time || services.length === 0) {
    log.warn({ conversationId }, 'book_appointment missing required fields');
    return null;
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { branchId: true },
  });

  const branch = conversation?.branchId
    ? await getBranchById(conversation.branchId)
    : null;

  if (!branch?.crmExternalId) {
    log.warn({ conversationId, branchId: conversation?.branchId }, 'book_appointment: branch without CRM id');
    return null;
  }

  const crmProvider = await resolveCrmProvider('booking', {
    toolProvider:
      typeof args.crm_provider === 'string' ? args.crm_provider : undefined,
  });

  const appointment = await prisma.appointment.create({
    data: {
      conversationId,
      clientId,
      branchId: branch.id,
      services,
      scheduledDate: date,
      scheduledTime: time,
      customerName,
      phone,
      comment,
      status: 'confirmed',
      crmProvider,
      crmSyncStatus: 'pending',
    },
  });

  mirrorAppointmentToCrm(appointment.id).catch((err) => {
    log.error({ err, appointmentId: appointment.id }, 'Appointment CRM mirror failed');
  });

  return appointment.id;
}

export async function mirrorAppointmentToCrm(appointmentId: string): Promise<void> {
  if (!(await isCrmWriteEnabled())) return;

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
    return;
  }

  const provider = await resolveCrmProvider('booking');
  const crm = getCrmAdapter(provider);

  if (!crm.createBooking) {
    log.debug({ provider: crm.name }, 'CRM has no booking API — skipping');
    return;
  }

  const branchCrmId = Number(appointment.branch?.crmExternalId);
  if (!Number.isFinite(branchCrmId)) {
    throw new Error('Branch CRM external id missing');
  }

  const rawServices = Array.isArray(appointment.services) ? appointment.services : [];
  const services = rawServices.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === 'number' ? o.id : Number(o.id);
    const durationMin = typeof o.durationMin === 'number' ? o.durationMin : 60;
    const masterId = typeof o.masterId === 'number' ? o.masterId : undefined;
    if (!Number.isFinite(id)) return [];
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

  try {
    const result = await crm.createBooking({
      date: appointment.scheduledDate,
      branchId: branchCrmId,
      clientName: appointment.customerName,
      phone: appointment.phone,
      comment: [appointment.comment, photoNote].filter(Boolean).join('\n') || undefined,
      services,
    });

    await prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        crmRecordId: result.crmRecordId,
        crmSyncStatus: 'synced',
        crmSyncError: null,
        crmSyncedAt: new Date(),
        status: 'synced',
      },
    });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { crmSyncStatus: 'failed', crmSyncError: errMessage.slice(0, 500), status: 'failed' },
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
