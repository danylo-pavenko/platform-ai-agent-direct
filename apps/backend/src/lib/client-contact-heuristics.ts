/**
 * Deterministic extraction of phone / email / Nova Poshta hints from free-form
 * Ukrainian (and mixed) chat text. Complements Claude's update_client_info tool
 * so contact data is still captured when the model omits the tool.
 */

import pino from 'pino';
import { prisma } from './prisma.js';

const log = pino({ name: 'client-contact-heuristics' });

const MAX_SCAN_LEN = 8000;

/** Major UA cities — substring match (word boundary) */
const KNOWN_UA_CITIES = [
  'київ',
  'львів',
  'харків',
  'одеса',
  'дніпро',
  'запоріжжя',
  'вінниця',
  'полтава',
  'чернівці',
  'тернопіль',
  'івано-франківськ',
  'ужгород',
  'рівне',
  'луцьк',
  'хмельницький',
  'черкаси',
  'кропивницький',
  'миколаїв',
  'херсон',
  'суми',
  'чернігів',
  'біла церква',
  'кривий ріг',
];

const EMAIL_RE = /\b[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9][A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const NP_CONTEXT_RE = /(?:нова\s*пошта|н\.?\s*п\.?|новой\s*пошти|nova\s*poshta|відділенн(?:я|і)|відд\.?|отделени|поштомат|постомат|postamat)/i;

/** Branch number only after explicit відділення / № — avoids matching "номер 380…" */
const NP_BRANCH_NUM_RE =
  /(?:відділенн(?:я|і)|відд\.?|отделени)\s*(?:№|#)?\s*(\d{1,5})\b|(?:№|#)\s*(\d{1,5})\b/gi;

const NP_INLINE_RE =
  /(?:нова\s*пошта|н\.?\s*п\.?|nova\s*poshta)\s*[,:]?\s*(?:відділенн(?:я|і)|відд\.?|№|#)?\s*(\d{1,5})\b/gi;

const NP_BRANCH_CITY_TAIL_RE = /(?:№|#)?\s*(\d{1,4})\D{0,6}([а-яіїєґA-ZІЇЄҐ][а-яіїєґA-ZІЇЄҐʼ'-]{2,24})\b/iu;

const CITY_PREFIX_RE = /(?:^|[\s,.;])(?:м\.|місто|містечко)\s+([А-ЯІЇЄҐ][а-яіїєґA-ZІЇЄҐʼ'-]{1,28})\b/iu;

const PHONE_CANDIDATE_RES: RegExp[] = [
  /\+?\s*380\s*\(?\d{2}\)?\s*\d{3}\s*\d{2}\s*\d{2}\b/g,
  /\b380\d{9}\b/g,
  /\b0\s*\(?\d{2}\)?\s*\d{3}\s*\d{2}\s*\d{2}\b/g,
  /\b0\d{9}\b/g,
];

export interface ContactPatches {
  phone?: string;
  email?: string;
  deliveryCity?: string;
  deliveryNpBranch?: string;
  deliveryNpType?: 'warehouse' | 'postamat';
}

/** Strip to digits only (no +) */
function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

function phonesDigitsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return digitsOnly(a) === digitsOnly(b);
}

/**
 * Normalise Ukrainian mobile to +380XXXXXXXXX, or null if invalid length/prefix.
 */
export function normalizeUaPhone(raw: string): string | null {
  let d = digitsOnly(raw);
  if (d.startsWith('380') && d.length === 12) {
    d = d.slice(3);
  } else if (d.startsWith('0') && d.length === 10) {
    d = d.slice(1);
  } else if (d.length === 9) {
    /* already without leading 0 */
  } else {
    return null;
  }
  if (d.length !== 9) return null;
  // First digit of national number should be mobile range (not 0)
  if (d[0] === '0') return null;
  return `+380${d}`;
}

function extractPhones(text: string): string[] {
  const found = new Set<string>();
  for (const re of PHONE_CANDIDATE_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags.replace('g', '') + 'g');
    while ((m = r.exec(text)) !== null) {
      const n = normalizeUaPhone(m[0]);
      if (n) found.add(n);
    }
  }
  return [...found];
}

function extractEmail(text: string): string | undefined {
  EMAIL_RE.lastIndex = 0;
  const m = EMAIL_RE.exec(text);
  if (!m) return undefined;
  return m[0].trim().toLowerCase();
}

function titleCaseCity(word: string): string {
  const w = word.trim();
  if (!w) return w;
  return w.charAt(0).toLocaleUpperCase('uk-UA') + w.slice(1).toLocaleLowerCase('uk-UA');
}

function extractKnownCity(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const c of KNOWN_UA_CITIES) {
    const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const re = new RegExp(`(?:^|[^а-яіїєґa-z0-9])${escaped}(?:$|[^а-яіїєґa-z0-9])`, 'iu');
    if (re.test(lower)) return titleCaseCity(c);
  }
  const m = text.match(CITY_PREFIX_RE);
  if (m?.[1] && m[1].length >= 2 && m[1].length <= 30) return titleCaseCity(m[1]);
  return undefined;
}

function isPlausibleNpBranch(n: string): boolean {
  const x = parseInt(n, 10);
  if (!Number.isFinite(x) || x < 1 || x > 99_999) return false;
  // Avoid matching the start of a 380… phone as a "branch"
  if (x >= 380_000_000) return false;
  return true;
}

function extractNpBranch(text: string): { branch?: string; city?: string; npType?: 'warehouse' | 'postamat' } {
  const out: { branch?: string; city?: string; npType?: 'warehouse' | 'postamat' } = {};
  if (/\b(?:поштомат|постомат|postamat)\b/i.test(text)) {
    out.npType = 'postamat';
  } else if (NP_CONTEXT_RE.test(text)) {
    out.npType = 'warehouse';
  }

  let branch: string | undefined;
  NP_INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NP_INLINE_RE.exec(text)) !== null) {
    const cand = m[1];
    if (cand && isPlausibleNpBranch(cand)) branch = cand;
  }
  NP_BRANCH_NUM_RE.lastIndex = 0;
  while ((m = NP_BRANCH_NUM_RE.exec(text)) !== null) {
    const cand = m[1] ?? m[2];
    if (cand && isPlausibleNpBranch(cand)) branch = cand;
  }
  if (branch) out.branch = branch;

  // "Нова пошта 36 львів" style: NP context window then branch + city token
  const ctxIdx = text.search(NP_CONTEXT_RE);
  if (ctxIdx !== -1) {
    const slice = text.slice(ctxIdx, ctxIdx + 140);
    const tail = slice.match(NP_BRANCH_CITY_TAIL_RE);
    if (tail?.[1]) out.branch = tail[1];
    if (tail?.[2] && tail[2].length >= 3) {
      const cityGuess = titleCaseCity(tail[2]);
      if (!/\d/.test(cityGuess)) out.city = cityGuess;
    }
  }

  if (!out.city) {
    const k = extractKnownCity(text);
    if (k) out.city = k;
  }

  return out;
}

/**
 * Parse contact fields from a single inbound message body.
 */
export function extractContactPatchesFromText(text: string): ContactPatches {
  const t = text.length > MAX_SCAN_LEN ? text.slice(0, MAX_SCAN_LEN) : text;
  if (!t.trim()) return {};

  const patches: ContactPatches = {};
  const phones = extractPhones(t);
  if (phones.length > 0) {
    patches.phone = phones[phones.length - 1]!;
  }

  const email = extractEmail(t);
  if (email) patches.email = email;

  const np = extractNpBranch(t);
  if (np.branch) patches.deliveryNpBranch = np.branch;
  if (np.city) patches.deliveryCity = np.city;
  if (np.npType) patches.deliveryNpType = np.npType;

  return patches;
}

/**
 * Merge extracted patches into the client row. Only defined patch keys are
 * written; existing DB fields are never cleared from this path.
 */
/** @returns true when at least one client column was updated */
export async function persistHeuristicClientContact(
  clientId: string,
  messageText: string,
): Promise<boolean> {
  const patches = extractContactPatchesFromText(messageText);
  if (
    !patches.phone &&
    !patches.email &&
    !patches.deliveryCity &&
    !patches.deliveryNpBranch &&
    !patches.deliveryNpType
  ) {
    return false;
  }

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      phone: true,
      email: true,
      deliveryCity: true,
      deliveryNpBranch: true,
      deliveryNpType: true,
    },
  });

  if (!client) {
    log.warn({ clientId }, 'Client not found for heuristic contact persist');
    return false;
  }

  const data: Record<string, string> = {};

  if (patches.phone && !phonesDigitsEqual(client.phone, patches.phone)) {
    data.phone = patches.phone;
  }
  if (patches.email && patches.email !== (client.email ?? '').toLowerCase()) {
    data.email = patches.email;
  }
  if (patches.deliveryCity && patches.deliveryCity !== (client.deliveryCity ?? '')) {
    data.deliveryCity = patches.deliveryCity;
  }
  if (patches.deliveryNpBranch && patches.deliveryNpBranch !== (client.deliveryNpBranch ?? '')) {
    data.deliveryNpBranch = patches.deliveryNpBranch;
  }
  if (patches.deliveryNpType && patches.deliveryNpType !== (client.deliveryNpType ?? '')) {
    data.deliveryNpType = patches.deliveryNpType;
  }

  if (Object.keys(data).length === 0) return false;

  await prisma.client.update({
    where: { id: clientId },
    data,
  });

  log.info(
    { clientId, fields: Object.keys(data) },
    'Client profile updated from inbound message heuristics',
  );
  return true;
}
