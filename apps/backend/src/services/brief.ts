import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import { notifyBrief } from './telegram-notify.js';
import { mirrorBriefToCrm } from './crm-sync.js';

const log = pino({ name: 'brief' });

const VALID_CLIENT_TYPES = ['b2c', 'b2b', 'mixed', 'unknown'] as const;
type ClientType = (typeof VALID_CLIENT_TYPES)[number];

const VALID_CHANNELS = [
  'phone',
  'telegram',
  'direct',
  'email',
  'whatsapp',
  'viber',
  'other',
] as const;
type PreferredChannel = (typeof VALID_CHANNELS)[number];

const VALID_PRIORITIES = ['hot', 'warm', 'cold'] as const;
type Priority = (typeof VALID_PRIORITIES)[number];

function toStringOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim());
}

function toEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : null;
}

function toConfidence(v: unknown): number | null {
  if (typeof v !== 'number' || Number.isNaN(v)) return null;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Brief completeness score (B.1). Percentage of "key" qualification
 * fields that the agent managed to capture. Kept intentionally short —
 * these are the questions a human sales manager would consider the
 * minimum to triage a lead. Tenant-level tuning happens via the system
 * prompt (i.e. we steer the agent to ask these, not via config).
 *
 * `services` is array-valued; counted as present when non-empty.
 * Everything else is a trimmed string.
 */
interface BriefKeyFields {
  niche: string | null;
  services: string[];
  budgetRange: string | null;
  preferredChannel: string | null;
  desiredStart: string | null;
}

function computeCompletenessPct(fields: BriefKeyFields): number {
  const checks = [
    !!fields.niche,
    fields.services.length > 0,
    !!fields.budgetRange,
    !!fields.preferredChannel,
    !!fields.desiredStart,
  ];
  const filled = checks.filter(Boolean).length;
  return Math.round((filled / checks.length) * 100);
}

/**
 * Handles the `submit_brief` tool call from Claude in leadgen mode.
 *
 * Persists the PresaleBrief, notifies the manager group in Telegram,
 * and triggers the CRM mirror asynchronously. The caller is responsible
 * for delivering the confirmation message to the client (so it can be
 * tailored to working hours / SLA via the prompt-builder output).
 */
export async function handleSubmitBrief(
  conversationId: string,
  clientId: string,
  clientIgUserId: string,
  args: Record<string, unknown>,
): Promise<void> {
  const clientType = toEnum<ClientType>(args.client_type, VALID_CLIENT_TYPES);
  const preferredChannel = toEnum<PreferredChannel>(
    args.preferred_channel,
    VALID_CHANNELS,
  );
  const priority = toEnum<Priority>(args.priority, VALID_PRIORITIES);

  const niche = toStringOrNull(args.niche);
  const services = toStringArray(args.services);
  const budgetRange = toStringOrNull(args.budget_range);
  const desiredStart = toStringOrNull(args.desired_start);

  const completenessPct = computeCompletenessPct({
    niche,
    services,
    budgetRange,
    preferredChannel,
    desiredStart,
  });

  const data = {
    conversationId,
    clientId,

    businessName: toStringOrNull(args.business_name),
    niche,
    role: toStringOrNull(args.role),
    clientType,

    services,
    goal: toStringOrNull(args.goal),
    desiredResult: toStringOrNull(args.desired_result),
    kpi: toStringOrNull(args.kpi),

    currentActivity: toStringOrNull(args.current_activity),
    previousContractors: toStringOrNull(args.previous_contractors),
    painPoints: toStringOrNull(args.pain_points),

    size: toStringOrNull(args.size),
    geo: toStringOrNull(args.geo),

    websiteUrl: toStringOrNull(args.website_url),
    instagramUrl: toStringOrNull(args.instagram_url),
    otherChannels: toStringOrNull(args.other_channels),

    budgetRange,
    budgetPeriod: toStringOrNull(args.budget_period),

    desiredStart,
    deadlines: toStringOrNull(args.deadlines),

    phone: toStringOrNull(args.phone),
    email: toStringOrNull(args.email),
    preferredChannel,
    preferredTime: toStringOrNull(args.preferred_time),

    segment: toStringOrNull(args.segment),
    priority,
    source: toStringOrNull(args.source),

    completenessPct,
    confidence: toConfidence(args.confidence),

    // Keep the full raw payload so fields not yet modeled are never lost
    // and downstream consumers (CRM mapper, admin inspector) can see exactly
    // what Claude sent.
    rawPayload: args as unknown,

    status: 'submitted' as const,
  };

  const brief = await prisma.presaleBrief.create({ data: data as any });

  log.info(
    {
      briefId: brief.id,
      conversationId,
      clientId,
      services: brief.services,
      priority: brief.priority,
    },
    'Presale brief submitted',
  );

  // Notify manager group — fire-and-forget, a Telegram outage must not
  // block the customer flow.
  notifyBrief({
    briefId: brief.id,
    conversationId,
    clientIgUserId,
    businessName: brief.businessName,
    niche: brief.niche,
    services: brief.services,
    budgetRange: brief.budgetRange,
    phone: brief.phone,
    email: brief.email,
    preferredChannel: brief.preferredChannel,
    priority: brief.priority,
    completenessPct: brief.completenessPct,
  }).catch((err) => log.error({ err, briefId: brief.id }, 'Failed to notify brief'));

  // Mirror into CRM asynchronously. No-op when CRM write is off or the
  // adapter doesn't implement createLead (see Phase A.6 / B.5).
  mirrorBriefToCrm(brief.id).catch((err) => {
    log.error({ err, briefId: brief.id }, 'Failed to mirror brief to CRM');
  });
}

/**
 * Handles the `classify_intent` tool call — persists the intent label on
 * the conversation so analytics and routing have it. Free-form text:
 * the JSON schema enforces the vocabulary, not the DB.
 */
export async function handleClassifyIntent(
  conversationId: string,
  args: Record<string, unknown>,
): Promise<void> {
  const intent = toStringOrNull(args.intent);
  if (!intent) {
    log.debug({ conversationId }, 'classify_intent called without intent — skipping');
    return;
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { intent },
  });

  log.info({ conversationId, intent }, 'Conversation intent classified');
}
