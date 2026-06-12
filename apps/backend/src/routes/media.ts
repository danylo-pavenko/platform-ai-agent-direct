import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveStorageKey } from '../services/media.js';

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
};

function mimeForPath(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

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

      reply.type(mimeForPath(filePath));
      reply.header('Cache-Control', 'private, max-age=86400');
      return reply.send(createReadStream(filePath));
    },
  );
}
