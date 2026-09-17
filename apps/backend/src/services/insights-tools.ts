/**
 * Owner Insights (AI-помічник) tools — read dialogs/clients; writes require confirm:true.
 */
import pino from 'pino';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';
import { isCrmWriteReady } from '../lib/crm-write.js';
import type { ToolDefinition } from '../lib/claude-runtime.js';
import { linkClientToCrm } from './client-crm-link.js';
import { mirrorClientToCrm } from './crm-sync.js';
import { createAdminProductOrder } from './order-admin.js';
import { OrderCrmRetryError, retryOrderCrmSync } from './order-crm-retry.js';

const log = pino({ name: 'insights-tools' });

export const INSIGHTS_MAX_TOOL_ROUNDS = 6;
const MESSAGE_CAP = 80;

export type InsightsToolCall = { name: string; args: Record<string, unknown> };

function asString(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

/** Extract conversation UUID from bare id or admin URL path. */
export function parseConversationId(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const fromPath = s.match(
    /\/conversations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (fromPath?.[1]) return fromPath[1].toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    return s.toLowerCase();
  }
  return null;
}

const paymentEnum = z.enum(['card', 'transfer', 'cod']);

const orderItemSchema = z.object({
  name: z.string().min(1),
  variant: z.string().optional(),
  price: z.number(),
  qty: z.number().positive().optional(),
});

const productOrderDraftSchema = z.object({
  conversation_id: z.string().min(1),
  items: z.array(orderItemSchema).min(1),
  customer_name: z.string().min(1),
  phone: z.string().min(1),
  city: z.string().min(1),
  np_branch: z.string().min(1),
  payment_method: paymentEnum.optional(),
  note: z.string().optional(),
  force: z.boolean().optional(),
  mirror_crm: z.boolean().optional(),
  notify_telegram: z.boolean().optional(),
  confirm: z.boolean().optional(),
});

const clientUpdateSchema = z.object({
  client_id: z.string().uuid().optional(),
  conversation_id: z.string().optional(),
  display_name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  delivery_city: z.string().optional(),
  delivery_np_branch: z.string().optional(),
  delivery_np_type: z.string().optional(),
  notes: z.string().optional(),
  confirm: z.boolean().optional(),
});

export function buildInsightsToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'get_conversation',
      description:
        'Load a full customer conversation by UUID or admin URL (/conversations/{uuid}). Returns client, messages (last 80), and existing orders.',
      parameters: {
        type: 'object',
        properties: {
          conversation_id: {
            type: 'string',
            description: 'Conversation UUID or full admin path/URL containing it',
          },
        },
        required: ['conversation_id'],
      },
    },
    {
      name: 'search_conversations',
      description: 'Search conversations by client name, @username, phone fragment, or conversation id prefix.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text' },
          limit: { type: 'number', description: 'Max results (default 10, max 20)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_client',
      description: 'Load a client profile by client_id or conversation_id.',
      parameters: {
        type: 'object',
        properties: {
          client_id: { type: 'string' },
          conversation_id: { type: 'string' },
        },
      },
    },
    {
      name: 'propose_product_order',
      description:
        'Validate a product order draft from conversation data. Does NOT write to DB. Returns missing fields and a summary for owner confirmation.',
      parameters: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                variant: { type: 'string' },
                price: { type: 'number' },
                qty: { type: 'number' },
              },
              required: ['name', 'price'],
            },
          },
          customer_name: { type: 'string' },
          phone: { type: 'string' },
          city: { type: 'string' },
          np_branch: { type: 'string' },
          payment_method: { type: 'string', enum: ['card', 'transfer', 'cod'] },
          note: { type: 'string' },
        },
        required: ['conversation_id', 'items', 'customer_name', 'phone', 'city', 'np_branch'],
      },
    },
    {
      name: 'create_product_order',
      description:
        'Create local product order (+ optional KeyCRM mirror). REQUIRES confirm=true after owner explicitly confirms the draft in chat. Never messages the Instagram client.',
      parameters: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                variant: { type: 'string' },
                price: { type: 'number' },
                qty: { type: 'number' },
              },
              required: ['name', 'price'],
            },
          },
          customer_name: { type: 'string' },
          phone: { type: 'string' },
          city: { type: 'string' },
          np_branch: { type: 'string' },
          payment_method: { type: 'string', enum: ['card', 'transfer', 'cod'] },
          note: { type: 'string' },
          force: { type: 'boolean', description: 'Allow second product order on same dialog' },
          mirror_crm: { type: 'boolean', description: 'Default true when CRM write ready' },
          notify_telegram: { type: 'boolean', description: 'Default true' },
          confirm: { type: 'boolean', description: 'Must be true to execute' },
        },
        required: [
          'conversation_id',
          'items',
          'customer_name',
          'phone',
          'city',
          'np_branch',
          'confirm',
        ],
      },
    },
    {
      name: 'propose_client_update',
      description: 'Validate a client profile update draft. Does NOT write.',
      parameters: {
        type: 'object',
        properties: {
          client_id: { type: 'string' },
          conversation_id: { type: 'string' },
          display_name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          delivery_city: { type: 'string' },
          delivery_np_branch: { type: 'string' },
          delivery_np_type: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
    {
      name: 'update_client',
      description:
        'Update local Client fields. REQUIRES confirm=true after owner confirms. May link CRM by phone when write/link available.',
      parameters: {
        type: 'object',
        properties: {
          client_id: { type: 'string' },
          conversation_id: { type: 'string' },
          display_name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          delivery_city: { type: 'string' },
          delivery_np_branch: { type: 'string' },
          delivery_np_type: { type: 'string' },
          notes: { type: 'string' },
          confirm: { type: 'boolean' },
        },
        required: ['confirm'],
      },
    },
    {
      name: 'get_crm_write_status',
      description: 'Fresh CRM write readiness for product orders (KeyCRM / routing).',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'retry_order_crm_sync',
      description: 'Retry CRM mirror for an existing order. REQUIRES confirm=true.',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string' },
          confirm: { type: 'boolean' },
        },
        required: ['order_id', 'confirm'],
      },
    },
  ];
}

