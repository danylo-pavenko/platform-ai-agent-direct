import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pino from 'pino';
import { config } from '../config.js';
import { invalidateIntegrationConfigCache } from './integration-config.js';
import { invalidateRuntimeConfigCache } from './runtime-config.js';
import { invalidateAgentConfigCache } from './agent-config.js';
import { invalidateCrmRoutingCache } from './crm-routing.js';
import { invalidateCrmWriteCache } from './crm-write.js';
import { invalidateFeatureFlagsCache } from './feature-flags.js';
import { invalidateFollowUpConfigCache } from './follow-up-config.js';
import { invalidateTelegramGroupsCache } from './telegram-groups.js';
import { invalidateCrmFieldMappingsCache } from './crm-field-mappings.js';

const execFileAsync = promisify(execFile);
const log = pino({ name: 'pm2-restart' });

export const PM2_TARGET_IDS = ['api', 'bot', 'sync', 'admin', 'whisper'] as const;
export type Pm2TargetId = (typeof PM2_TARGET_IDS)[number];

/** Default: API + bot + sync — what usually needs fresh DB/env after credential changes. */
export const DEFAULT_PM2_TARGETS: Pm2TargetId[] = ['api', 'bot', 'sync'];

const COOLDOWN_MS = 30_000;
let lastRestartAt = 0;

export type Pm2RestartResult = {
  ok: boolean;
  prefix: string;
  restarted: string[];
  deferred: string[];
  skipped: string[];
  error?: string;
  code?: 'COOLDOWN' | 'PM2_ERROR' | 'INVALID_TARGETS';
  cooldownMsRemaining?: number;
};

/** Build allowlisted PM2 process names for this INSTANCE_ID. */
export function buildPm2AppNames(
  targets: Pm2TargetId[],
  instanceId: string = config.INSTANCE_ID,
): string[] {
  const prefix = instanceId.toUpperCase();
  const unique = [...new Set(targets)];
  return unique
    .filter((t): t is Pm2TargetId => (PM2_TARGET_IDS as readonly string[]).includes(t))
    .map((t) => `${prefix}-${t}`);
}

export function parsePm2Targets(raw: unknown): Pm2TargetId[] | null {
  if (raw === undefined || raw === null) return [...DEFAULT_PM2_TARGETS];
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return [...DEFAULT_PM2_TARGETS];
  const out: Pm2TargetId[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !(PM2_TARGET_IDS as readonly string[]).includes(item)) {
      return null;
    }
    out.push(item as Pm2TargetId);
  }
  return out;
}

/** Drop process-local caches so peers that stay up briefly still see fresher data if any. */
export function flushTenantConfigCaches(): void {
  invalidateIntegrationConfigCache();
  invalidateRuntimeConfigCache();
  invalidateAgentConfigCache();
  invalidateCrmRoutingCache();
  invalidateCrmWriteCache();
  invalidateFeatureFlagsCache();
  invalidateFollowUpConfigCache();
  invalidateTelegramGroupsCache();
  invalidateCrmFieldMappingsCache();
}

async function pm2RestartNames(names: string[], updateEnv: boolean): Promise<void> {
  if (names.length === 0) return;
  const args = ['restart', ...names];
  if (updateEnv) args.push('--update-env');
  log.info({ args }, 'Executing pm2 restart');
  await execFileAsync('pm2', args, {
    timeout: 60_000,
    env: process.env,
  });
}

/**
 * Restart this tenant's PM2 apps (allowlisted names only).
 * Restarts peers first; defers self (`-api`) so the HTTP response can flush.
 */
export async function restartTenantPm2Apps(options?: {
  targets?: Pm2TargetId[];
  updateEnv?: boolean;
  /** Skip cooldown (tests / internal). */
  force?: boolean;
  /** Delay before restarting the current API process (ms). */
  selfRestartDelayMs?: number;
}): Promise<Pm2RestartResult> {
  const targets = options?.targets ?? [...DEFAULT_PM2_TARGETS];
  const updateEnv = options?.updateEnv !== false;
  const prefix = config.INSTANCE_ID.toUpperCase();
  const selfName = `${prefix}-api`;
  const names = buildPm2AppNames(targets);

  if (names.length === 0) {
    return {
      ok: false,
      prefix,
      restarted: [],
      deferred: [],
      skipped: [],
      error: 'No valid PM2 targets',
      code: 'INVALID_TARGETS',
    };
  }

  const now = Date.now();
  if (!options?.force && lastRestartAt && now - lastRestartAt < COOLDOWN_MS) {
    return {
      ok: false,
      prefix,
      restarted: [],
      deferred: [],
      skipped: names,
      error: 'Зачекайте перед наступним перезапуском.',
      code: 'COOLDOWN',
      cooldownMsRemaining: COOLDOWN_MS - (now - lastRestartAt),
    };
  }

  flushTenantConfigCaches();

  const peers = names.filter((n) => n !== selfName);
  const includesSelf = names.includes(selfName);
  const deferred: string[] = includesSelf ? [selfName] : [];

  try {
    if (peers.length > 0) {
      await pm2RestartNames(peers, updateEnv);
    }
    lastRestartAt = Date.now();

    if (includesSelf) {
      const delay = options?.selfRestartDelayMs ?? 800;
      setTimeout(() => {
        void pm2RestartNames([selfName], updateEnv).catch((err) => {
          log.error({ err }, 'Deferred pm2 restart of api failed');
        });
      }, delay);
    }

    return {
      ok: true,
      prefix,
      restarted: peers,
      deferred,
      skipped: [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, names }, 'pm2 restart failed');
    return {
      ok: false,
      prefix,
      restarted: [],
      deferred: [],
      skipped: names,
      error: message,
      code: 'PM2_ERROR',
    };
  }
}

/** Test helper. */
export function _resetPm2RestartCooldownForTests(): void {
  lastRestartAt = 0;
}
