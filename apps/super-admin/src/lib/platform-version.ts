import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PlatformVersion {
  name: string;
  code: number;
  label: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function versionJsonPath(): string {
  // apps/super-admin/src/lib → ../../../../VERSION.json
  return resolve(__dirname, '..', '..', '..', '..', 'VERSION.json');
}

let cached: PlatformVersion | null = null;

export function getPlatformVersion(): PlatformVersion {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(versionJsonPath(), 'utf8')) as {
      name?: string;
      code?: number;
    };
    const name = String(raw.name ?? '0.0');
    const code = Number(raw.code ?? 0);
    cached = { name, code, label: `v${name} (${code})` };
    return cached;
  } catch {
    cached = { name: '0.0', code: 0, label: 'v0.0 (0)' };
    return cached;
  }
}
