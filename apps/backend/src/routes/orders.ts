import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { computeOrderTotal } from '../lib/order-totals.js';
import { buildKeycrmOrderUrl, resolveKeycrmAppUrl } from '../lib/keycrm-urls.js';
import { parseAppointmentIdFromOrderNote } from '../lib/order-appointment.js';
import { normalizeAppointmentServices } from '../lib/appointment-services.js';
import { buildOrderCrmView, type OrderCrmAppointment } from '../lib/order-crm-view.js';
import { crmRetrySuccessMessage, OrderCrmRetryError, retryOrderCrmSync } from '../services/order-crm-retry.js';
import {
  AppointmentUpdateError,
  listBookingMasters,
  updateAppointmentServiceMasters,
} from '../services/appointment.js';

type OrderRow = {
  id: string;
  conversationId: string;
  clientId: string;
  kind?: string;
  items: unknown;
  customerName: string;
  phone: string;
  city: string | null;
  npBranch: string | null;
  paymentMethod: string | null;
  note: string | null;
  status: string;
  submittedToManagerAt: Date | null;
  keycrmOrderId: string | null;
  crmSyncStatus: string;
  crmSyncError: string | null;
  crmSyncedAt: Date | null;
  isArchived: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  client?: { id: string; igUserId: string | null; displayName: string | null } | null;
  conversation?: { id: string } | null;
};

type AppointmentForOrder = OrderCrmAppointment & { services?: unknown };

function serializeOrder(
  order: OrderRow,
  keycrmAppUrl: string | null,
  appointment?: AppointmentForOrder | null,
) {
  const crm = buildOrderCrmView(order, appointment);
  const keycrmUrl =
    crm.crmProvider === 'keycrm' && order.keycrmOrderId
      ? buildKeycrmOrderUrl(order.keycrmOrderId, keycrmAppUrl)
      : null;

  return {
    ...order,
    kind: order.kind ?? 'product',
    total: computeOrderTotal(order.items),
    keycrmOrderId: order.keycrmOrderId,
    keycrmOrderUrl: keycrmUrl,
    crmSyncStatus: crm.crmSyncStatus,
    crmSyncError: crm.crmSyncError,
    crmSyncedAt: crm.crmSyncedAt,
    crmProvider: crm.crmProvider,
    crmProviderLabel: crm.crmProviderLabel,
    crmRecordId: crm.crmRecordId,
    appointmentId: crm.appointmentId,
    appointmentServices:
      crm.kind === 'booking' && appointment
        ? normalizeAppointmentServices(appointment.services)
        : undefined,
    canRetryCrm: crm.canRetryCrm,
    client: order.client?.displayName
      ?? (order.client?.igUserId ? `IG ${order.client.igUserId.slice(-6)}` : '—'),
    clientId: order.client?.id ?? order.clientId,
    conversationId: order.conversation?.id ?? order.conversationId,
  };
}

