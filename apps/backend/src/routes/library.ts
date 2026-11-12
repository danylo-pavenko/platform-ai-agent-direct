import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, toInputJsonValue } from '../lib/prisma.js';
import {
  LIBRARY_ATTACHMENT_MAX,
  libraryAttachmentsSchema,
  normalizeAttachment,
  parseLibraryAttachments,
} from '../lib/library-attachments.js';
import { importLibraryPack } from '../services/library.js';
import { persistLibraryUpload } from '../services/library-assets.js';

const SLUG = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug: lowercase letters, digits, hyphens');

const aliasesSchema = z.array(z.string().trim().min(2).max(80)).max(40);

const writeSchema = z.object({
  slug: SLUG,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(400),
  body: z.string().trim().min(1).max(30000),
  aliases: aliasesSchema.default([]),
  status: z.enum(['draft', 'active']).default('draft'),
  attachments: libraryAttachmentsSchema.optional(),
});

const patchSchema = writeSchema.partial();

const uploadBodySchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  type: z.enum(['image', 'file']).default('image'),
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().max(120).optional(),
  dataBase64: z.string().min(1),
});

const linkBodySchema = z.object({
  type: z.literal('link'),
  title: z.string().trim().min(1).max(120),
  url: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https:\/\//i.test(u), 'https only'),
});

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { onRequest: [app.authenticate, app.requireOwner] }, async () => {
    const data = await prisma.knowledgeArticle.findMany({
      orderBy: [{ status: 'asc' }, { title: 'asc' }],
    });
    return { data };
  });

  app.get<{ Params: { id: string } }>(
    '/:id',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request, reply) => {
      const row = await prisma.knowledgeArticle.findUnique({
        where: { id: request.params.id },
      });
      if (!row) return reply.code(404).send({ error: 'Card not found' });
      return row;
    },
  );

  app.post(
    '/',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request, reply) => {
      const parsed = writeSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid card', details: parsed.error.flatten() });
      }
      const existing = await prisma.knowledgeArticle.findUnique({
        where: { slug: parsed.data.slug },
        select: { id: true },
      });
      if (existing) return reply.code(409).send({ error: 'Slug already exists' });
      const attachments = (parsed.data.attachments ?? []).map((a) => normalizeAttachment(a));
      const row = await prisma.knowledgeArticle.create({
        data: {
          slug: parsed.data.slug,
          title: parsed.data.title,
          description: parsed.data.description,
          body: parsed.data.body,
          aliases: parsed.data.aliases,
          status: parsed.data.status,
          author: 'human',
          attachments: toInputJsonValue(attachments) ?? [],
        },
      });
      return reply.code(201).send(row);
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/:id',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request, reply) => {
      const parsed = patchSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid card', details: parsed.error.flatten() });
      }
      const current = await prisma.knowledgeArticle.findUnique({
        where: { id: request.params.id },
      });
      if (!current) return reply.code(404).send({ error: 'Card not found' });
      if (parsed.data.slug && parsed.data.slug !== current.slug) {
        const clash = await prisma.knowledgeArticle.findUnique({
          where: { slug: parsed.data.slug },
          select: { id: true },
        });
        if (clash) return reply.code(409).send({ error: 'Slug already exists' });
      }
      const { attachments: rawAttachments, ...rest } = parsed.data;
      const data: Record<string, unknown> = { ...rest };
      if (rawAttachments !== undefined) {
        data.attachments = toInputJsonValue(rawAttachments.map((a) => normalizeAttachment(a)));
      }
      const row = await prisma.knowledgeArticle.update({
        where: { id: current.id },
        data,
      });
      return row;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request, reply) => {
      const current = await prisma.knowledgeArticle.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (!current) return reply.code(404).send({ error: 'Card not found' });
      await prisma.knowledgeArticle.delete({ where: { id: current.id } });
      return reply.code(204).send();
    },
  );

  /** Upload image/file (base64 JSON — no multipart dependency). */
  app.post<{ Params: { id: string } }>(
    '/:id/attachments/upload',
    {
      onRequest: [app.authenticate, app.requireOwner],
      bodyLimit: 14 * 1024 * 1024,
    },
    async (request, reply) => {
      const parsed = uploadBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid upload', details: parsed.error.flatten() });
      }
      const article = await prisma.knowledgeArticle.findUnique({
        where: { id: request.params.id },
      });
      if (!article) return reply.code(404).send({ error: 'Card not found' });

      const current = parseLibraryAttachments(article.attachments);
      if (current.length >= LIBRARY_ATTACHMENT_MAX) {
        return reply.code(400).send({ error: `Максимум ${LIBRARY_ATTACHMENT_MAX} вкладень` });
      }

      let buffer: Buffer;
      try {
        buffer = Buffer.from(parsed.data.dataBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
      } catch {
        return reply.code(400).send({ error: 'Invalid base64' });
      }
      if (buffer.byteLength === 0) {
        return reply.code(400).send({ error: 'Empty file' });
      }

      try {
        const saved = await persistLibraryUpload({
          buffer,
          filename: parsed.data.filename,
          contentType: parsed.data.contentType,
        });
        const type =
          parsed.data.type === 'file' || saved.mime === 'application/pdf' ? 'file' : 'image';
        const attachment = normalizeAttachment({
          type,
          title: parsed.data.title || parsed.data.filename.replace(/\.[^.]+$/, ''),
          storageKey: saved.storageKey,
          mime: saved.mime,
          bytes: saved.bytes,
        });
        const next = [...current, attachment];
        const row = await prisma.knowledgeArticle.update({
          where: { id: article.id },
          data: { attachments: toInputJsonValue(next) ?? [] },
        });
        return { attachment, card: row };
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : 'Upload failed',
        });
      }
    },
  );

  /** Add https link attachment. */
  app.post<{ Params: { id: string } }>(
    '/:id/attachments/link',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request, reply) => {
      const parsed = linkBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid link', details: parsed.error.flatten() });
      }
      const article = await prisma.knowledgeArticle.findUnique({
        where: { id: request.params.id },
      });
      if (!article) return reply.code(404).send({ error: 'Card not found' });
      const current = parseLibraryAttachments(article.attachments);
      if (current.length >= LIBRARY_ATTACHMENT_MAX) {
        return reply.code(400).send({ error: `Максимум ${LIBRARY_ATTACHMENT_MAX} вкладень` });
      }
      const attachment = normalizeAttachment(parsed.data);
      const next = [...current, attachment];
      const row = await prisma.knowledgeArticle.update({
        where: { id: article.id },
        data: { attachments: toInputJsonValue(next) ?? [] },
      });
      return { attachment, card: row };
    },
  );

  app.delete<{ Params: { id: string; attachmentId: string } }>(
    '/:id/attachments/:attachmentId',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request, reply) => {
      const article = await prisma.knowledgeArticle.findUnique({
        where: { id: request.params.id },
      });
      if (!article) return reply.code(404).send({ error: 'Card not found' });
      const current = parseLibraryAttachments(article.attachments);
      const next = current.filter((a) => a.id !== request.params.attachmentId);
      if (next.length === current.length) {
        return reply.code(404).send({ error: 'Attachment not found' });
      }
      const row = await prisma.knowledgeArticle.update({
        where: { id: article.id },
        data: { attachments: toInputJsonValue(next) ?? [] },
      });
      return row;
    },
  );

  /**
   * Apply a tenant JSON pack. Upsert by slug. Unknown cards stay.
   * Status defaults to active, so the file is live on the next turn.
   */
  app.post(
    '/import',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request, reply) => {
      const result = await importLibraryPack(request.body);
      if (!result.ok) {
        return reply.code(400).send({ error: 'Некоректний JSON карток', issues: result.issues });
      }
      return result;
    },
  );
}
