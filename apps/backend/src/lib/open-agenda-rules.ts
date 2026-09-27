/**
 * Rules-based open-agenda extract (no LLM) — booking cues from chat lines.
 */

import { normalizeSlotTimeKey } from './booking-time-conflict.js';
import type { OpenAgenda } from './open-agenda.js';

export type AgendaMessageRow = {
  direction: string;
  sender?: string | null;
  text: string | null;
  createdAt: Date;
};

const BOOKING_HINT =
  /запис|записат|слот|вільн|манікюр|педикюр|стрижк|фарбув|бров|вії|ламінув|комплекс|до майстр|на коли|є годин/i;

const WEEKDAYS: Array<{ re: RegExp; offsetHint: string }> = [
  { re: /понеділок/i, offsetHint: 'понеділок' },
  { re: /вівторок/i, offsetHint: 'вівторок' },
  { re: /серед[ауиі]/i, offsetHint: 'середа' },
  { re: /четвер/i, offsetHint: 'четвер' },
  { re: /п['ʼ]?ятниц/i, offsetHint: 'пʼятниця' },
  { re: /субот/i, offsetHint: 'субота' },
  { re: /неділ/i, offsetHint: 'неділя' },
];

const DATE_RE = /\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/;
const TIME_RE = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g;
const MASTER_RE =
  /(?:до|у|з)\s+([А-ЯІЇЄҐA-Z][а-яіїєґa-z'ʼ-]{2,20})(?:\s|$|[.,!?:;])/u;

function who(row: AgendaMessageRow): string {
  if (row.sender === 'manager') return 'менеджер';
  if (row.sender === 'bot' || row.direction === 'out') return 'бот';
  return 'клієнт';
}

function extractTimes(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TIME_RE)) {
    const key = normalizeSlotTimeKey(`${m[1]}:${m[2]}`);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

function extractDateRaw(text: string): string | undefined {
  const m = text.match(DATE_RE);
  if (!m) return undefined;
  const d = m[1]!.padStart(2, '0');
  const mo = m[2]!.padStart(2, '0');
  let y = m[3];
  if (!y) {
    y = String(new Date().getFullYear());
  } else if (y.length === 2) {
    y = `20${y}`;
  }
  return `${d}.${mo}.${y}`;
}

function extractWeekday(text: string): string | undefined {
  for (const w of WEEKDAYS) {
    if (w.re.test(text)) return w.offsetHint;
  }
  return undefined;
}

function normalizeUaGivenName(name: string): string {
  // Light genitive → nominative for common female given names (Надії→Надія).
  if (/ії$/i.test(name) && name.length > 3) return `${name.slice(0, -1)}я`;
  if (/и$/i.test(name) && name.length > 3 && !/ий$/i.test(name)) return `${name.slice(0, -1)}а`;
  return name;
}

function extractMaster(text: string): string | undefined {
  const m = text.match(MASTER_RE);
  const name = m?.[1]?.trim();
  if (!name) return undefined;
  // Skip common false positives
  if (/^(мені|нас|вас|них|завтра|сьогодні|понеділок)/i.test(name)) return undefined;
  return normalizeUaGivenName(name);
}

function looksClosed(text: string): boolean {
  return /записала|записали|підтверджен|скасувал|скасов|вже є запис|чекаємо вас/i.test(
    text,
  );
}

/**
 * Infer booking open agenda from message rows (oldest→newest). Returns null if unclear.
 */
export function inferOpenAgendaFromRules(
  messages: AgendaMessageRow[],
  now = new Date(),
): OpenAgenda | null {
  const usable = messages
    .filter((m) => typeof m.text === 'string' && m.text.trim().length > 0)
    .slice(-20);
  if (usable.length === 0) return null;

  const joined = usable.map((m) => m.text!).join('\n');
  if (!BOOKING_HINT.test(joined)) return null;

  // If last outbound looks like confirmed booking and client didn't reopen — skip
  const lastOut = [...usable].reverse().find((m) => who(m) !== 'клієнт');
  const lastIn = [...usable].reverse().find((m) => who(m) === 'клієнт');
  if (lastOut && looksClosed(lastOut.text!) && (!lastIn || looksClosed(lastIn.text!))) {
    return null;
  }

  const knownFacts: string[] = [];
  let time: string | undefined;
  let date: string | undefined;
  let weekday: string | undefined;
  let master: string | undefined;
  let serviceHint: string | undefined;

  for (const m of usable) {
    const t = m.text!;
    for (const tm of extractTimes(t)) time = tm;
    const d = extractDateRaw(t);
    if (d) date = d;
    const wd = extractWeekday(t);
    if (wd) weekday = wd;
    const mast = extractMaster(t);
    if (mast) master = mast;
    if (/комплекс/i.test(t)) serviceHint = 'комплекс';
    else if (/манікюр/i.test(t) && !serviceHint) serviceHint = 'манікюр';
    else if (/педикюр/i.test(t) && !serviceHint) serviceHint = 'педикюр';
    else if (/стрижк/i.test(t) && !serviceHint) serviceHint = 'стрижка';
  }

  if (time) knownFacts.push(`час: ${time}`);
  if (date) knownFacts.push(`дата: ${date}`);
  else if (weekday) knownFacts.push(`день: ${weekday}`);
  if (master) knownFacts.push(`майстер: ${master}`);
  if (serviceHint) knownFacts.push(`послуга: ${serviceHint}`);

  // Need at least time or (date/weekday + service/master) to be useful
  if (!time && !date && !weekday) return null;
  if (!time && !serviceHint && !master) return null;

  const awaiting: string[] = ['name', 'phone'];
  if (!time) awaiting.push('time');
  if (!date && !weekday) awaiting.push('date');

  const summaryParts = [
    serviceHint ? `послуга «${serviceHint}»` : null,
    master ? `до ${master}` : null,
    date ? `на ${date}` : weekday ? `на ${weekday}` : null,
    time ? `о ${time}` : null,
  ].filter(Boolean);

  return {
    kind: 'booking',
    summary: summaryParts.length
      ? `Незавершений запис: ${summaryParts.join(', ')}`
      : 'Клієнт підбирав запис до бота',
    knownFacts,
    nextAction: time
      ? 'Уточнити/підтвердити послугу, взяти контакти і book_appointment (або search_services якщо немає ids)'
      : 'Показати/уточнити вільні години, потім контакти і book',
    awaiting,
    status: 'open',
    source: 'ig_import',
    confidence: time && (serviceHint || master) ? 'medium' : 'low',
    updatedAt: now.toISOString(),
  };
}
