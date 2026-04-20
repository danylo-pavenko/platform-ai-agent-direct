import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

export async function promptRoutes(app: FastifyInstance): Promise<void> {
  // GET / - List all prompt versions
  app.get('/', { onRequest: [app.authenticate] }, async () => {
    const data = await prisma.systemPrompt.findMany({
      orderBy: { version: 'desc' },
    });

    return { data };
  });

  // GET /:id - Get single prompt by id
  app.get<{
    Params: { id: string };
  }>('/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const prompt = await prisma.systemPrompt.findUnique({
      where: { id: request.params.id },
    });

    if (!prompt) {
      return reply.code(404).send({ error: 'Prompt not found' });
    }

    return prompt;
  });

  // POST / - Create new prompt version
  app.post<{
    Body: { content: string; changeSummary: string };
  }>('/', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { content, changeSummary } = request.body ?? {};

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return reply.code(400).send({ error: 'Content is required' });
    }

    if (!changeSummary || typeof changeSummary !== 'string' || changeSummary.trim().length === 0) {
      return reply.code(400).send({ error: 'Change summary is required' });
    }

    // Auto-increment version
    const maxVersion = await prisma.systemPrompt.aggregate({
      _max: { version: true },
    });
    const nextVersion = (maxVersion._max.version ?? 0) + 1;

    const prompt = await prisma.systemPrompt.create({
      data: {
        version: nextVersion,
        content: content.trim(),
        author: 'human',
        authorUserId: request.user.id,
        changeSummary: changeSummary.trim(),
        isActive: false,
      },
    });

    return reply.code(201).send(prompt);
  });

  // POST /:id/activate - Activate a prompt
  app.post<{
    Params: { id: string };
  }>('/:id/activate', { onRequest: [app.authenticate] }, async (request, reply) => {
    const prompt = await prisma.systemPrompt.findUnique({
      where: { id: request.params.id },
    });

    if (!prompt) {
      return reply.code(404).send({ error: 'Prompt not found' });
    }

    const activated = await prisma.$transaction(async (tx) => {
      // Deactivate all prompts
      await tx.systemPrompt.updateMany({
        data: { isActive: false },
      });

      // Activate the selected one
      return tx.systemPrompt.update({
        where: { id: request.params.id },
        data: { isActive: true },
      });
    });

    return activated;
  });
}
