import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  defaultOnMatchForKind,
  eventVisibleForAgent,
  formatEventToolResult,
  formatMatchedEventHint,
  formatTenantEventsForPrompt,
  matchEventsByQuery,
  resolveEventLifecycle,
  summaryFromDetails,
  type TenantEventFields,
  type TenantEventKind,
  type TenantEventLifecycle,
  type TenantEventOnMatch,
  type TenantEventStatus,
} from '../lib/tenant-events.js';

const kindSchema = z.enum(['casting', 'promo', 'hiring', 'collab', 'other']);
const statusSchema = z.enum(['draft', 'active', 'paused', 'archived']);
const onMatchSchema = z.enum(['inform', 'handoff', 'continue_funnel']);

function optionalDate(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export const tenantEventInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  kind: kindSchema,
  status: statusSchema.optional(),
  eventStartsAt: z.union([z.string(), z.null()]).optional(),
  eventEndsAt: z.union([z.string(), z.null()]).optional(),
  openFrom: z.union([z.string(), z.null()]).optional(),
  openUntil: z.union([z.string(), z.null()]).optional(),
  summary: z.string().trim().max(500).optional(),
  details: z.string().trim().min(1).max(8000),
  keywords: z.array(z.string().trim().min(1).max(64)).max(40).optional(),
  agentInstructions: z.string().trim().max(4000).optional(),
  onMatch: onMatchSchema.optional(),
  handoffReason: z.union([z.string().trim().max(500), z.null()]).optional(),
  closedReplyHint: z.union([z.string().trim().max(500), z.null()]).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
});

export const tenantEventUpdateSchema = tenantEventInputSchema.partial().extend({
  title: z.string().trim().min(1).max(200).optional(),
  details: z.string().trim().min(1).max(8000).optional(),
  kind: kindSchema.optional(),
});

export type TenantEventInput = z.infer<typeof tenantEventInputSchema>;
export type TenantEventUpdate = z.infer<typeof tenantEventUpdateSchema>;

function toFields(row: {
  id: string;
  title: string;
  kind: TenantEventKind;
  status: TenantEventStatus;
  eventStartsAt: Date | null;
  eventEndsAt: Date | null;
  openFrom: Date | null;
  openUntil: Date | null;
  summary: string;
  details: string;
  keywords: string[];
  agentInstructions: string;
  onMatch: TenantEventOnMatch;
  handoffReason: string | null;
  closedReplyHint: string | null;
  priority: number;
}): TenantEventFields {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    status: row.status,
    eventStartsAt: row.eventStartsAt,
    eventEndsAt: row.eventEndsAt,
    openFrom: row.openFrom,
    openUntil: row.openUntil,
    summary: row.summary,
    details: row.details,
    keywords: row.keywords,
    agentInstructions: row.agentInstructions,
    onMatch: row.onMatch,
    handoffReason: row.handoffReason,
    closedReplyHint: row.closedReplyHint,
    priority: row.priority,
  };
}

function withLifecycle<T extends TenantEventFields>(
  event: T,
  now: Date,
): T & { lifecycle: TenantEventLifecycle } {
  let lifecycle = resolveEventLifecycle(event, now);
  if (event.status === 'paused' || event.status === 'archived') {
    lifecycle = eventVisibleForAgent(event, now) ? 'expired' : 'hidden';
  }
  return { ...event, lifecycle };
}

function defaultAgentInstructions(kind: TenantEventKind, title: string): string {
  if (kind === 'hiring' || kind === 'collab') {
    return `Клієнт пише щодо «${title}». Представся за брендом (AI-асистент), подякуй, скажи що рішення приймає керівник. У тій самій відповіді — повне клієнтське повідомлення + request_handoff з show_to_client=true (без прапорця клієнт побачить лише «зʼєдную»).`;
  }
  if (kind === 'casting') {
    return `Клієнт відгукується на кастинг «${title}». Підтвердь умови з опису, збери потрібні контакти/фото і веди до запису або заявки за правилами студії.`;
  }
  if (kind === 'promo') {
    return `Клієнт цікавиться акцією/знижкою «${title}». Поясни умови з опису і допоможи записатись / оформити, якщо підходить.`;
  }
  return `Клієнт питає про подію компанії «${title}». Відповідай за описом події.`;
}

