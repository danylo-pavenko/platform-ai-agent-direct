#!/usr/bin/env node
/**
 * merge-tenant-env.mjs — Upsert KEY=VALUE pairs into a tenant .env file.
 * Usage: node merge-tenant-env.mjs <env-file> <base64-json-patch>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const envPath = process.argv[2];
const patchB64 = process.argv[3];

if (!envPath || !patchB64) {
  process.stderr.write('Usage: merge-tenant-env.mjs <env-file> <base64-json-patch>\n');
  process.exit(1);
}

const patch = JSON.parse(Buffer.from(patchB64, 'base64').toString('utf8'));
let env = readFileSync(envPath, 'utf8');

for (const [key, value] of Object.entries(patch)) {
  const line = `${key}=${String(value)}`;
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}=.*`, 'm');
  env = re.test(env) ? env.replace(re, line) : `${env.trimEnd()}\n${line}\n`;
}

writeFileSync(envPath, env);
