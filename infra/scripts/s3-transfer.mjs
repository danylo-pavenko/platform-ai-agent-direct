#!/usr/bin/env node
/**
 * s3-transfer.mjs — put/get S3/MinIO objects via @aws-sdk/client-s3.
 * Fallback when awscli / mc are not installed on the SA/worker host.
 *
 * Usage:
 *   node s3-transfer.mjs put <localFile> <storageKey>
 *   node s3-transfer.mjs get <storageKey> <localFile>
 *
 * Env (same as backup-tenant-db.sh):
 *   S3_ENDPOINT S3_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
 *   S3_REGION (default us-east-1)
 *   S3_FORCE_PATH_STYLE (default true)
 */
import { createRequire } from 'node:module';
import { createWriteStream, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');

function loadS3Sdk() {
  const candidates = [
    join(repoRoot, 'apps/super-admin/package.json'),
    join(repoRoot, 'package.json'),
  ];
  let lastErr;
  for (const pkg of candidates) {
    try {
      const require = createRequire(pkg);
      return require('@aws-sdk/client-s3');
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `@aws-sdk/client-s3 not found under ${repoRoot} — run npm install -w apps/super-admin. Last: ${lastErr}`,
  );
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v?.trim()) {
    console.error(`ERROR: ${name} required`);
    process.exit(1);
  }
  return v.trim();
}

function makeClient(S3Client) {
  const forcePathStyle = !['0', 'false', 'no'].includes(
    String(process.env.S3_FORCE_PATH_STYLE ?? 'true').toLowerCase(),
  );
  return new S3Client({
    region: process.env.S3_REGION?.trim() || 'us-east-1',
    endpoint: requireEnv('S3_ENDPOINT').replace(/\/$/, ''),
    forcePathStyle,
    credentials: {
      accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
    },
  });
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (!cmd || !a || !b || !['put', 'get'].includes(cmd)) {
    console.error('Usage: s3-transfer.mjs put <localFile> <storageKey>');
    console.error('       s3-transfer.mjs get <storageKey> <localFile>');
    process.exit(2);
  }

  const { S3Client, PutObjectCommand, GetObjectCommand } = loadS3Sdk();
  const client = makeClient(S3Client);
  const bucket = requireEnv('S3_BUCKET');

  try {
    if (cmd === 'put') {
      const body = readFileSync(a);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: b,
          Body: body,
        }),
      );
      console.error(`[s3-transfer] put s3://${bucket}/${b} (${body.length} bytes)`);
      return;
    }

    const res = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: a,
      }),
    );
    if (!res.Body) {
      throw new Error('Empty GetObject body');
    }
    const bodyStream =
      typeof res.Body.transformToWebStream === 'function'
        ? Readable.fromWeb(res.Body.transformToWebStream())
        : res.Body;
    await pipeline(bodyStream, createWriteStream(b));
    console.error(`[s3-transfer] get s3://${bucket}/${a} → ${b}`);
  } finally {
    client.destroy();
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