async function loadAppointmentsForOrders(
  rows: Array<{ kind?: string | null; note: string | null }>,
): Promise<Map<string, AppointmentForOrder>> {
  const ids = [...new Set(
    rows
      .filter((row) => (row.kind ?? 'product') === 'booking')
      .map((row) => parseAppointmentIdFromOrderNote(row.note))
      .filter((id): id is string => Boolean(id)),
  )];
  if (ids.length === 0) return new Map();

  const appointments = await prisma.appointment.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      crmProvider: true,
      crmRecordId: true,
      crmSyncStatus: true,
      crmSyncError: true,
      crmSyncedAt: true,
      status: true,
      services: true,
    },
  });
  return new Map(appointments.map((row) => [row.id, row]));
}

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  // GET / - List orders
  app.get<{
    Querystring: {
      status?: string;
      page?: string;
      limit?: string;
      includeArchived?: string;
    };
  }>('/', { onRequest: [app.authenticate] }, async (request) => {
    const status = request.query.status;
    const includeArchived = request.query.includeArchived === 'true';
    const page = Math.max(1, parseInt(request.query.page ?? '1', 10));
    const limit = Math.max(1, Math.min(100, parseInt(request.query.limit ?? '20', 10)));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};

    if (!includeArchived) {
      where.isArchived = false;
    }

    if (status) {
      where.status = status;
    }

    const [rows, total, keycrmAppUrl] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          client: { select: { id: true, igUserId: true, displayName: true } },
          conversation: { select: { id: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.order.count({ where }),
      resolveKeycrmAppUrl(),
    ]);

    const appointments = await loadAppointmentsForOrders(rows);

    return {
      data: rows.map((row) => {
        const appointmentId = parseAppointmentIdFromOrderNote(row.note);
        return serializeOrder(
          row,
          keycrmAppUrl,
          appointmentId ? appointments.get(appointmentId) ?? null : null,
        );
      }),
      total,
      page,
      limit,
    };
  });

  app.get('/booking-masters', { onRequest: [app.authenticate] }, async () => {
    const data = await listBookingMasters();
    return { data };
  });

  // GET /:id - Get single order detail
  app.get<{
    Params: { id: string };
  }>('/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const order = await prisma.order.findUnique({
      where: { id: request.params.id },
      include: {
        client: true,
        conversation: true,
      },
    });

    if (!order) {
      return reply.code(404).send({ error: 'Order not found' });
    }

    const [keycrmAppUrl, appointments] = await Promise.all([
      resolveKeycrmAppUrl(),
      loadAppointmentsForOrders([order]),
    ]);
    const appointmentId = parseAppointmentIdFromOrderNote(order.note);
    return serializeOrder(
      order,
      keycrmAppUrl,
      appointmentId ? appointments.get(appointmentId) ?? null : null,
    );
  });

  // POST /:id/sync-crm - Manual CRM mirror retry (product → KeyCRM, booking → Appointment CRM)
  const syncCrmBodySchema = z.object({
    /** BeautyPro: POST /appointments?force=true — admin override for TIME_CONFLICT. */
    forceTimeConflict: z.boolean().optional(),
  });

  app.post<{
    Params: { id: string };
  }>('/:id/sync-crm', { onRequest: [app.authenticate] }, async (request, reply) => {
    const bodyParsed = syncCrmBodySchema.safeParse(request.body ?? {});
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: 'Некоректне тіло запиту' });
    }
    try {
      const result = await retryOrderCrmSync(request.params.id, {
        forceTimeConflict: bodyParsed.data.forceTimeConflict === true,
      });
      return {
        ...result,
        message: crmRetrySuccessMessage(result),
        keycrmOrderId: result.kind === 'booking' ? null : result.crmRecordId,
      };
    } catch (err) {
      if (err instanceof OrderCrmRetryError) {
        return reply.code(err.statusCode).send({
          error: err.message,
          ...err.extra,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: message });
    }
  });

  const bookingServicesPatchSchema = z.object({
    services: z
      .array(
        z.object({
          index: z.number().int().nonnegative().optional(),
          serviceId: z.string().min(1).optional(),
          masterId: z.string().min(1),
        }),
      )
      .min(1),
    force: z.boolean().optional(),
  });

  app.patch<{
    Params: { id: string };
  }>('/:id/booking-services', { onRequest: [app.authenticate] }, async (request, reply) => {
    const parsed = bookingServicesPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Некоректне призначення майстрів' });
    }

    const order = await prisma.order.findUnique({
      where: { id: request.params.id },
      select: { id: true, kind: true, note: true, status: true },
    });
    if (!order) {
      return reply.code(404).send({ error: 'Order not found' });
    }
    if (order.kind !== 'booking') {
      return reply.code(400).send({ error: 'Майстрів призначають лише для запису' });
    }
    if (order.status === 'cancelled') {
      return reply.code(400).send({ error: 'Скасоване замовлення не змінюється' });
    }
    const appointmentId = parseAppointmentIdFromOrderNote(order.note);
    if (!appointmentId) {
      return reply.code(400).send({ error: 'Немає повʼязаного запису (appointmentId)' });
    }

    try {
      const updated = await updateAppointmentServiceMasters({
        appointmentId,
        assignments: parsed.data.services,
        force: parsed.data.force,
      });
      return { ok: true, appointmentId, services: updated.services };
    } catch (err) {
      if (err instanceof AppointmentUpdateError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: message });
    }
  });
}
