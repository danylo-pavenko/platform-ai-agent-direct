import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { parseLibraryAttachments } from '../lib/library-attachments.js';
import { verifyLibraryAssetToken } from '../services/library-assets.js';
import { mimeForStorageKey, resolveStorageKey } from '../services/media.js';

/**
 * Unauthenticated (signed) asset delivery for Meta Graph sendImage.
 * Only active cards; requires HMAC query `t`.
 */
export async function publicLibraryAssetRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { articleId: string; attachmentId: string };
    Querystring: { t?: string };
  }>('/library-assets/:articleId/:attachmentId', async (request, reply) => {
    const { articleId, attachmentId } = request.params;
    const token = typeof request.query.t === 'string' ? request.query.t : '';
    if (!token || !verifyLibraryAssetToken(articleId, attachmentId, token)) {
      return reply.code(403).send({ error: 'Invalid or expired token' });
    }

    const article = await prisma.knowledgeArticle.findUnique({
      where: { id: articleId },
      select: { status: true, attachments: true },
    });
    if (!article || article.status !== 'active') {
      return reply.code(404).send({ error: 'Not found' });
    }

    const attachment = parseLibraryAttachments(article.attachments).find(
      (a) => a.id === attachmentId,
    );
    if (!attachment?.storageKey) {
      return reply.code(404).send({ error: 'Attachment not found' });
    }

    let filePath: string;
    try {
      filePath = resolveStorageKey(attachment.storageKey);
    } catch {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    try {
      const info = await stat(filePath);
      if (!info.isFile()) return reply.code(404).send({ error: 'Not found' });
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }

    const mime = attachment.mime || mimeForStorageKey(attachment.storageKey);
    reply.type(mime);
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(createReadStream(filePath));
  });
}
