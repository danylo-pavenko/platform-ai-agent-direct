import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { mimeForStorageKey } from '../services/media.js';
import {
  listClientReferencePhotos,
  resolveReferencePhotoKey,
  saveClientReferencePhoto,
} from '../services/reference-photos.js';

const saveSchema = z.object({
  sourceStorageKey: z.string().min(1),
  conversationId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  note: z.string().max(1000).optional(),
  originalName: z.string().max(255).optional(),
});

export async function referencePhotoRoutes(app: FastifyInstance): Promise<void> {
  const authenticateMedia = async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { access_token?: string };
    if (q.access_token && typeof q.access_token === 'string') {
      request.headers.authorization = `Bearer ${q.access_token}`;
    }
    return app.authenticate(request, reply);
  };

  app.get<{ Params: { '*': string } }>(
    '/file/*',
    { onRequest: [authenticateMedia] },
    async (request, reply) => {
      const storageKey = request.params['*'];
      if (!storageKey) return reply.code(400).send({ error: 'Path required' });

      let filePath: string;
      try {
        filePath = resolveReferencePhotoKey(storageKey);
      } catch {
        return reply.code(400).send({ error: 'Invalid path' });
      }

      try {
        const info = await stat(filePath);
        if (!info.isFile()) return reply.code(404).send({ error: 'Not found' });
      } catch {
        return reply.code(404).send({ error: 'Not found' });
      }

      reply.type(mimeForStorageKey(storageKey));
      reply.header('Cache-Control', 'private, max-age=86400');
      return reply.send(createReadStream(filePath));
    },
  );

  app.get<{ Params: { clientId: string } }>(
    '/client/:clientId',
    { onRequest: [app.authenticate] },
    async (request) => {
      const photos = await listClientReferencePhotos(request.params.clientId);
      return { photos };
    },
  );

  app.post<{ Params: { clientId: string } }>(
    '/client/:clientId',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const parsed = saveSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      try {
        const result = await saveClientReferencePhoto({
          clientId: request.params.clientId,
          ...parsed.data,
        });
        return { ok: true, ...result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    },
  );
}
