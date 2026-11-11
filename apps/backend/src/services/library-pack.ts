import { z } from 'zod';

/**
 * Tenant-neutral library pack. Any tenant pastes or uploads this JSON
 * in Admin → Бібліотека. Cards upsert by slug. Omitted status becomes active,
 * so a file applies on the next customer turn.
 *
 * {
 *   "version": 1,
 *   "cards": [
 *     {
 *       "slug": "refund-rules",
 *       "title": "Повернення",
 *       "description": "Коли клієнт просить повернути гроші",
 *       "aliases": ["повернення", "refund"],
 *       "body": "Текст, який агент може цитувати.",
 *       "status": "active"
 *     }
 *   ]
 * }
 *
 * A bare array of cards is accepted too.
 */
export const LIBRARY_PACK_VERSION = 1;

const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug: lowercase letters, digits, hyphens');

export const libraryCardInputSchema = z.object({
  slug: slugSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(400),
  body: z.string().trim().min(1).max(30000),
  aliases: z.array(z.string().trim().min(2).max(80)).max(40).default([]),
  status: z.enum(['draft', 'active']).default('active'),
});

export type LibraryCardInput = z.infer<typeof libraryCardInputSchema>;

const packObjectSchema = z.object({
  version: z.literal(LIBRARY_PACK_VERSION).optional(),
  cards: z.array(libraryCardInputSchema).min(1).max(200),
});

const packSchema = z.union([z.array(libraryCardInputSchema).min(1).max(200), packObjectSchema]);

export interface LibraryPackIssue {
  path: string;
  message: string;
}

export function parseLibraryPack(
  raw: unknown,
): { ok: true; cards: LibraryCardInput[] } | { ok: false; issues: LibraryPackIssue[] } {
  const parsed = packSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || 'pack',
        message: issue.message,
      })),
    };
  }
  const cards = Array.isArray(parsed.data) ? parsed.data : parsed.data.cards;
  const seen = new Set<string>();
  const issues: LibraryPackIssue[] = [];
  cards.forEach((card, index) => {
    if (seen.has(card.slug)) {
      issues.push({ path: `cards.${index}.slug`, message: `Повтор slug «${card.slug}»` });
    }
    seen.add(card.slug);
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, cards };
}
