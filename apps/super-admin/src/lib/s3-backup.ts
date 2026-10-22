/**
 * Per-worker S3 config helpers + AWS SDK client for list/test.
 */
import {
  S3Client,
  HeadBucketCommand,
  ListObjectsV2Command,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { Server } from '../generated/prisma/client.js';
import { decryptSecret, maskSecretLast4 } from './secret-box.js';

export type WorkerS3Config = {
  endpoint: string;
  bucket: string;
  region: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
};

export type WorkerS3Public = {
  s3Enabled: boolean;
  s3Endpoint: string | null;
  s3Bucket: string | null;
  s3Region: string;
  s3ForcePathStyle: boolean;
  s3AccessKey: string | null;
  s3AccessKeyLast4: string | null;
  secretConfigured: boolean;
  s3LastTestAt: string | null;
  s3LastTestOk: boolean | null;
};

export function publicS3FromServer(row: Server): WorkerS3Public {
  return {
    s3Enabled: row.s3Enabled,
    s3Endpoint: row.s3Endpoint,
    s3Bucket: row.s3Bucket,
    s3Region: row.s3Region || 'us-east-1',
    s3ForcePathStyle: row.s3ForcePathStyle,
    s3AccessKey: row.s3AccessKey,
    s3AccessKeyLast4: maskSecretLast4(row.s3AccessKey),
    secretConfigured: Boolean(row.s3SecretEnc),
    s3LastTestAt: row.s3LastTestAt?.toISOString() ?? null,
    s3LastTestOk: row.s3LastTestOk,
  };
}

export function resolveWorkerS3Config(row: Server): WorkerS3Config | null {
  if (
    !row.s3Enabled ||
    !row.s3Endpoint?.trim() ||
    !row.s3Bucket?.trim() ||
    !row.s3AccessKey?.trim() ||
    !row.s3SecretEnc?.trim()
  ) {
    return null;
  }
  let secretAccessKey: string;
  try {
    secretAccessKey = decryptSecret(row.s3SecretEnc);
  } catch {
    return null;
  }
  return {
    endpoint: row.s3Endpoint.replace(/\/$/, ''),
    bucket: row.s3Bucket.trim(),
    region: row.s3Region || 'us-east-1',
    forcePathStyle: row.s3ForcePathStyle !== false,
    accessKeyId: row.s3AccessKey.trim(),
    secretAccessKey,
  };
}

export function s3ConfigToEnv(cfg: WorkerS3Config): Record<string, string> {
  return {
    S3_ENDPOINT: cfg.endpoint,
    S3_BUCKET: cfg.bucket,
    S3_REGION: cfg.region,
    S3_FORCE_PATH_STYLE: cfg.forcePathStyle ? 'true' : 'false',
    AWS_ACCESS_KEY_ID: cfg.accessKeyId,
    AWS_SECRET_ACCESS_KEY: cfg.secretAccessKey,
    AWS_DEFAULT_REGION: cfg.region,
  };
}

function makeClient(cfg: WorkerS3Config): S3Client {
  const conf: S3ClientConfig = {
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  };
  return new S3Client(conf);
}

export async function testWorkerS3(cfg: WorkerS3Config): Promise<{ ok: boolean; error?: string }> {
  const client = makeClient(cfg);
  try {
    await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    client.destroy();
  }
}

export async function listTenantBackupKeys(
  cfg: WorkerS3Config,
  instanceId: string,
): Promise<Array<{ key: string; size: number; lastModified: string }>> {
  const client = makeClient(cfg);
  const prefix = `tenants/${instanceId}/`;
  const out: Array<{ key: string; size: number; lastModified: string }> = [];
  try {
    let token: string | undefined;
    do {
      const res = await client.send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of res.Contents || []) {
        if (!obj.Key || obj.Key.endsWith('/')) continue;
        if (obj.Key.endsWith('latest.json')) continue;
        out.push({
          key: obj.Key,
          size: obj.Size ?? 0,
          lastModified: (obj.LastModified || new Date()).toISOString(),
        });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  } finally {
    client.destroy();
  }
  out.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  return out;
}

/** Parse STORAGE_KEY=... and SHA256=... from backup script stdout. */
export function parseBackupScriptMarkers(logText: string): {
  storageKey?: string;
  sha256?: string;
  bytes?: number;
} {
  const key = logText.match(/^STORAGE_KEY=(.+)$/m)?.[1]?.trim();
  const sha = logText.match(/^SHA256=(.+)$/m)?.[1]?.trim();
  const bytesRaw = logText.match(/^BYTES=(.+)$/m)?.[1]?.trim();
  const bytes = bytesRaw && /^\d+$/.test(bytesRaw) ? Number(bytesRaw) : undefined;
  return { storageKey: key, sha256: sha, bytes };
}
