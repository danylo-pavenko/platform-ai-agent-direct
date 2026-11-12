import { z } from 'zod';
import {
  libraryAttachmentSchema,
  normalizeAttachment,
  type LibraryAttachment,
} from '../lib/library-attachments.js';

/**
 * Tenant-neutral library pack. Any tenant pastes or uploads this JSON
 * in Admin → Бібліотека. Cards upsert by slug. Omitted status becomes active.
 *
 * version 1 — text cards only
 * version 2 — optional attachments (image/file/link); external https urls preferred in packs
 */
export const LIBRARY_PACK_VERSION = 2;

const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug: lowercase letters, digits, hyphens');

const attachmentPackSchema = libraryAttachmentSchema.transform((row) => {
  const normalized = normalizeAttachment(row);
  // Packs should not rely on local storageKey across tenants — drop unless url present.
  if (normalized.storageKey && !normalized.url) {
    const { storageKey: _sk, ...rest } = normalized;
    return rest as LibraryAttachment;
  }
  return normalized;
});

export const libraryCardInputSchema = z.object({
  slug: slugSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(400),
  body: z.string().trim().min(1).max(30000),
  aliases: z.array(z.string().trim().min(2).max(80)).max(40).default([]),
  status: z.enum(['draft', 'active']).default('active'),
  attachments: z.array(attachmentPackSchema).max(5).default([]),
});

export type LibraryCardInput = z.infer<typeof libraryCardInputSchema>;

const packObjectSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]).optional(),
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
