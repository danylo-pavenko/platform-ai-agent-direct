import { prisma, toInputJsonValue } from '../lib/prisma.js';
import {
  formatAttachmentsForAgent,
  parseLibraryAttachments,
  type LibraryAttachment,
} from '../lib/library-attachments.js';
import { parseLibraryPack, type LibraryCardInput } from './library-pack.js';

/** How many card bodies may ride along before Claude on one turn. */
export const LIBRARY_MATCH_LIMIT = 3;

/** Index of active cards. Kept short so it can sit on every turn. */
const INDEX_CHAR_BUDGET = 6000;

export interface LibraryCard {
  slug: string;
  title: string;
  description: string;
  body: string;
  aliases: string[];
  attachments: LibraryAttachment[];
}

export interface LibraryTurnContext {
  indexBlock: string;
  cardsBlock: string;
  matchedSlugs: string[];
}

function fold(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Alias hits as its own token, or as a phrase when it contains a space. */
export function aliasMatches(text: string, alias: string): boolean {
  const needle = fold(alias);
  if (needle.length < 2) return false;
  const hay = fold(text);
  if (!hay) return false;
  if (needle.includes(' ')) return hay.includes(needle);
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`,
    'u',
  );
  return re.test(hay);
}

const PRICE_INTENT =
  /цін|прайс|price|€|евро|євро|сколько|скільки|стоит|кошту|варт/i;
const POWER_INTENT = /сил|потуж|к\.?\s*с|л\.?\s*с|\bhp\b|nm|ньютон/i;

function scoreCard(card: LibraryCard, text: string): number {
  let score = 0;
  for (const alias of card.aliases) {
    if (aliasMatches(text, alias)) score += fold(alias).length;
  }
  if (score === 0) return 0;
  if (PRICE_INTENT.test(text) && card.slug.startsWith('prices-')) score += 12;
  if (POWER_INTENT.test(text) && card.slug === 'power') score += 12;
  return score;
}

/**
 * Active cards whose aliases appear in the customer text.
 * Longer aliases win. At most LIBRARY_MATCH_LIMIT bodies.
 */
export function selectLibraryCards(
  cards: LibraryCard[],
  text: string,
  limit = LIBRARY_MATCH_LIMIT,
): LibraryCard[] {
  const ranked = cards
    .map((card) => ({ card, score: scoreCard(card, text) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.card.slug.localeCompare(b.card.slug));
  return ranked.slice(0, limit).map((row) => row.card);
}

export function formatLibraryIndex(cards: LibraryCard[]): string {
  if (cards.length === 0) return '';
  const lines = [
    '## Бібліотека',
    'Зміст карток знань. Ціна, кінські сили і список кузовів беріть лише з тексту картки в цьому ході або з результату read_library. Немає тексту картки, немає цифри. Каталог CRM нижче, якщо він є, це інше джерело: товари і візити звідти, а не з бібліотеки. Якщо в картці є фото (розмірна сітка тощо) — надішли клієнту через send_library_asset, не описуй таблицю текстом.',
  ];
  let used = lines.join('\n').length;
  for (const card of cards) {
    const description = card.description.replace(/\s+/g, ' ').trim();
    const mediaHint =
      card.attachments.length > 0
        ? ` [вкладення: ${card.attachments
            .map((a) => `${a.type}${a.title ? ` «${a.title}»` : ''}`)
            .join('; ')} → send_library_asset]`
        : '';
    const line = `- ${card.slug}: ${card.title}. ${description}${mediaHint}`;
    if (used + line.length + 1 > INDEX_CHAR_BUDGET) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

export function formatMatchedLibraryCards(cards: LibraryCard[]): string {
  if (cards.length === 0) return '';
  const parts = [
    '## Картки цього ходу',
    'Цей текст уже прочитаний. Цифри і кузови звідси можна називати. Іншу картку візьми через read_library, не з памʼяті. Фото/сітку клієнту — send_library_asset.',
  ];
  for (const card of cards) {
    const assetBlock = formatAttachmentsForAgent(card.attachments);
    parts.push(
      `### ${card.title} (${card.slug})\n${card.body.trim()}${assetBlock ? `\n\n${assetBlock}` : ''}`,
    );
  }
  return parts.join('\n\n');
}

