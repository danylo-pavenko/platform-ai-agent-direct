import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const LIBRARY_ATTACHMENT_MAX = 5;

export type LibraryAttachmentType = 'image' | 'file' | 'link';

export type LibraryAttachment = {
  id: string;
  type: LibraryAttachmentType;
  title: string;
  storageKey?: string;
  url?: string;
  mime?: string;
  bytes?: number;
};

const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https:\/\//i.test(u), 'Only https URLs allowed');

export const libraryAttachmentSchema = z
  .object({
    id: z.string().uuid().optional(),
    type: z.enum(['image', 'file', 'link']),
    title: z.string().trim().min(1).max(120),
    storageKey: z.string().trim().min(1).max(500).optional(),
    url: httpsUrl.optional(),
    mime: z.string().trim().max(120).optional(),
    bytes: z.number().int().positive().max(25 * 1024 * 1024).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type === 'link') {
      if (!val.url) {
        ctx.addIssue({ code: 'custom', message: 'link requires url', path: ['url'] });
      }
      return;
    }
    if (!val.storageKey && !val.url) {
      ctx.addIssue({
        code: 'custom',
        message: 'image/file requires storageKey or url',
        path: ['storageKey'],
      });
    }
  });

export const libraryAttachmentsSchema = z
  .array(libraryAttachmentSchema)
  .max(LIBRARY_ATTACHMENT_MAX)
  .default([]);

export function parseLibraryAttachments(raw: unknown): LibraryAttachment[] {
  if (raw == null) return [];
  const parsed = libraryAttachmentsSchema.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.map((row) => normalizeAttachment(row));
}

export function normalizeAttachment(
  row: z.infer<typeof libraryAttachmentSchema>,
): LibraryAttachment {
  return {
    id: row.id ?? randomUUID(),
    type: row.type,
    title: row.title.trim(),
    ...(row.storageKey ? { storageKey: row.storageKey } : {}),
    ...(row.url ? { url: row.url } : {}),
    ...(row.mime ? { mime: row.mime } : {}),
    ...(typeof row.bytes === 'number' ? { bytes: row.bytes } : {}),
  };
}

export function formatAttachmentsForAgent(attachments: LibraryAttachment[]): string {
  if (attachments.length === 0) return '';
  const lines = [
    'Вкладення для клієнта (не вигадуй URL). Щоб надіслати фото в IG — send_library_asset зі slug і attachment_id:',
  ];
  for (const a of attachments) {
    if (a.type === 'image') {
      lines.push(`- [${a.id}] image «${a.title}» → send_library_asset`);
    } else if (a.type === 'link') {
      lines.push(`- [${a.id}] link «${a.title}»: ${a.url ?? ''}`);
    } else {
      const href = a.url ? ` ${a.url}` : '';
      lines.push(`- [${a.id}] file «${a.title}»${href} → send_library_asset (лінк клієнту)`);
    }
  }
  return lines.join('\n');
}

export function pickLibraryAttachment(
  attachments: LibraryAttachment[],
  attachmentId?: string | null,
): LibraryAttachment | null {
  if (attachments.length === 0) return null;
  if (attachmentId) {
    return attachments.find((a) => a.id === attachmentId) ?? null;
  }
  return attachments.find((a) => a.type === 'image') ?? attachments[0] ?? null;
}
