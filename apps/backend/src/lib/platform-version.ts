/**
 * Platform release version (source of truth: /VERSION.json at repo root).
 * Bumped by `.cursor/skills/commit-push-bump-version`.
 */
export interface PlatformVersion {
  /** Marketing name — bumped every 10 code increments (1.0 → 1.1 → …). */
  name: string;
  /** Monotonic build code — +1 on every release commit. */
  code: number;
}

export function formatPlatformVersion(v: PlatformVersion): string {
  return `v${v.name} (${v.code})`;
}

export function parsePlatformVersion(raw: unknown): PlatformVersion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  const code = typeof obj.code === 'number' ? obj.code : Number(obj.code);
  if (!name || !Number.isFinite(code) || code < 1) return null;
  return { name, code: Math.floor(code) };
}