function toCard(row: {
  slug: string;
  title: string;
  description: string;
  body: string;
  aliases: string[];
  attachments?: unknown;
}): LibraryCard {
  return {
    slug: row.slug,
    title: row.title,
    description: row.description,
    body: row.body,
    aliases: row.aliases,
    attachments: parseLibraryAttachments(row.attachments),
  };
}

/** Index of every active card, plus up to 3 bodies matched to this message. */
export async function loadLibraryTurnContext(userText: string): Promise<LibraryTurnContext> {
  const rows = await prisma.knowledgeArticle.findMany({
    where: { status: 'active' },
    orderBy: { title: 'asc' },
    select: {
      slug: true,
      title: true,
      description: true,
      body: true,
      aliases: true,
      attachments: true,
    },
  });
  const cards = rows.map(toCard);
  const matched = selectLibraryCards(cards, userText);
  return {
    indexBlock: formatLibraryIndex(cards),
    cardsBlock: formatMatchedLibraryCards(matched),
    matchedSlugs: matched.map((card) => card.slug),
  };
}

const READ_LIMIT = 3;

/** Host read for the read_library tool. Drafts are invisible. */
export async function readLibraryBySlugs(raw: unknown): Promise<string> {
  const slugs = normalizeSlugArgs(raw).slice(0, READ_LIMIT);
  if (slugs.length === 0) {
    return '[read_library] ПОМИЛКА: передай slug або кілька slug зі змісту бібліотеки.';
  }
  const rows = await prisma.knowledgeArticle.findMany({
    where: { status: 'active', slug: { in: slugs } },
    select: { slug: true, title: true, body: true, attachments: true },
  });
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const parts: string[] = [];
  for (const slug of slugs) {
    const row = bySlug.get(slug);
    if (!row) {
      parts.push(`[read_library] Картки «${slug}» немає серед активних. Візьми slug зі змісту.`);
      continue;
    }
    const assets = formatAttachmentsForAgent(parseLibraryAttachments(row.attachments));
    parts.push(
      `### ${row.title} (${row.slug})\n${row.body.trim()}${assets ? `\n\n${assets}` : ''}`,
    );
  }
  return parts.join('\n\n');
}

export async function saveLibraryDraft(input: {
  title: string;
  description: string;
  body: string;
  aliases: string[];
  slug?: string;
}): Promise<{ id: string; slug: string; title: string }> {
  const base = normalizeDraftSlug(input.slug, input.title);
  const title = input.title.trim().slice(0, 200);
  const description = input.description.trim().slice(0, 400);
  const body = input.body.trim().slice(0, 30000);
  const aliases = input.aliases
    .map((alias) => alias.trim())
    .filter((alias) => alias.length >= 2)
    .slice(0, 40);

  const existing = await prisma.knowledgeArticle.findUnique({
    where: { slug: base },
    select: { id: true, author: true, status: true, title: true },
  });

  // Upsert meta-agent drafts by slug (avoid -2 suffix spam on re-teach).
  if (existing && existing.author === 'meta_agent' && existing.status === 'draft') {
    const row = await prisma.knowledgeArticle.update({
      where: { id: existing.id },
      data: { title, description, body, aliases },
      select: { id: true, slug: true, title: true },
    });
    return row;
  }

  let slug = base;
  if (existing) {
    for (let n = 2; n < 50; n += 1) {
      slug = `${base}-${n}`.slice(0, 80);
      const clash = await prisma.knowledgeArticle.findUnique({
        where: { slug },
        select: { id: true, author: true, status: true },
      });
      if (!clash) break;
      if (clash.author === 'meta_agent' && clash.status === 'draft') {
        const row = await prisma.knowledgeArticle.update({
          where: { id: clash.id },
          data: { title, description, body, aliases },
          select: { id: true, slug: true, title: true },
        });
        return row;
      }
    }
  }

  const row = await prisma.knowledgeArticle.create({
    data: {
      slug,
      title,
      description,
      body,
      aliases,
      status: 'draft',
      author: 'meta_agent',
    },
    select: { id: true, slug: true, title: true },
  });
  return row;
}

