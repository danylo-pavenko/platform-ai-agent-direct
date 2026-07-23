/**
 * follow-up-config.ts
 *
 * Tenant Smart-trigger settings (silence follow-up after bot message).
 * Stored under Setting key `follow_up_config`.
 */
import { prisma } from './prisma.js';

export interface FollowUpConfig {
  enabled: boolean;
  /** Minutes of client silence after last bot outbound before one nudge. */
  delayMinutes: number;
  /** Plain-text template sent to the client (no Claude). */
  template: string;
}

export const FOLLOW_UP_DELAY_MIN = 1;
export const FOLLOW_UP_DELAY_MAX = 1440; // 24h

export const DEFAULT_FOLLOW_UP_TEMPLATE =
  'Вітаю! Чи ще актуальне Ваше питання? Можу допомогти з вибором або оформленням — напишіть, коли буде зручно.';

const DEFAULTS: FollowUpConfig = {
  enabled: false,
  delayMinutes: 30,
  template: DEFAULT_FOLLOW_UP_TEMPLATE,
};

let _cache: FollowUpConfig | null = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 60_000;

export function clampFollowUpDelayMinutes(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.delayMinutes;
  return Math.max(FOLLOW_UP_DELAY_MIN, Math.min(FOLLOW_UP_DELAY_MAX, Math.floor(n)));
}

export function normalizeFollowUpConfig(raw: Partial<FollowUpConfig> | null | undefined): FollowUpConfig {
  const template =
    typeof raw?.template === 'string' && raw.template.trim()
      ? raw.template.trim()
      : DEFAULTS.template;
  return {
    enabled: raw?.enabled === true,
    delayMinutes: clampFollowUpDelayMinutes(raw?.delayMinutes ?? DEFAULTS.delayMinutes),
    template,
  };
}

export async function getFollowUpConfig(): Promise<FollowUpConfig> {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) {
    return _cache;
  }

  const row = await prisma.setting.findUnique({
    where: { key: 'follow_up_config' },
  });

  _cache = normalizeFollowUpConfig((row?.value ?? {}) as Partial<FollowUpConfig>);
  _cacheAt = Date.now();
  return _cache;
}

export function invalidateFollowUpConfigCache(): void {
  _cache = null;
  _cacheAt = 0;
}
