/**
 * Infer soft open agenda from messages (rules + optional Haiku), then promote to funnel.
 */

import pino from 'pino';
import { z } from 'zod';
import { askClaude } from './claude.js';
import {
  inferOpenAgendaFromRules,
  type AgendaMessageRow,
} from '../lib/open-agenda-rules.js';
import {
  freshOpenAgenda,
  hasOpenAgendaInferAttempt,
  markInferAttempted,
  openAgendaInferEmptyMarker,
  type OpenAgenda,
  type OpenAgendaKind,
} from '../lib/open-agenda.js';
import {
  promoteBookingFunnelFromAgenda,
  withPromoteSource,
} from '../lib/open-agenda-promote.js';
import { persistOpenAgenda } from './open-agenda-store.js';
import { persistBookingFunnel } from './booking-funnel-store.js';
import { prisma } from '../lib/prisma.js';
import { freshBookingFunnel } from '../lib/booking-funnel.js';

const log = pino({ name: 'open-agenda-infer' });

const OPEN_AGENDA_INFER_TIMEOUT_MS = 25_000;

const LlmAgendaSchema = z.object({
  open: z.boolean(),
  kind: z.enum(['booking', 'sales', 'leadgen', 'other']).optional(),
  summary: z.string().max(400).optional(),
  knownFacts: z.array(z.string().max(200)).max(12).optional(),
  nextAction: z.string().max(300).optional(),
  awaiting: z.array(z.string().max(40)).max(8).optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
});

function formatTranscript(rows: AgendaMessageRow[]): string {
  return rows
    .filter((m) => typeof m.text === 'string' && m.text.trim())
    .slice(-20)
    .map((m) => {
      const who =
        m.sender === 'manager'
          ? 'менеджер'
          : m.sender === 'bot' || m.direction === 'out'
            ? 'бот'
            : 'клієнт';
      return `${who}: ${m.text!.replace(/\s+/g, ' ').trim().slice(0, 220)}`;
    })
    .join('\n');
}

function parseLlmAgendaJson(text: string): z.infer<typeof LlmAgendaSchema> | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence?.[1]?.trim() ?? trimmed;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    const r = LlmAgendaSchema.safeParse(parsed);
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export async function inferOpenAgendaWithLlm(
  messages: AgendaMessageRow[],
  opts?: { conversationId?: string; clientId?: string; now?: Date },
): Promise<OpenAgenda | null> {
  const now = opts?.now ?? new Date();
  const transcript = formatTranscript(messages);
  if (!transcript.trim()) return null;

  const systemPrompt = [
    'Ти витягуєш ОДИН незавершений тред з переписки салону/магазину в Instagram.',
    'Відповідай ТІЛЬКИ JSON без markdown:',
    '{"open":boolean,"kind":"booking"|"sales"|"leadgen"|"other","summary":"...","knownFacts":["послуга: …","майстер: …","дата: ДД.ММ.РРРР","час: HH:MM"],"nextAction":"...","awaiting":["name","phone"],"confidence":"high"|"medium"|"low"}',
    'open=false якщо smalltalk, вже підтверджений запис/замовлення, або немає чіткого незавершеного кроку.',
    'knownFacts — короткі «ключ: значення» українською. Не вигадуй UUID.',
  ].join('\n');

  const response = await askClaude(
    {
      systemPrompt,
      conversationHistory: [],
      userMessage: `Переписка:\n${transcript}\n\nJSON:`,
    },
    {
      channel: 'ig',
      conversationId: opts?.conversationId,
      clientId: opts?.clientId,
      model: 'haiku',
      spawnPurpose: 'open_agenda_infer',
      timeoutMs: OPEN_AGENDA_INFER_TIMEOUT_MS,
    },
  );

  if (response.fallback) {
    log.info(
      { conversationId: opts?.conversationId, reason: response.fallback },
      'Open agenda LLM infer skipped (fallback)',
    );
    return null;
  }

  const parsed = parseLlmAgendaJson(response.text);
  if (!parsed || !parsed.open) return null;
  if (!parsed.summary?.trim() && (!parsed.knownFacts || parsed.knownFacts.length === 0)) {
    return null;
  }

  const kind = (parsed.kind ?? 'other') as OpenAgendaKind;
  return {
    kind,
    summary: (parsed.summary ?? '').trim().slice(0, 400),
    knownFacts: (parsed.knownFacts ?? []).map((f) => f.trim()).filter(Boolean).slice(0, 12),
    nextAction: (parsed.nextAction ?? '').trim().slice(0, 300),
    awaiting: (parsed.awaiting ?? []).map((f) => f.trim()).filter(Boolean).slice(0, 8),
    status: 'open',
    source: 'ig_import',
    confidence: parsed.confidence ?? 'medium',
    updatedAt: now.toISOString(),
  };
}