/** Compact index for meta-agent (active + draft). */
export async function loadMetaAgentLibraryIndex(limit = 80): Promise<string> {
  const rows = await prisma.knowledgeArticle.findMany({
    where: { status: { in: ['active', 'draft'] } },
    orderBy: [{ status: 'asc' }, { title: 'asc' }],
    take: limit,
    select: { slug: true, title: true, description: true, status: true },
  });
  if (rows.length === 0) {
    return 'Карток ще немає. Факти/події/тимчасові офери можна запропонувати через libraryDrafts.';
  }
  const lines = rows.map((row) => {
    const oneLine = row.description.replace(/\s+/g, ' ').trim().slice(0, 120);
    const mark = row.status === 'draft' ? ' [draft]' : '';
    return `- ${row.slug}${mark}: ${row.title}. ${oneLine}`;
  });
  return lines.join('\n');
}

/** Publish draft→active by id (owner teach/apply). Skips missing / already active. */
export async function publishLibraryDraftsByIds(
  ids: string[],
): Promise<Array<{ id: string; slug: string; title: string; status: string }>> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) return [];
  const published: Array<{ id: string; slug: string; title: string; status: string }> = [];
  for (const id of unique) {
    const current = await prisma.knowledgeArticle.findUnique({
      where: { id },
      select: { id: true, slug: true, title: true, status: true },
    });
    if (!current) continue;
    if (current.status === 'active') {
      published.push(current);
      continue;
    }
    if (current.status !== 'draft') continue;
    const row = await prisma.knowledgeArticle.update({
      where: { id: current.id },
      data: { status: 'active' },
      select: { id: true, slug: true, title: true, status: true },
    });
    published.push(row);
  }
  return published;
}

function normalizeDraftSlug(slug: string | undefined, title: string): string {
  const candidate = (slug ?? '').trim().toLowerCase();
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate) && candidate.length >= 2) {
    return candidate.slice(0, 80);
  }
  const folded = title
    .toLowerCase()
    .replace(/ё/g, 'е')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  const fromTitle = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return fromTitle.length >= 2 ? fromTitle : `card-${Date.now().toString(36)}`;
}

/** Upsert a tenant pack by slug. Cards missing from the file are left as they are. */
export async function importLibraryPack(raw: unknown): Promise<
  | { ok: true; upserted: number; active: number; draft: number }
  | { ok: false; issues: { path: string; message: string }[] }
> {
  const parsed = parseLibraryPack(raw);
  if (!parsed.ok) return parsed;
  await prisma.$transaction(async (tx) => {
    for (const card of parsed.cards) {
      await upsertLibraryCard(tx, card);
    }
  });
  return {
    ok: true,
    upserted: parsed.cards.length,
    active: parsed.cards.filter((card) => card.status === 'active').length,
    draft: parsed.cards.filter((card) => card.status === 'draft').length,
  };
}

async function upsertLibraryCard(
  tx: Pick<typeof prisma, 'knowledgeArticle'>,
  card: LibraryCardInput,
): Promise<void> {
  const attachmentsJson = toInputJsonValue(card.attachments ?? []);
  await tx.knowledgeArticle.upsert({
    where: { slug: card.slug },
    create: {
      slug: card.slug,
      title: card.title,
      description: card.description,
      body: card.body,
      aliases: card.aliases,
      status: card.status,
      author: 'human',
      attachments: attachmentsJson ?? [],
    },
    update: {
      title: card.title,
      description: card.description,
      body: card.body,
      aliases: card.aliases,
      status: card.status,
      ...(attachmentsJson !== undefined ? { attachments: attachmentsJson } : {}),
    },
  });
}

function normalizeSlugArgs(raw: unknown): string[] {
  if (typeof raw === 'string') return [raw.trim()].filter(Boolean);
  if (!raw || typeof raw !== 'object') return [];
  const record = raw as Record<string, unknown>;
  const many = record.slugs ?? record.slug;
  if (typeof many === 'string') return [many.trim()].filter(Boolean);
  if (!Array.isArray(many)) return [];
  return many
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}