function missingOrderFields(draft: {
  customer_name?: string;
  phone?: string;
  city?: string;
  np_branch?: string;
  payment_method?: string;
  items?: unknown;
}): string[] {
  const missing: string[] = [];
  if (!asString(draft.customer_name)) missing.push('customer_name');
  if (!asString(draft.phone)) missing.push('phone');
  if (!asString(draft.city)) missing.push('city');
  if (!asString(draft.np_branch)) missing.push('np_branch');
  if (!draft.payment_method) missing.push('payment_method (optional but recommended)');
  if (!Array.isArray(draft.items) || draft.items.length === 0) missing.push('items');
  return missing;
}

async function resolveClientId(args: {
  client_id?: string;
  conversation_id?: string;
}): Promise<{ clientId: string } | { error: string }> {
  const clientId = asString(args.client_id);
  if (clientId) return { clientId };
  const convId = parseConversationId(args.conversation_id);
  if (!convId) return { error: 'Потрібен client_id або conversation_id' };
  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    select: { clientId: true },
  });
  if (!conv) return { error: 'Діалог не знайдено' };
  return { clientId: conv.clientId };
}

export async function executeInsightsToolCall(
  tc: InsightsToolCall,
  ctx?: { ownerUserId?: string },
): Promise<string> {
  const name = tc.name;
  try {
    switch (name) {
      case 'get_conversation': {
        const id = parseConversationId(tc.args.conversation_id ?? tc.args.conversationId);
        if (!id) return '[get_conversation] ПОМИЛКА: некоректний conversation_id / URL';
        const conversation = await prisma.conversation.findUnique({
          where: { id },
          include: {
            client: true,
            messages: { orderBy: { createdAt: 'asc' } },
            orders: {
              where: { isArchived: false },
              orderBy: { createdAt: 'desc' },
              take: 10,
            },
          },
        });
        if (!conversation) return '[get_conversation] ПОМИЛКА: діалог не знайдено';
        const msgs = conversation.messages.slice(-MESSAGE_CAP);
        log.info(
          { conversationId: id, ownerUserId: ctx?.ownerUserId, messageCount: msgs.length },
          'insights get_conversation',
        );
        const payload = {
          id: conversation.id,
          path: `/conversations/${conversation.id}`,
          state: conversation.state,
          channel: conversation.channel,
          intent: conversation.intent,
          handoffReason: conversation.handoffReason,
          client: {
            id: conversation.client.id,
            displayName: conversation.client.displayName,
            igUsername: conversation.client.igUsername,
            igFullName: conversation.client.igFullName,
            phone: conversation.client.phone,
            email: conversation.client.email,
            deliveryCity: conversation.client.deliveryCity,
            deliveryNpBranch: conversation.client.deliveryNpBranch,
            deliveryNpType: conversation.client.deliveryNpType,
            notes: conversation.client.notes,
            tags: conversation.client.tags,
            crmBuyerId: conversation.client.crmBuyerId,
            crmProvider: conversation.client.crmProvider,
          },
          messages: msgs.map((m) => ({
            id: m.id,
            direction: m.direction,
            sender: m.sender,
            text: m.text,
            createdAt: m.createdAt.toISOString(),
            hasMedia: Boolean(
              (Array.isArray(m.mediaUrls) && m.mediaUrls.length > 0) ||
                (m.mediaAttachments != null),
            ),
          })),
          orders: conversation.orders.map((o) => ({
            id: o.id,
            kind: o.kind,
            status: o.status,
            customerName: o.customerName,
            phone: o.phone,
            city: o.city,
            npBranch: o.npBranch,
            paymentMethod: o.paymentMethod,
            items: o.items,
            crmSyncStatus: o.crmSyncStatus,
            keycrmOrderId: o.keycrmOrderId,
            crmSyncError: o.crmSyncError,
            createdAt: o.createdAt.toISOString(),
          })),
          messageTotal: conversation.messages.length,
          messagesReturned: msgs.length,
        };
        return `[get_conversation] РЕЗУЛЬТАТ:\n${JSON.stringify(payload, null, 2)}`;
      }

      case 'search_conversations': {
        const query = asString(tc.args.query);
        if (!query) return '[search_conversations] ПОМИЛКА: порожній query';
        const limit = Math.min(20, Math.max(1, Number(tc.args.limit) || 10));
        const uuid = parseConversationId(query);
        const where: Prisma.ConversationWhereInput = uuid
          ? { id: uuid }
          : {
              OR: [
                { client: { displayName: { contains: query, mode: 'insensitive' } } },
                {
                  client: {
                    igUsername: { contains: query.replace(/^@/, ''), mode: 'insensitive' },
                  },
                },
                { client: { igFullName: { contains: query, mode: 'insensitive' } } },
                { client: { phone: { contains: query.replace(/\s+/g, '') } } },
              ],
            };
        const rows = await prisma.conversation.findMany({
          where,
          orderBy: { lastMessageAt: 'desc' },
          take: limit,
          select: {
            id: true,
            state: true,
            lastMessageAt: true,
            client: {
              select: {
                displayName: true,
                igUsername: true,
                phone: true,
              },
            },
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { text: true, sender: true },
            },
          },
        });
        const payload = rows.map((r) => ({
          id: r.id,
          path: `/conversations/${r.id}`,
          state: r.state,
          lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
          client: r.client,
          lastMessagePreview: r.messages[0]?.text?.slice(0, 160) ?? null,
          lastSender: r.messages[0]?.sender ?? null,
        }));
        return `[search_conversations] Знайдено ${payload.length}:\n${JSON.stringify(payload, null, 2)}`;
      }

      case 'get_client': {
        const resolved = await resolveClientId({
          client_id: asString(tc.args.client_id) || undefined,
          conversation_id: asString(tc.args.conversation_id) || undefined,
        });
        if ('error' in resolved) return `[get_client] ПОМИЛКА: ${resolved.error}`;
        const client = await prisma.client.findUnique({ where: { id: resolved.clientId } });
        if (!client) return '[get_client] ПОМИЛКА: клієнт не знайдено';
        return `[get_client] РЕЗУЛЬТАТ:\n${JSON.stringify(client, null, 2)}`;
      }

      case 'propose_product_order': {
        const parsed = productOrderDraftSchema.omit({ confirm: true }).safeParse({
          ...tc.args,
          conversation_id:
            parseConversationId(tc.args.conversation_id) ?? asString(tc.args.conversation_id),
        });
        if (!parsed.success) {
          return `[propose_product_order] ПОМИЛКА валідації: ${parsed.error.message}`;
        }
        const conv = await prisma.conversation.findUnique({
          where: { id: parsed.data.conversation_id },
          select: { id: true, state: true },
        });
        if (!conv) return '[propose_product_order] ПОМИЛКА: діалог не знайдено';
        const missing = missingOrderFields(parsed.data);
        const write = await isCrmWriteReady('order');
        const existing = await prisma.order.findFirst({
          where: {
            conversationId: conv.id,
            isArchived: false,
            status: { notIn: ['draft', 'cancelled'] },
            kind: 'product',
          },
          select: { id: true, crmSyncStatus: true, keycrmOrderId: true },
        });
        return `[propose_product_order] ЧЕРНЕТКА (не записано):\n${JSON.stringify(
          {
            draft: parsed.data,
            conversationState: conv.state,
            path: `/conversations/${conv.id}`,
            missingFields: missing.filter((m) => !m.includes('optional')),
            readyToCreate: missing.filter((m) => !m.includes('optional')).length === 0,
            existingProductOrder: existing,
            crmWriteReady: write.ready,
            crmWriteIssue: write.ready ? null : write.reason,
            nextStep:
              'Покажи чернетку власнику. Після явного «підтверджую» виклич create_product_order з confirm=true.',
          },
          null,
          2,
        )}`;
      }

      case 'create_product_order': {
        if (!asBool(tc.args.confirm)) {
          return (
            '[create_product_order] ВІДМОВА: потрібен confirm=true після явного підтвердження власника в чаті. ' +
            'Спочатку propose_product_order і дочекайся «підтверджую».'
          );
        }
        const parsed = productOrderDraftSchema.safeParse({
          ...tc.args,
          conversation_id:
            parseConversationId(tc.args.conversation_id) ?? asString(tc.args.conversation_id),
          confirm: true,
        });
        if (!parsed.success) {
          return `[create_product_order] ПОМИЛКА валідації: ${parsed.error.message}`;
        }
        const d = parsed.data;
        const result = await createAdminProductOrder({
          conversationId: d.conversation_id,
          items: d.items,
          customerName: d.customer_name,
          phone: d.phone,
          city: d.city,
          npBranch: d.np_branch,
          paymentMethod: d.payment_method,
          note: d.note,
          force: d.force === true,
          mirrorCrm: d.mirror_crm,
          notifyTelegram: d.notify_telegram,
        });
        log.info(
          { ownerUserId: ctx?.ownerUserId, result },
          'insights create_product_order',
        );
        if (!result.ok) {
          return `[create_product_order] ПОМИЛКА (${result.code}): ${result.error}`;
        }
        return `[create_product_order] СТВОРЕНО:\n${JSON.stringify(
          {
            ...result,
            ordersPath: '/orders',
            dialogLink: `[Відкрити діалог](${result.path})`,
          },
          null,
          2,
        )}`;
      }

      case 'propose_client_update': {
        const parsed = clientUpdateSchema.omit({ confirm: true }).safeParse(tc.args);
        if (!parsed.success) {
          return `[propose_client_update] ПОМИЛКА валідації: ${parsed.error.message}`;
        }
        const resolved = await resolveClientId({
          client_id: parsed.data.client_id,
          conversation_id: parsed.data.conversation_id,
        });
        if ('error' in resolved) return `[propose_client_update] ПОМИЛКА: ${resolved.error}`;
        const client = await prisma.client.findUnique({ where: { id: resolved.clientId } });
        if (!client) return '[propose_client_update] ПОМИЛКА: клієнт не знайдено';
        const patch = {
          displayName: parsed.data.display_name,
          phone: parsed.data.phone,
          email: parsed.data.email,
          deliveryCity: parsed.data.delivery_city,
          deliveryNpBranch: parsed.data.delivery_np_branch,
          deliveryNpType: parsed.data.delivery_np_type,
          notes: parsed.data.notes,
        };
        const fields = Object.entries(patch).filter(([, v]) => v !== undefined && asString(v) !== '');
        if (fields.length === 0) {
          return '[propose_client_update] ПОМИЛКА: немає полів для оновлення';
        }
        return `[propose_client_update] ЧЕРНЕТКА:\n${JSON.stringify(
          {
            clientId: client.id,
            before: {
              displayName: client.displayName,
              phone: client.phone,
              email: client.email,
              deliveryCity: client.deliveryCity,
              deliveryNpBranch: client.deliveryNpBranch,
            },
            patch: Object.fromEntries(fields),
            nextStep: 'Після «підтверджую» виклич update_client з confirm=true.',
          },
          null,
          2,
        )}`;
      }

      case 'update_client': {
        if (!asBool(tc.args.confirm)) {
          return (
            '[update_client] ВІДМОВА: потрібен confirm=true після явного підтвердження власника. ' +
            'Спочатку propose_client_update.'
          );
        }
        const parsed = clientUpdateSchema.safeParse({ ...tc.args, confirm: true });
        if (!parsed.success) {
          return `[update_client] ПОМИЛКА валідації: ${parsed.error.message}`;
        }
        const resolved = await resolveClientId({
          client_id: parsed.data.client_id,
          conversation_id: parsed.data.conversation_id,
        });
        if ('error' in resolved) return `[update_client] ПОМИЛКА: ${resolved.error}`;

        const data: Record<string, string | null> = {};
        if (parsed.data.display_name !== undefined) {
          data.displayName = asString(parsed.data.display_name) || null;
        }
        if (parsed.data.phone !== undefined) {
          data.phone = asString(parsed.data.phone) || null;
        }
        if (parsed.data.email !== undefined) {
          data.email = asString(parsed.data.email) || null;
        }
        if (parsed.data.delivery_city !== undefined) {
          data.deliveryCity = asString(parsed.data.delivery_city) || null;
        }
        if (parsed.data.delivery_np_branch !== undefined) {
          data.deliveryNpBranch = asString(parsed.data.delivery_np_branch) || null;
        }
        if (parsed.data.delivery_np_type !== undefined) {
          data.deliveryNpType = asString(parsed.data.delivery_np_type) || null;
        }
        if (parsed.data.notes !== undefined) {
          data.notes = asString(parsed.data.notes) || null;
        }
        if (Object.keys(data).length === 0) {
          return '[update_client] ПОМИЛКА: немає полів для оновлення';
        }

        const before = await prisma.client.findUnique({
          where: { id: resolved.clientId },
          select: { phone: true },
        });
        const client = await prisma.client.update({
          where: { id: resolved.clientId },
          data,
        });

        const phoneChanged =
          typeof data.phone === 'string' && data.phone && data.phone !== before?.phone;
        if (phoneChanged || (client.phone && !client.crmBuyerId)) {
          await linkClientToCrm(client.id, { upsert: false }).catch(() => undefined);
        }
        await mirrorClientToCrm(client.id).catch((err) => {
          log.warn({ err, clientId: client.id }, 'insights mirrorClientToCrm failed');
        });

        const refreshed = await prisma.client.findUnique({ where: { id: client.id } });
        log.info(
          { ownerUserId: ctx?.ownerUserId, clientId: client.id },
          'insights update_client',
        );
        return `[update_client] ОНОВЛЕНО:\n${JSON.stringify(refreshed, null, 2)}`;
      }

      case 'get_crm_write_status': {
        const write = await isCrmWriteReady('order');
        return `[get_crm_write_status] РЕЗУЛЬТАТ:\n${JSON.stringify(write, null, 2)}`;
      }

      case 'retry_order_crm_sync': {
        if (!asBool(tc.args.confirm)) {
          return '[retry_order_crm_sync] ВІДМОВА: потрібен confirm=true';
        }
        const orderId = asString(tc.args.order_id ?? tc.args.orderId);
        if (!orderId) return '[retry_order_crm_sync] ПОМИЛКА: потрібен order_id';
        try {
          const result = await retryOrderCrmSync(orderId);
          return `[retry_order_crm_sync] ОК:\n${JSON.stringify(result, null, 2)}`;
        } catch (err) {
          if (err instanceof OrderCrmRetryError) {
            return `[retry_order_crm_sync] ПОМИЛКА (${err.statusCode}): ${err.message}`;
          }
          throw err;
        }
      }

      default:
        return `[${name}] ПОМИЛКА: невідомий tool`;
    }
  } catch (err) {
    log.error({ err, name, args: tc.args }, 'insights tool failed');
    return `[${name}] ПОМИЛКА: внутрішня помилка виконання`;
  }
}

export function pickInsightsToolCall(
  toolCalls: InsightsToolCall[],
): InsightsToolCall | null {
  if (!toolCalls.length) return null;
  // Prefer writes last only if mixed — execute first listed (Claude usually one).
  return toolCalls[0] ?? null;
}