/**
 * Rules first, then Haiku if rules miss. Never throws.
 */
export async function inferOpenAgendaFromMessages(
  messages: AgendaMessageRow[],
  opts?: { conversationId?: string; clientId?: string; now?: Date; skipLlm?: boolean },
): Promise<OpenAgenda | null> {
  const now = opts?.now ?? new Date();
  const fromRules = inferOpenAgendaFromRules(messages, now);
  if (fromRules && (fromRules.confidence === 'high' || fromRules.confidence === 'medium')) {
    return fromRules;
  }
  if (opts?.skipLlm) return fromRules;

  try {
    const fromLlm = await inferOpenAgendaWithLlm(messages, opts);
    if (fromLlm) return fromLlm;
  } catch (err) {
    log.warn({ err, conversationId: opts?.conversationId }, 'Open agenda LLM infer failed');
  }
  return fromRules;
}

export type EnsureOpenAgendaResult = {
  agenda: OpenAgenda | null;
  funnelPromoted: boolean;
  skipped: boolean;
};

/**
 * One-shot infer + persist + optional funnel promote.
 * Skips if fresh agenda/funnel already present or infer already attempted.
 */
export async function ensureOpenAgendaForConversation(params: {
  conversationId: string;
  clientId?: string;
  source?: 'ig_import' | 'live';
  skipLlm?: boolean;
  now?: Date;
}): Promise<EnsureOpenAgendaResult> {
  const now = params.now ?? new Date();
  const source = params.source ?? 'ig_import';

  try {
    const conv = await prisma.conversation.findUnique({
      where: { id: params.conversationId },
      select: { openAgenda: true, bookingFunnel: true, clientId: true },
    });
    if (!conv) return { agenda: null, funnelPromoted: false, skipped: true };

    if (freshOpenAgenda(conv.openAgenda, now) || freshBookingFunnel(conv.bookingFunnel, now)) {
      return { agenda: freshOpenAgenda(conv.openAgenda, now), funnelPromoted: false, skipped: true };
    }
    if (hasOpenAgendaInferAttempt(conv.openAgenda)) {
      return { agenda: null, funnelPromoted: false, skipped: true };
    }

    const rows = await prisma.message.findMany({
      where: {
        conversationId: params.conversationId,
        sender: { in: ['client', 'bot', 'manager'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 24,
      select: { direction: true, sender: true, text: true, createdAt: true },
    });
    const messages = rows.reverse();

    let agenda = await inferOpenAgendaFromMessages(messages, {
      conversationId: params.conversationId,
      clientId: params.clientId ?? conv.clientId,
      now,
      skipLlm: params.skipLlm,
    });

    if (!agenda) {
      await persistOpenAgenda(params.conversationId, openAgendaInferEmptyMarker(source, now));
      return { agenda: null, funnelPromoted: false, skipped: false };
    }

    agenda = markInferAttempted({ ...agenda, source }, now);

    let funnelPromoted = false;
    const funnel = await promoteBookingFunnelFromAgenda(agenda, now);
    if (funnel) {
      await persistBookingFunnel(params.conversationId, funnel);
      agenda = withPromoteSource(agenda, now);
      funnelPromoted = true;
    }

    await persistOpenAgenda(params.conversationId, agenda);
    log.info(
      {
        conversationId: params.conversationId,
        kind: agenda.kind,
        confidence: agenda.confidence,
        funnelPromoted,
      },
      'Open agenda inferred',
    );
    return { agenda, funnelPromoted, skipped: false };
  } catch (err) {
    log.warn({ err, conversationId: params.conversationId }, 'ensureOpenAgendaForConversation failed');
    return { agenda: null, funnelPromoted: false, skipped: true };
  }
}
