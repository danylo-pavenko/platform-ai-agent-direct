import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { importLibraryPack } from '../services/library.js';

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
});

const patchSchema = writeSchema.partial();

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
      const row = await prisma.knowledgeArticle.create({
        data: {
          ...parsed.data,
          aliases: parsed.data.aliases,
          author: 'human',
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
      const row = await prisma.knowledgeArticle.update({
        where: { id: current.id },
        data: parsed.data,
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
