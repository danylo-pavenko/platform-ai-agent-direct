import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { checkIgConnectionStatus } from './ig-connection.js';
import {
  claudeAuthCheck,
  claudeHealthCheck,
  probeAgentLatency,
} from './claude.js';
import { fetchClaudeUsageSnapshot } from './claude-usage.js';
import { loadClaudeUsageSnapshot } from './claude-usage-monitor.js';
import { getCrmAdapter } from './crm/registry.js';
import { isCrmWriteReady } from '../lib/crm-write.js';

export type HealthCheckStatus = 'ok' | 'not_configured' | 'error';

export interface HealthCheckItem {
  id: 'instagram' | 'claude' | 'claude_usage' | 'crm' | 'crm_write' | 'agent_latency' | 'stt';
  label: string;
  status: HealthCheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface TenantHealthCheckResult {
  checkedAt: string;
  overall: 'ok' | 'degraded';
  checks: HealthCheckItem[];
}

async function checkInstagram(): Promise<HealthCheckItem> {
  const label = 'Instagram';
  const { meta } = await getIntegrationConfig();

  if (!config.FACEBOOK_APP_ID || !config.FACEBOOK_APP_SECRET) {
    return {
      id: 'instagram',
      label,
      status: 'not_configured',
      message: 'FACEBOOK_APP_ID / FACEBOOK_APP_SECRET не задані в .env',
    };
  }

  if (!meta.pageAccessToken) {
    const row = await prisma.setting.findUnique({ where: { key: 'integration_meta' } });
    const rawToken = (row?.value as { pageAccessToken?: string } | undefined)?.pageAccessToken;
    const tokenCorrupted =
      typeof rawToken === 'string' &&
      rawToken.length > 0 &&
      (rawToken.includes('•') || !/^[\x00-\xFF]*$/.test(rawToken));

    return {
      id: 'instagram',
      label,
      status: 'not_configured',
      message: tokenCorrupted
        ? 'Page Access Token пошкоджено — повторіть «Авторизуватись через Facebook»'
        : 'OAuth не виконано — натисніть «Авторизуватись через Facebook»',
    };
  }

  const status = await checkIgConnectionStatus();
  if (!status.connected) {
    return {
      id: 'instagram',
      label,
      status: 'error',
      message: status.error ?? 'Підключення не працює',
      details: { pageId: meta.pageId || null, igUserId: meta.igUserId || null },
    };
  }

  const username = status.igAccount?.username;
  let message = username
    ? `Підключено @${username}`
    : `Підключено (IG ID: ${status.igAccount?.id ?? meta.igUserId})`;
  if (status.webhook && !status.webhook.subscribed) {
    message += ' · webhook не повністю підписано';
  }
  return {
    id: 'instagram',
    label,
    status: 'ok',
    message,
    details: {
      igUserId: status.igAccount?.id ?? meta.igUserId,
      igUsername: username ?? meta.igUsername,
      pageId: status.page?.id ?? meta.pageId,
      igSource: status.igAccount?.source,
      conversationsSample: status.conversationsCount,
      webhookSubscribed: status.webhook?.subscribed,
      webhookFields: status.webhook?.fields,
      warnings: status.warnings,
    },
  };
}

async function checkClaude(): Promise<HealthCheckItem> {
  const label = 'Claude CLI';
  const binary = await claudeHealthCheck();

  if (!binary.ok) {
    return {
      id: 'claude',
      label,
      status: 'error',
      message: binary.error ?? 'Claude CLI недоступний',
      details: { path: binary.path },
    };
  }

  const auth = await claudeAuthCheck();
  if (!auth.ok) {
    return {
      id: 'claude',
      label,
      status: 'error',
      message: auth.error ?? 'Claude не авторизовано',
      details: { path: binary.path, version: binary.version },
    };
  }

  return {
    id: 'claude',
    label,
    status: 'ok',
    message: `Підключено (${binary.version ?? 'ok'})`,
    details: { path: binary.path, version: binary.version },
  };
}

async function checkClaudeUsage(): Promise<HealthCheckItem> {
  const label = 'Claude ліміти (підписка)';

  let snap = await loadClaudeUsageSnapshot();
  const maxAgeMs = (config.CLAUDE_USAGE_CHECK_INTERVAL_MIN + 5) * 60 * 1000;
  const stale =
    !snap || Date.now() - new Date(snap.checkedAt).getTime() > maxAgeMs;

  if (stale) {
    snap = await fetchClaudeUsageSnapshot();
  }

  if (!snap || snap.status === 'unavailable') {
    return {
      id: 'claude_usage',
      label,
      status: 'error',
      message: snap?.message ?? 'Ліміти Claude недоступні',
      details: {
        checkedAt: snap?.checkedAt ?? null,
        error: snap?.error ?? null,
      },
    };
  }

  if (snap.status === 'exhausted') {
    return {
      id: 'claude_usage',
      label,
      status: 'error',
      message: snap.message,
      details: {
        checkedAt: snap.checkedAt,
        worstPercent: snap.worstPercent,
        buckets: snap.buckets,
        subscriptionType: snap.subscriptionType,
      },
    };
  }

  if (snap.status === 'warning') {
    return {
      id: 'claude_usage',
      label,
      status: 'error',
      message: snap.message,
      details: {
        checkedAt: snap.checkedAt,
        worstPercent: snap.worstPercent,
        buckets: snap.buckets,
        subscriptionType: snap.subscriptionType,
      },
    };
  }

  return {
    id: 'claude_usage',
    label,
    status: 'ok',
    message: snap.message,
    details: {
      checkedAt: snap.checkedAt,
      worstPercent: snap.worstPercent,
      buckets: snap.buckets,
      subscriptionType: snap.subscriptionType,
    },
  };
}

async function checkCrm(): Promise<HealthCheckItem> {
  const label = 'CRM (каталог, read)';
  const provider = (config.CRM_PROVIDER ?? 'keycrm').toLowerCase();

  if (provider === 'none') {
    return {
      id: 'crm',
      label,
      status: 'not_configured',
      message: 'CRM вимкнено (CRM_PROVIDER=none)',
      details: { provider },
    };
  }

  const { keycrm } = await getIntegrationConfig();
  if (!keycrm.apiKey) {
    return {
      id: 'crm',
      label,
      status: 'not_configured',
      message: 'API ключ KeyCRM не налаштовано',
      details: { provider },
    };
  }

  try {
    const adapter = getCrmAdapter();
    await adapter.searchProducts({ limit: 1 });
    return {
      id: 'crm',
      label,
      status: 'ok',
      message: `Підключено (${adapter.name})`,
      details: { provider: adapter.name },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: 'crm',
      label,
      status: 'error',
      message: `KeyCRM не відповідає: ${message.slice(0, 240)}`,
      details: { provider },
    };
  }
}

async function checkCrmWrite(): Promise<HealthCheckItem> {
  const label = 'CRM (замовлення, write)';
  const write = await isCrmWriteReady();

  if (!write.enabled) {
    return {
      id: 'crm_write',
      label,
      status: 'not_configured',
      message: 'Запис замовлень у CRM вимкнено',
      details: { source: write.source },
    };
  }

  if (!write.ready) {
    return {
      id: 'crm_write',
      label,
      status: 'error',
      message: write.reason ?? 'CRM write недоступний',
      details: { source: write.source },
    };
  }

  const sourceLabel =
    write.source === 'env' ? 'увімкнено в .env' : 'увімкнено в Налаштуваннях';

  return {
    id: 'crm_write',
    label,
    status: 'ok',
    message: `Запис у CRM активний (${sourceLabel})`,
    details: { source: write.source },
  };
}

async function checkStt(): Promise<HealthCheckItem> {
  const label = 'Голосові (STT / Whisper)';

  if (!config.STT_ENABLED) {
    return {
      id: 'stt',
      label,
      status: 'not_configured',
      message: 'STT вимкнено (STT_ENABLED=false)',
    };
  }

  if (!config.WHISPER_SERVICE_TOKEN) {
    return {
      id: 'stt',
      label,
      status: 'error',
      message: 'WHISPER_SERVICE_TOKEN не задано в .env',
    };
  }

  const { pingWhisperService, getWhisperHealth } = await import('./transcribe.js');
  const { getUploadsRoot } = await import('./media.js');
  const { resolve: resolvePath } = await import('node:path');

  const whisperHealth = await getWhisperHealth();
  if (!whisperHealth.ok) {
    return {
      id: 'stt',
      label,
      status: 'error',
      message: `Whisper недоступний на ${config.WHISPER_SERVICE_URL}`,
      details: {
        url: config.WHISPER_SERVICE_URL,
        model: config.WHISPER_MODEL,
        maxSeconds: config.WHISPER_MAX_SECONDS,
      },
    };
  }

  const apiUploads = resolvePath(getUploadsRoot());
  const whisperUploads = whisperHealth.uploadsDir
    ? resolvePath(whisperHealth.uploadsDir)
    : null;
  if (whisperUploads && whisperUploads !== apiUploads) {
    return {
      id: 'stt',
      label,
      status: 'error',
      message: 'UPLOADS_DIR не збігається між API і Whisper',
      details: {
        apiUploadsDir: apiUploads,
        whisperUploadsDir: whisperUploads,
        hint: 'Встановіть однаковий абсолютний UPLOADS_DIR у .env і pm2 restart --update-env',
      },
    };
  }

  const ok = await pingWhisperService();
  if (!ok) {
    return {
      id: 'stt',
      label,
      status: 'error',
      message: `Whisper недоступний на ${config.WHISPER_SERVICE_URL}`,
      details: {
        url: config.WHISPER_SERVICE_URL,
        model: config.WHISPER_MODEL,
        maxSeconds: config.WHISPER_MAX_SECONDS,
      },
    };
  }

  return {
    id: 'stt',
    label,
    status: 'ok',
    message: `Whisper OK (${config.WHISPER_MODEL}, ≤${config.WHISPER_MAX_SECONDS}s)`,
    details: {
      url: config.WHISPER_SERVICE_URL,
      model: config.WHISPER_MODEL,
      language: config.WHISPER_LANGUAGE,
    },
  };
}

async function checkAgentLatency(claudeReady: boolean): Promise<HealthCheckItem> {
  const label = 'Швидкість агента';
  const maxMs = config.CLAUDE_TIMEOUT_MS;

  if (!claudeReady) {
    return {
      id: 'agent_latency',
      label,
      status: 'not_configured',
      message: 'Пропущено — спочатку налаштуйте Claude CLI',
      details: { maxLatencyMs: maxMs },
    };
  }

  const probe = await probeAgentLatency(maxMs);
  if (!probe.ok) {
    return {
      id: 'agent_latency',
      label,
      status: 'error',
      message: probe.error ?? `Агент не відповів за ${maxMs / 1000} с`,
      details: {
        latencyMs: probe.latencyMs,
        maxLatencyMs: maxMs,
        fallback: probe.fallback ?? null,
      },
    };
  }

  return {
    id: 'agent_latency',
    label,
    status: 'ok',
    message: `Відповідь за ${(probe.latencyMs / 1000).toFixed(1)} с (ліміт ${maxMs / 1000} с)`,
    details: { latencyMs: probe.latencyMs, maxLatencyMs: maxMs },
  };
}

export async function runTenantHealthCheck(): Promise<TenantHealthCheckResult> {
  const [instagram, claude, claudeUsage, crm, crmWrite, stt] = await Promise.all([
    checkInstagram(),
    checkClaude(),
    checkClaudeUsage(),
    checkCrm(),
    checkCrmWrite(),
    checkStt(),
  ]);

  const claudeReady = claude.status === 'ok';
  const agentLatency = await checkAgentLatency(claudeReady);

  const checks = [instagram, claude, claudeUsage, crm, crmWrite, stt, agentLatency];
  const overall = checks.every((c) => c.status === 'ok') ? 'ok' : 'degraded';

  return {
    checkedAt: new Date().toISOString(),
    overall,
    checks,
  };
}
