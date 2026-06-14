import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mimeForStorageKey, resolveStorageKey } from '../services/media.js';

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  /** Allow <img src> with ?access_token=… in addition to Authorization header. */
  const authenticateMedia = async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { access_token?: string };
    if (q.access_token && typeof q.access_token === 'string') {
      request.headers.authorization = `Bearer ${q.access_token}`;
    }
    return app.authenticate(request, reply);
  };

  app.get<{
    Params: { '*': string };
  }>(
    '/*',
    { onRequest: [authenticateMedia] },
    async (request, reply) => {
      const storageKey = request.params['*'];
      if (!storageKey) {
        return reply.code(400).send({ error: 'Media path required' });
      }

      let filePath: string;
      try {
        filePath = resolveStorageKey(storageKey);
      } catch {
        return reply.code(400).send({ error: 'Invalid media path' });
      }

      try {
        const info = await stat(filePath);
        if (!info.isFile()) {
          return reply.code(404).send({ error: 'Not found' });
        }
      } catch {
        return reply.code(404).send({ error: 'Not found' });
      }

      reply.type(mimeForStorageKey(storageKey));
      reply.header('Cache-Control', 'private, max-age=86400');
      return reply.send(createReadStream(filePath));
    },
  );
}
