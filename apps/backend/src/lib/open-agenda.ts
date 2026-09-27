/**
 * Soft open agenda — logical unfinished thread (not CRM-hard ids).
 * Survives civil-day cuts; longer TTL than bookingFunnel.
 */

import { civilSessionGapDays } from './claude-history-window.js';
import type { BookingFunnel } from './booking-funnel.js';

export const OPEN_AGENDA_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type OpenAgendaKind = 'booking' | 'sales' | 'leadgen' | 'other';
export type OpenAgendaStatus = 'open' | 'done';
export type OpenAgendaSource = 'ig_import' | 'live' | 'promote';
export type OpenAgendaConfidence = 'high' | 'medium' | 'low';

export type OpenAgenda = {
  kind: OpenAgendaKind;
  summary: string;
  knownFacts: string[];
  nextAction: string;
  awaiting: string[];
  status: OpenAgendaStatus;
  source: OpenAgendaSource;
  confidence: OpenAgendaConfidence;
  updatedAt: string;
  /** Set after one infer pass (even when no open thread) — prevents re-LLM. */
  inferAttemptedAt?: string;
};

const KINDS = new Set<OpenAgendaKind>(['booking', 'sales', 'leadgen', 'other']);
const STATUSES = new Set<OpenAgendaStatus>(['open', 'done']);
const SOURCES = new Set<OpenAgendaSource>(['ig_import', 'live', 'promote']);
const CONFIDENCES = new Set<OpenAgendaConfidence>(['high', 'medium', 'low']);

function asStringArray(value: unknown, max = 12): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const row of value) {
    if (typeof row !== 'string') continue;
    const t = row.trim();
    if (!t) continue;
    out.push(t.slice(0, 200));
    if (out.length >= max) break;
  }
  return out;
}

export function parseOpenAgenda(value: unknown): OpenAgenda | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const updatedAt = typeof v.updatedAt === 'string' ? v.updatedAt.trim() : '';
  if (!updatedAt) return null;

  const kindRaw = typeof v.kind === 'string' ? v.kind.trim() : 'other';
  const kind: OpenAgendaKind = KINDS.has(kindRaw as OpenAgendaKind)
    ? (kindRaw as OpenAgendaKind)
    : 'other';
  const statusRaw = typeof v.status === 'string' ? v.status.trim() : 'open';
  const status: OpenAgendaStatus = STATUSES.has(statusRaw as OpenAgendaStatus)
    ? (statusRaw as OpenAgendaStatus)
    : 'open';
  const sourceRaw = typeof v.source === 'string' ? v.source.trim() : 'live';
  const source: OpenAgendaSource = SOURCES.has(sourceRaw as OpenAgendaSource)
    ? (sourceRaw as OpenAgendaSource)
    : 'live';
  const confRaw = typeof v.confidence === 'string' ? v.confidence.trim() : 'medium';
  const confidence: OpenAgendaConfidence = CONFIDENCES.has(confRaw as OpenAgendaConfidence)
    ? (confRaw as OpenAgendaConfidence)
    : 'medium';

  const summary = typeof v.summary === 'string' ? v.summary.trim().slice(0, 400) : '';
  const nextAction =
    typeof v.nextAction === 'string' ? v.nextAction.trim().slice(0, 300) : '';
  const inferAttemptedAt =
    typeof v.inferAttemptedAt === 'string' && v.inferAttemptedAt.trim()
      ? v.inferAttemptedAt.trim()
      : undefined;

  return {
    kind,
    summary,
    knownFacts: asStringArray(v.knownFacts),
    nextAction,
    awaiting: asStringArray(v.awaiting, 8),
    status,
    source,
    confidence,
    updatedAt,
    inferAttemptedAt,
  };
}

export function isFreshOpenAgenda(
  agenda: OpenAgenda | null | undefined,
  now = new Date(),
  ttlMs = OPEN_AGENDA_TTL_MS,
): agenda is OpenAgenda {
  if (!agenda?.updatedAt || agenda.status !== 'open') return false;
  if (!agenda.summary.trim() && agenda.knownFacts.length === 0) return false;
  const at = Date.parse(agenda.updatedAt);
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at <= ttlMs;
}

export function freshOpenAgenda(value: unknown, now = new Date()): OpenAgenda | null {
  const agenda = parseOpenAgenda(value);
  return isFreshOpenAgenda(agenda, now) ? agenda : null;
}

