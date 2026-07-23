/**
 * follow-up-config.ts
 *
 * Tenant Smart-trigger (remarketing): one silence follow-up after bot message.
 * Stored under Setting key `follow_up_config`. Delay is in hours only.
 */
import { prisma } from './prisma.js';

export interface FollowUpConfig {
  enabled: boolean;
  /** Hours of client silence after last bot outbound before one nudge. */
  delayHours: number;
  /** Plain-text template sent to the client (no Claude). */
  template: string;
}

/** Minimum delay: 1 hour. */
export const FOLLOW_UP_DELAY_HOURS_MIN = 1;
/** Maximum delay: 7 days. */
export const FOLLOW_UP_DELAY_HOURS_MAX = 168;
/** Default: 3 days. */
export const FOLLOW_UP_DELAY_HOURS_DEFAULT = 72;

export const DEFAULT_FOLLOW_UP_TEMPLATE =
  'Вітаю! Чи ще актуальне Ваше питання? Можу допомогти з вибором або оформленням — напишіть, коли буде зручно.';

const DEFAULTS: FollowUpConfig = {
  enabled: false,
  delayHours: FOLLOW_UP_DELAY_HOURS_DEFAULT,
  template: DEFAULT_FOLLOW_UP_TEMPLATE,
};

let _cache: FollowUpConfig | null = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 60_000;

export function clampFollowUpDelayHours(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.delayHours;
  return Math.max(
    FOLLOW_UP_DELAY_HOURS_MIN,
    Math.min(FOLLOW_UP_DELAY_HOURS_MAX, Math.floor(n)),
  );
}

/**
 * Prefer `delayHours`. Legacy `delayMinutes` (pre-remarketing) is ignored —
 * tenants fall back to the 3-day default until they save again.
 */
export function normalizeFollowUpConfig(
  raw: (Partial<FollowUpConfig> & { delayMinutes?: number }) | null | undefined,
): FollowUpConfig {
  const template =
    typeof raw?.template === 'string' && raw.template.trim()
      ? raw.template.trim()
      : DEFAULTS.template;

  const delaySource =
    raw && typeof raw.delayHours === 'number' && Number.isFinite(raw.delayHours)
      ? raw.delayHours
      : DEFAULTS.delayHours;

  return {
    enabled: raw?.enabled === true,
    delayHours: clampFollowUpDelayHours(delaySource),
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

  _cache = normalizeFollowUpConfig(
    (row?.value ?? {}) as Partial<FollowUpConfig> & { delayMinutes?: number },
  );
  _cacheAt = Date.now();
  return _cache;
}

export function invalidateFollowUpConfigCache(): void {
  _cache = null;
  _cacheAt = 0;
}