function keywordsFromTitle(title: string): string[] {
  return title
    .split(/[\s,/|]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 3)
    .slice(0, 8);
}

export async function listTenantEvents(opts?: {
  includeArchived?: boolean;
}): Promise<Array<TenantEventFields & { lifecycle: TenantEventLifecycle; createdAt: Date; updatedAt: Date }>> {
  const now = new Date();
  const rows = await prisma.tenantEvent.findMany({
    where: opts?.includeArchived ? undefined : { status: { not: 'archived' } },
    orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
  });
  return rows.map((r) => {
    const fields = toFields(r);
    return { ...withLifecycle(fields, now), createdAt: r.createdAt, updatedAt: r.updatedAt };
  });
}

export async function getTenantEventById(
  id: string,
): Promise<(TenantEventFields & { lifecycle: TenantEventLifecycle; createdAt: Date; updatedAt: Date }) | null> {
  const row = await prisma.tenantEvent.findUnique({ where: { id } });
  if (!row) return null;
  const fields = toFields(row);
  const now = new Date();
  return { ...withLifecycle(fields, now), createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export async function createTenantEvent(input: TenantEventInput) {
  const kind = input.kind;
  const onMatch = input.onMatch ?? defaultOnMatchForKind(kind);
  const details = input.details.trim();
  const summary = (input.summary?.trim() || summaryFromDetails(details) || input.title).slice(0, 500);
  const keywords =
    input.keywords && input.keywords.length > 0
      ? input.keywords
      : keywordsFromTitle(input.title);
  const agentInstructions =
    input.agentInstructions?.trim() || defaultAgentInstructions(kind, input.title);

  const row = await prisma.tenantEvent.create({
    data: {
      title: input.title.trim(),
      kind,
      status: input.status ?? 'draft',
      eventStartsAt: optionalDate(input.eventStartsAt) ?? null,
      eventEndsAt: optionalDate(input.eventEndsAt) ?? null,
      openFrom: optionalDate(input.openFrom) ?? null,
      openUntil: optionalDate(input.openUntil) ?? null,
      summary,
      details,
      keywords,
      agentInstructions,
      onMatch,
      handoffReason: input.handoffReason === undefined ? null : input.handoffReason,
      closedReplyHint: input.closedReplyHint === undefined ? null : input.closedReplyHint,
      priority: input.priority ?? 0,
    },
  });
  return withLifecycle(toFields(row), new Date());
}

export async function updateTenantEvent(id: string, input: TenantEventUpdate) {
  const data: Record<string, unknown> = {};
  if (input.title !== undefined) data.title = input.title.trim();
  if (input.kind !== undefined) data.kind = input.kind;
  if (input.status !== undefined) data.status = input.status;
  if (input.eventStartsAt !== undefined) data.eventStartsAt = optionalDate(input.eventStartsAt);
  if (input.eventEndsAt !== undefined) data.eventEndsAt = optionalDate(input.eventEndsAt);
  if (input.openFrom !== undefined) data.openFrom = optionalDate(input.openFrom);
  if (input.openUntil !== undefined) data.openUntil = optionalDate(input.openUntil);
  if (input.summary !== undefined) data.summary = input.summary.trim();
  if (input.details !== undefined) data.details = input.details.trim();
  if (input.keywords !== undefined) data.keywords = input.keywords;
  if (input.agentInstructions !== undefined) data.agentInstructions = input.agentInstructions.trim();
  if (input.onMatch !== undefined) data.onMatch = input.onMatch;
  if (input.handoffReason !== undefined) data.handoffReason = input.handoffReason;
  if (input.closedReplyHint !== undefined) data.closedReplyHint = input.closedReplyHint;
  if (input.priority !== undefined) data.priority = input.priority;

  // Auto-fill summary when details change and summary omitted
  if (input.details !== undefined && input.summary === undefined) {
    data.summary = summaryFromDetails(input.details.trim()) || input.details.trim().slice(0, 160);
  }
  if (input.kind !== undefined && input.onMatch === undefined) {
    // keep existing onMatch unless kind-only change without explicit onMatch — leave as-is
  }

  const row = await prisma.tenantEvent.update({ where: { id }, data });
  return withLifecycle(toFields(row), new Date());
}

export async function deleteTenantEvent(id: string): Promise<void> {
  await prisma.tenantEvent.delete({ where: { id } });
}

export async function duplicateTenantEvent(id: string) {
  const existing = await prisma.tenantEvent.findUnique({ where: { id } });
  if (!existing) return null;
  const row = await prisma.tenantEvent.create({
    data: {
      title: `${existing.title} (копія)`,
      kind: existing.kind,
      status: 'draft',
      eventStartsAt: null,
      eventEndsAt: null,
      openFrom: null,
      openUntil: null,
      summary: existing.summary,
      details: existing.details,
      keywords: existing.keywords,
      agentInstructions: existing.agentInstructions,
      onMatch: existing.onMatch,
      handoffReason: existing.handoffReason,
      closedReplyHint: existing.closedReplyHint,
      priority: existing.priority,
    },
  });
  return withLifecycle(toFields(row), new Date());
}

/** Events for prompt inject + soft-match (open/scheduled/recently ended). */
export async function loadAgentVisibleEvents(now: Date = new Date()): Promise<TenantEventFields[]> {
  const rows = await prisma.tenantEvent.findMany({
    where: {
      status: { in: ['active', 'paused', 'archived'] },
    },
    orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    take: 80,
  });
  return rows.map(toFields).filter((e) => eventVisibleForAgent(e, now));
}

export async function buildTenantEventsPromptBlock(
  now: Date = new Date(),
  timeZone?: string,
): Promise<string> {
  const events = await loadAgentVisibleEvents(now);
  return formatTenantEventsForPrompt(events, now, timeZone);
}

export async function softMatchTenantEvents(
  query: string,
  now: Date = new Date(),
): Promise<{
  events: Array<TenantEventFields & { matchScore: number; lifecycle: TenantEventLifecycle }>;
  hint: string | null;
}> {
  const events = await loadAgentVisibleEvents(now);
  const hits = matchEventsByQuery(events, query, now);
  if (hits.length === 0) return { events: [], hint: null };
  const top = hits[0]!;
  return {
    events: hits.slice(0, 5),
    hint: formatMatchedEventHint(top, top.lifecycle),
  };
}

export async function executeLookupTenantEvents(args: {
  query?: string;
  event_id?: string;
  timeZone?: string | null;
}): Promise<string> {
  const now = new Date();
  const timeZone = args.timeZone ?? undefined;
  const eventId = typeof args.event_id === 'string' ? args.event_id.trim() : '';

  if (eventId) {
    const row = await prisma.tenantEvent.findUnique({ where: { id: eventId } });
    if (!row) return `[lookup_tenant_events] Подію ${eventId} не знайдено.`;
    const fields = toFields(row);
    const withLife = withLifecycle(fields, now);
    if (withLife.lifecycle === 'hidden' && !eventVisibleForAgent(fields, now)) {
      return `[lookup_tenant_events] Подія «${fields.title}» прихована/застаріла і не для агента.`;
    }
    return `[lookup_tenant_events] РЕЗУЛЬТАТ (1):\n---\n${formatEventToolResult(withLife, timeZone)}`;
  }

  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const visible = await loadAgentVisibleEvents(now);
  if (visible.length === 0) {
    return '[lookup_tenant_events] Немає активних або нещодавно завершених подій.';
  }

  const hits = query
    ? matchEventsByQuery(visible, query, now)
    : visible
        .map((e) => withLifecycle(e, now))
        .filter((e) => e.lifecycle !== 'hidden')
        .sort((a, b) => b.priority - a.priority)
        .map((e) => ({ ...e, matchScore: 0 }));

  if (hits.length === 0) {
    return query
      ? `[lookup_tenant_events] Нічого не знайдено за «${query}». Перевір календар у промпті або уточни у клієнта.`
      : '[lookup_tenant_events] Немає видимих подій.';
  }

  const top = hits.slice(0, 5);
  const body = top
    .map((e) => formatEventToolResult(e, timeZone))
    .join('\n---\n');
  return `[lookup_tenant_events] РЕЗУЛЬТАТ (${top.length}):\n---\n${body}`;
}
