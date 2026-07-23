import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatPlatformVersion,
  parsePlatformVersion,
  type PlatformVersion,
} from './platform-version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve VERSION.json from repo root (works from src/ and dist/). */
function versionJsonPath(): string {
  // apps/backend/src/lib → ../../../../VERSION.json
  // apps/backend/dist/lib → ../../../../VERSION.json
  return resolve(__dirname, '..', '..', '..', '..', 'VERSION.json');
}

let cached: PlatformVersion | null = null;

export function getPlatformVersion(): PlatformVersion {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(versionJsonPath(), 'utf8')) as unknown;
    const parsed = parsePlatformVersion(raw);
    if (parsed) {
      cached = parsed;
      return parsed;
    }
  } catch {
    // fall through
  }
  cached = { name: '0.0', code: 0 };
  return cached;
}

export function getPlatformVersionLabel(): string {
  return formatPlatformVersion(getPlatformVersion());
}

export type { PlatformVersion };
export { formatPlatformVersion, parsePlatformVersion };
