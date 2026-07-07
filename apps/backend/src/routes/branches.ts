import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  branchInputSchema,
  branchUpdateSchema,
  createBranch,
  deleteBranch,
  fetchBranchesFromCrm,
  getBranchById,
  importBranchesFromCrm,
  listBranches,
  updateBranch,
} from '../services/branches.js';

const importSchema = z.object({
  externalIds: z.array(z.string()).optional(),
  slugPrefix: z.string().max(32).optional(),
});

export async function branchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { onRequest: [app.authenticate] }, async () => {
    const branches = await listBranches();
    return { branches };
  });

  app.get('/crm-candidates', { onRequest: [app.authenticate] }, async () => {
    return fetchBranchesFromCrm();
  });

  app.post('/import-from-crm', { onRequest: [app.authenticate] }, async (request, reply) => {
    const parsed = importSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const result = await importBranchesFromCrm(parsed.data);
    return { ok: true, ...result };
  });

  app.post('/', { onRequest: [app.authenticate] }, async (request, reply) => {
    const parsed = branchInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const branch = await createBranch(parsed.data);
      return { branch };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Unique constraint')) {
        return reply.code(409).send({ error: 'Філія з таким slug вже існує' });
      }
      throw err;
    }
  });

  app.put<{ Params: { id: string } }>(
    '/:id',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const existing = await getBranchById(request.params.id);
      if (!existing) return reply.code(404).send({ error: 'Branch not found' });

      const parsed = branchUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const branch = await updateBranch(request.params.id, parsed.data);
      return { branch };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const existing = await getBranchById(request.params.id);
      if (!existing) return reply.code(404).send({ error: 'Branch not found' });
      await deleteBranch(request.params.id);
      return { ok: true };
    },
  );
}
