/**
 * Client reference photos — persisted under tenant_knowledge/reference_photos/
 * (outside git, per Linux user). Copied from IG uploads or saved on demand.
 */

import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import { getReferencePhotosDir } from '../lib/paths.js';
import { mimeForStorageKey, resolveStorageKey } from '../services/media.js';

const log = pino({ name: 'reference-photos' });

export function getReferencePhotosRoot(): string {
  return getReferencePhotosDir();
}

function referencePhotosRoot(): string {
  return getReferencePhotosRoot();
}

/** Relative key under reference_photos root, e.g. `{clientId}/2026/07/uuid.jpg`. */
export function toReferencePhotoKey(absolutePath: string): string {
  const root = referencePhotosRoot();
  const rel = relative(root, resolve(absolutePath));
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new Error('Path is outside reference photos directory');
  }
  return rel.split(sep).join('/');
}

export function resolveReferencePhotoKey(storageKey: string): string {
  const normalized = storageKey.replace(/^(\.\.(\/|\\|$))+/, '');
  const abs = resolve(referencePhotosRoot(), normalized);
  const root = referencePhotosRoot();
  if (!abs.startsWith(root + sep) && abs !== root) {
    throw new Error('Invalid reference photo storage key');
  }
  return abs;
}

export interface SaveReferencePhotoInput {
  clientId: string;
  conversationId?: string;
  branchId?: string;
  /** Existing IG upload storage key (under UPLOADS_DIR). */
  sourceStorageKey: string;
  note?: string;
  originalName?: string;
}

/**
 * Copy a downloaded IG media file into the tenant reference-photos folder
 * and create a DB row for admin / CRM attachment workflows.
 */
export async function saveClientReferencePhoto(
  input: SaveReferencePhotoInput,
): Promise<{ id: string; storageKey: string }> {
  const sourcePath = resolveStorageKey(input.sourceStorageKey);
  const sourceStat = await stat(sourcePath);
  const ext = sourcePath.includes('.') ? sourcePath.slice(sourcePath.lastIndexOf('.')) : '.jpg';

  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const filename = `${randomUUID()}${ext}`;

  const destDir = join(referencePhotosRoot(), input.clientId, yyyy, mm);
  await mkdir(destDir, { recursive: true });

  const destPath = join(destDir, filename);
  await copyFile(sourcePath, destPath);

  const storageKey = toReferencePhotoKey(destPath);
  const mimeType = mimeForStorageKey(storageKey);

  const row = await prisma.clientReferencePhoto.create({
    data: {
      clientId: input.clientId,
      conversationId: input.conversationId ?? null,
      branchId: input.branchId ?? null,
      storageKey,
      originalName: input.originalName ?? null,
      note: input.note ?? null,
      mimeType,
      sizeBytes: sourceStat.size,
    },
  });

  log.info(
    { id: row.id, clientId: input.clientId, storageKey, sizeBytes: sourceStat.size },
    'Reference photo saved',
  );

  return { id: row.id, storageKey };
}

export async function listClientReferencePhotos(clientId: string) {
  return prisma.clientReferencePhoto.findMany({
    where: { clientId },
    orderBy: { createdAt: 'desc' },
    include: {
      branch: { select: { id: true, slug: true, displayName: true } },
    },
  });
}
