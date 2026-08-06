import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { bumpPromptRuntimeGeneration } from '../services/prompt-runtime.js';

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
    Body: { content: string; changeSummary?: string | null };
  }>('/', { onRequest: [app.authenticate, app.requireOwner] }, async (request, reply) => {
    const { content, changeSummary } = request.body ?? {};

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return reply.code(400).send({ error: 'Content is required' });
    }

    const normalizedSummary =
      typeof changeSummary === 'string' && changeSummary.trim().length > 0
        ? changeSummary.trim()
        : null;

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
        changeSummary: normalizedSummary,
        isActive: false,
      },
    });

    return reply.code(201).send(prompt);
  });

  // POST /:id/activate - Activate a prompt
  app.post<{
    Params: { id: string };
  }>('/:id/activate', { onRequest: [app.authenticate, app.requireOwner] }, async (request, reply) => {
    const prompt = await prisma.systemPrompt.findUnique({
      where: { id: request.params.id },
    });

    if (!prompt) {
      return reply.code(404).send({ error: 'Prompt not found' });
    }

    const previouslyActive = await prisma.systemPrompt.findFirst({
      where: { isActive: true },
      select: { id: true, version: true },
    });

    const { activated, runtimeGeneration } = await prisma.$transaction(async (tx) => {
      await tx.systemPrompt.updateMany({
        data: { isActive: false },
      });

      const activatedRow = await tx.systemPrompt.update({
        where: { id: request.params.id },
        data: { isActive: true },
      });

      const generation = await bumpPromptRuntimeGeneration(tx);

      await tx.auditLog.create({
        data: {
          actor: request.user.username,
          action: 'prompt_activated',
          entityType: 'system_prompt',
          entityId: activatedRow.id,
          payload: {
            version: activatedRow.version,
            runtimeGeneration: generation,
            previousId: previouslyActive?.id ?? null,
            previousVersion: previouslyActive?.version ?? null,
          },
        },
      });

      return { activated: activatedRow, runtimeGeneration: generation };
    });

    return {
      ...activated,
      runtimeGeneration,
    };
  });
}