/** True when an infer pass already ran (open or empty marker). */
export function hasOpenAgendaInferAttempt(value: unknown): boolean {
  const agenda = parseOpenAgenda(value);
  return Boolean(agenda?.inferAttemptedAt);
}

/** Marker persisted after infer found nothing open — blocks re-infer. */
export function openAgendaInferEmptyMarker(
  source: OpenAgendaSource,
  now = new Date(),
): OpenAgenda {
  const iso = now.toISOString();
  return {
    kind: 'other',
    summary: '',
    knownFacts: [],
    nextAction: '',
    awaiting: [],
    status: 'done',
    source,
    confidence: 'low',
    updatedAt: iso,
    inferAttemptedAt: iso,
  };
}

export function markInferAttempted(agenda: OpenAgenda, now = new Date()): OpenAgenda {
  return { ...agenda, inferAttemptedAt: now.toISOString() };
}

export function agendaFromBookingFunnel(
  funnel: BookingFunnel,
  source: OpenAgendaSource = 'live',
  now = new Date(),
): OpenAgenda {
  const facts: string[] = [];
  facts.push(`дата: ${funnel.date}`);
  if (funnel.time) facts.push(`час: ${funnel.time}`);
  if (funnel.masterName) facts.push(`майстер: ${funnel.masterName}`);
  for (const s of funnel.services) {
    facts.push(`послуга: ${s.name?.trim() || s.id}`);
  }
  const awaiting: string[] = [...funnel.missing];
  if (funnel.status === 'offering' && !funnel.time) awaiting.push('time');
  return {
    kind: 'booking',
    summary:
      funnel.status === 'awaiting_contact' && funnel.time
        ? `Незавершений запис на ${funnel.date} о ${funnel.time}`
        : `Підбір запису на ${funnel.date}`,
    knownFacts: facts,
    nextAction:
      funnel.status === 'awaiting_contact' && funnel.time
        ? 'Взяти імʼя/телефон (якщо бракує) і book_appointment з ids з «Незавершений запис»'
        : 'Уточнити годину зі слотів, потім контакти і book_appointment',
    awaiting,
    status: 'open',
    source,
    confidence: 'high',
    updatedAt: now.toISOString(),
  };
}

export function agendaAgeLabel(agenda: OpenAgenda, now: Date, timeZone: string): string {
  const updated = new Date(agenda.updatedAt);
  if (Number.isNaN(updated.getTime())) return 'нещодавно';
  const gapDays = civilSessionGapDays(updated, now, timeZone);
  if (gapDays >= 1) {
    if (gapDays === 1) return 'з учора';
    return `${gapDays} дн. тому`;
  }
  const hours = Math.max(0, Math.round((now.getTime() - updated.getTime()) / (60 * 60 * 1000)));
  if (hours <= 0) return 'щойно';
  if (hours === 1) return '~1 год тому';
  return `~${hours} год тому`;
}

export function formatOpenAgendaForPrompt(
  agenda: OpenAgenda,
  now: Date,
  timeZone: string,
): string {
  if (!isFreshOpenAgenda(agenda, now)) return '';
  const age = agendaAgeLabel(agenda, now, timeZone);
  const facts =
    agenda.knownFacts.length > 0
      ? agenda.knownFacts.map((f) => `- ${f}`).join('\n')
      : '- (факти не витягнуті)';
  const awaiting =
    agenda.awaiting.length > 0
      ? `Ще потрібно: ${agenda.awaiting.join(', ')}`
      : 'Уточни лише те, чого справді бракує.';

  return [
    `Відкритий тред (${age}; kind=${agenda.kind}; confidence=${agenda.confidence}):`,
    agenda.summary,
    'Вже відомо з попереднього діалогу:',
    facts,
    `Наступний крок: ${agenda.nextAction || 'закрий незавершене, якщо клієнт не починає нове'}`,
    awaiting,
    'Не починай funnel з нуля. Якщо є блок «Незавершений запис» — book_appointment з ids звідти.',
    'Якщо клієнт явно починає нову тему без звʼязку з цим тредом — відповідай на нове.',
  ].join('\n');
}

/** Pull fact value after a label prefix (case-insensitive). */
export function factValue(facts: string[], label: string): string | undefined {
  const prefix = `${label}:`.toLowerCase();
  for (const f of facts) {
    const lower = f.toLowerCase();
    if (lower.startsWith(prefix)) {
      const v = f.slice(f.indexOf(':') + 1).trim();
      if (v) return v;
    }
  }
  return undefined;
}
