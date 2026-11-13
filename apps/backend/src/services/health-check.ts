import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pino from 'pino';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { checkIgConnectionStatus } from './ig-connection.js';
import {
  probeAgentLatency,
} from './claude.js';
import { getClaudeAuthStatus } from './claude-auth.js';
import { fetchClaudeUsageSnapshot } from './claude-usage.js';
import { loadClaudeUsageSnapshot } from './claude-usage-monitor.js';
import { getCrmAdapter } from './crm/registry.js';
import {
  getCrmRouting,
  isCrmRoutingLocalOnly,
  resolveCrmProvider,
  type CrmRoutingConfig,
} from '../lib/crm-routing.js';
import { isCrmWriteReady } from '../lib/crm-write.js';
import { getClaudeBinaryPath } from '../lib/claude-binary.js';
import {
  findOrphanClaudeProcesses,
  parsePsProcessRows,
} from '../lib/claude-orphan-processes.js';
import type { CrmProviderName } from '../lib/crm-providers.js';
import { getAgentConfig } from '../lib/agent-config.js';

const execFileAsync = promisify(execFile);
const log = pino({ name: 'health-check' });

export type HealthCheckStatus = 'ok' | 'not_configured' | 'error';

export interface HealthCheckItem {
  id:
    | 'instagram'
    | 'claude'
    | 'claude_usage'
    | 'crm'
    | 'cleverbox'
    | 'beautypro'
    | 'altegio'
    | 'crm_write'
    | 'agent_latency'
    | 'stt'
    | 'ads_referral_schema'
    | 'respond_ads_only';
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

/** Overall is degraded only on live failures — missing optional CRM/STT is informational. */
export function summarizeHealthOverall(
  checks: Array<{ status: HealthCheckStatus }>,
): 'ok' | 'degraded' {
  return checks.some((c) => c.status === 'error') ? 'degraded' : 'ok';
}

function providerUsedInRouting(
  routing: CrmRoutingConfig,
  provider: CrmProviderName,
): boolean {
  if (isCrmRoutingLocalOnly(routing)) return false;
  if (routing.enabled_providers.includes(provider)) return true;
  if (routing.default === provider) return true;
  return Object.values(routing.routes).some((target) => target === provider);
}

async function unusedCrmVendorCheck(
  id: HealthCheckItem['id'],
  label: string,
  provider: CrmProviderName,
): Promise<HealthCheckItem | null> {
  const routing = await getCrmRouting();
  if (providerUsedInRouting(routing, provider)) return null;
  return {
    id,
    label,
    status: 'ok',
    message: isCrmRoutingLocalOnly(routing)
      ? 'Локальний режим — CRM не використовується'
      : 'Не в маршрутизації CRM',
    details: { provider, inUse: false, localOnly: isCrmRoutingLocalOnly(routing) },
  };
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

async function warnOrphanClaudeProcesses(): Promise<{ count: number; pids: number[] }> {
  try {
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=', '-o', 'ppid=', '-o', 'args='], {
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
    });
    const orphans = findOrphanClaudeProcesses(parsePsProcessRows(String(stdout)), {
      binaryPath: getClaudeBinaryPath(),
      selfPid: process.pid,
    });
    if (orphans.length > 0) {
      log.warn(
        {
          event: 'claude_orphan_processes',
          count: orphans.length,
          pids: orphans.map((row) => row.pid),
        },
        'Orphan claude processes (ppid 1) — warn only, health-check does not fail',
      );
    }
    return { count: orphans.length, pids: orphans.map((row) => row.pid) };
  } catch {
    return { count: 0, pids: [] };
  }
}

async function checkClaude(): Promise<HealthCheckItem> {
  const label = 'Claude CLI';
  const status = await getClaudeAuthStatus({ skipLiveCache: true });

  if (!status.binaryOk) {
    return {
      id: 'claude',
      label,
      status: 'error',
      message: status.error ?? 'Claude CLI недоступний',
      details: { path: status.binaryPath },
    };
  }

  if (status.sessionExpired) {
    return {
      id: 'claude',
      label,
      status: 'error',
      message: status.error ?? 'Токен Claude прострочений',
      details: {
        path: status.binaryPath,
        version: status.binaryVersion,
        email: status.email,
        sessionExpired: true,
      },
    };
  }

  if (!status.loggedIn) {
    return {
      id: 'claude',
      label,
      status: 'error',
      message: status.error ?? 'Claude не авторизовано',
      details: { path: status.binaryPath, version: status.binaryVersion },
    };
  }

  const orphans = await warnOrphanClaudeProcesses();
  const orphanNote =
    orphans.count > 0 ? ` · ${orphans.count} orphan claude (warn)` : '';

  return {
    id: 'claude',
    label,
    status: 'ok',
    message: `Підключено (${status.binaryVersion ?? 'ok'})${orphanNote}`,
    details: {
      path: status.binaryPath,
      version: status.binaryVersion,
      email: status.email,
      orphanClaudeCount: orphans.count,
      orphanClaudePids: orphans.pids,
    },
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
    if (snap?.error === 'not_authenticated') {
      return {
        id: 'claude_usage',
        label,
        status: 'not_configured',
        message: 'Claude ще не авторизовано — ліміти недоступні',
        details: {
          checkedAt: snap.checkedAt,
          error: snap.error,
        },
      };
    }
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

  const { CRM_NOT_CONNECTED_LABEL } = await import('../lib/crm-providers.js');
  const routing = await getCrmRouting();
  if (
    isCrmRoutingLocalOnly(routing) ||
    (config.CRM_PROVIDER ?? '').toLowerCase() === 'none'
  ) {
    return {
      id: 'crm',
      label,
      status: 'ok',
      message: 'Локальний режим — каталог CRM не потрібен',
      details: { provider: 'none', localOnly: true },
    };
  }

  const catalogProvider = await resolveCrmProvider('catalog');
  if (!catalogProvider) {
    return {
      id: 'crm',
      label,
      status: 'ok',
      message: CRM_NOT_CONNECTED_LABEL,
      details: { provider: 'none' },
    };
  }

  const { keycrm, cleverbox } = await getIntegrationConfig();

  if (catalogProvider === 'keycrm' && !keycrm.apiKey) {
    return {
      id: 'crm',
      label,
      status: 'not_configured',
      message: 'API ключ KeyCRM не налаштовано (каталог)',
      details: { provider: catalogProvider },
    };
  }

  if (catalogProvider === 'cleverbox' && !cleverbox.apiToken && !config.CLEVERBOX_API_TOKEN) {
    return {
      id: 'crm',
      label,
      status: 'not_configured',
      message: 'API token CleverBOX не налаштовано (каталог)',
      details: { provider: catalogProvider },
    };
  }

  try {
    const adapter = getCrmAdapter(catalogProvider);
    await adapter.searchProducts({ limit: 1 });
    return {
      id: 'crm',
      label,
      status: 'ok',
      message: `Каталог: ${adapter.name}`,
      details: { provider: adapter.name, action: 'catalog' },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: 'crm',
      label,
      status: 'error',
      message: `CRM каталог не відповідає: ${message.slice(0, 240)}`,
      details: { provider: catalogProvider },
    };
  }
}

async function checkCleverbox(): Promise<HealthCheckItem> {
  const label = 'CleverBOX (запис)';
  const unused = await unusedCrmVendorCheck('cleverbox', label, 'cleverbox');
  if (unused) return unused;

  const { cleverbox } = await getIntegrationConfig();
  const token = cleverbox.apiToken || config.CLEVERBOX_API_TOKEN;

  if (!token) {
    return {
      id: 'cleverbox',
      label,
      status: 'not_configured',
      message: 'API token CleverBOX не налаштовано',
    };
  }

  try {
    const adapter = getCrmAdapter('cleverbox');
    if (!adapter.fetchServices) {
      return {
        id: 'cleverbox',
        label,
        status: 'not_configured',
        message: 'CleverBOX adapter без fetchServices',
      };
    }
    const services = await adapter.fetchServices();
    return {
      id: 'cleverbox',
      label,
      status: 'ok',
      message: `Підключено (${services.length} послуг у snapshot)`,
      details: { serviceCount: services.length },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: 'cleverbox',
      label,
      status: 'error',
      message: `CleverBOX не відповідає: ${message.slice(0, 240)}`,
    };
  }
}

async function checkAltegio(): Promise<HealthCheckItem> {
  const label = 'Altegio (запис)';
  const unused = await unusedCrmVendorCheck('altegio', label, 'altegio');
  if (unused) return unused;

  const { altegio } = await getIntegrationConfig();
  const configured = Boolean(
    (altegio.partnerToken || config.ALTEGIO_PARTNER_TOKEN)
    && (altegio.userToken || config.ALTEGIO_USER_TOKEN)
    && (altegio.locationId || config.ALTEGIO_LOCATION_ID),
  );
  if (!configured) {
    return {
      id: 'altegio',
      label,
      status: 'not_configured',
      message: 'Partner token, user token або ID компанії Altegio не налаштовано',
    };
  }
  try {
    const adapter = getCrmAdapter('altegio');
    if (!adapter.fetchBranches) {
      return {
        id: 'altegio',
        label,
        status: 'not_configured',
        message: 'Altegio adapter без fetchBranches',
      };
    }
    const branches = await adapter.fetchBranches();
    const title = branches[0]?.name || 'компанію';
    return {
      id: 'altegio',
      label,
      status: 'ok',
      message: `Підключено (${title})`,
      details: { locationId: altegio.locationId, branchCount: branches.length },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: 'altegio',
      label,
      status: 'error',
      message: `Altegio не відповідає: ${message.slice(0, 240)}`,
    };
  }
}

async function checkBeautypro(): Promise<HealthCheckItem> {
  const label = 'BeautyPro (запис)';
  const unused = await unusedCrmVendorCheck('beautypro', label, 'beautypro');
  if (unused) return unused;

  const { beautypro } = await getIntegrationConfig();
  const configured = Boolean(
    (beautypro.applicationId || config.BEAUTYPRO_APPLICATION_ID) &&
      (beautypro.applicationSecret || config.BEAUTYPRO_APPLICATION_SECRET) &&
      (beautypro.databaseCode || config.BEAUTYPRO_DATABASE_CODE),
  );

  if (!configured) {
    return {
      id: 'beautypro',
      label,
      status: 'not_configured',
      message: 'BeautyPro credentials не налаштовано (applicationId / secret / databaseCode)',
    };
  }

  try {
    const adapter = getCrmAdapter('beautypro');
    if (!adapter.fetchBranches) {
      return {
        id: 'beautypro',
        label,
        status: 'not_configured',
        message: 'BeautyPro adapter без fetchBranches',
      };
    }
    const branches = await adapter.fetchBranches();
    const statusNote =
      beautypro.authStatus === 'pending'
        ? ' (Marketplace: pending grant)'
        : beautypro.authStatus === 'granted'
          ? ''
          : beautypro.authStatus
            ? ` (auth: ${beautypro.authStatus})`
            : '';
    return {
      id: 'beautypro',
      label,
      status: 'ok',
      message: `Підключено (${branches.length} локацій)${statusNote}`,
      details: { branchCount: branches.length, authStatus: beautypro.authStatus },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isPending = /pending/i.test(message);
    return {
      id: 'beautypro',
      label,
      status: isPending ? 'not_configured' : 'error',
      message: isPending
        ? 'Очікує Grant access у BeautyPro → Settings → Marketplace'
        : `BeautyPro не відповідає: ${message.slice(0, 240)}`,
    };
  }
}

async function checkCrmWrite(): Promise<HealthCheckItem> {
  const label = 'CRM (замовлення, write)';
  const write = await isCrmWriteReady();

  // Route is none / local-only — local Order is fine; do not fail health.
  if (!write.provider) {
    return {
      id: 'crm_write',
      label,
      status: 'ok',
      message: 'Локальні замовлення — CRM write не потрібен',
      details: { source: write.source, provider: null },
    };
  }

  if (!write.enabled) {
    return {
      id: 'crm_write',
      label,
      status: 'ok',
      message: 'Запис замовлень у CRM вимкнено',
      details: { source: write.source, provider: write.provider },
    };
  }

  // Selected vendor without credentials: config gap (yellow), not a live outage (red).
  if (!write.ready) {
    return {
      id: 'crm_write',
      label,
      status: 'not_configured',
      message: write.reason ?? 'CRM write недоступний',
      details: { source: write.source, provider: write.provider },
    };
  }

  const sourceLabel =
    write.source === 'env' ? 'увімкнено в .env' : 'увімкнено в Налаштуваннях';

  return {
    id: 'crm_write',
    label,
    status: 'ok',
    message: `Запис у CRM активний (${sourceLabel})`,
    details: { source: write.source, provider: write.provider },
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

async function checkAdsReferralSchema(): Promise<HealthCheckItem> {
  const label = 'IG ads referral schema';
  try {
    await prisma.$queryRaw`
      SELECT ig_ad_referral, ads_only_bot_assumed_at, story_reply_at
      FROM conversations
      LIMIT 1
    `;
    await prisma.$queryRaw`SELECT 1 FROM handoff_sla_jobs LIMIT 1`;
    return {
      id: 'ads_referral_schema',
      label,
      status: 'ok',
      message: 'Колонки ig_ad_* / ads_only_bot_assumed_at / story_reply_at і handoff_sla_jobs на місці',
    };
  } catch (err) {
    return {
      id: 'ads_referral_schema',
      label,
      status: 'error',
      message:
        'Немає міграції ads referral / dual SLA — застосуйте prisma migrate (ig_ad_referral, handoff_sla_jobs)',
      details: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function checkRespondAdsOnlyReady(): Promise<HealthCheckItem> {
  const label = 'Режим лише реклама';
  const agentCfg = await getAgentConfig();
  if (!agentCfg.respondAdsOnly) {
    return {
      id: 'respond_ads_only',
      label,
      status: 'ok',
      message: 'Вимкнено (бот відповідає на всі DM)',
      details: { respondAdsOnly: false },
    };
  }

  const { telegram } = await getIntegrationConfig();
  const hasToken = Boolean(
    (typeof telegram.botToken === 'string' && telegram.botToken.trim().length > 0)
      || telegram.bots?.some((b) => typeof b.botToken === 'string' && b.botToken.trim().length > 0),
  );
  if (!hasToken) {
    return {
      id: 'respond_ads_only',
      label,
      status: 'error',
      message:
        'respondAdsOnly увімкнено, але Telegram для менеджерів не налаштований — органіка піде в тиху діру',
      details: { respondAdsOnly: true, telegramConfigured: false },
    };
  }
  return {
    id: 'respond_ads_only',
    label,
    status: 'ok',
    message: 'Увімкнено: органіка → soft-handoff + dual SLA (потрібен живий CTD referral)',
    details: { respondAdsOnly: true, telegramConfigured: true },
  };
}

export async function runTenantHealthCheck(): Promise<TenantHealthCheckResult> {
  const [
    instagram,
    claude,
    claudeUsage,
    crm,
    cleverbox,
    beautypro,
    altegio,
    crmWrite,
    stt,
    adsSchema,
    respondAdsOnly,
  ] = await Promise.all([
    checkInstagram(),
    checkClaude(),
    checkClaudeUsage(),
    checkCrm(),
    checkCleverbox(),
    checkBeautypro(),
    checkAltegio(),
    checkCrmWrite(),
    checkStt(),
    checkAdsReferralSchema(),
    checkRespondAdsOnlyReady(),
  ]);

  const claudeReady = claude.status === 'ok';
  const agentLatency = await checkAgentLatency(claudeReady);

  const checks = [
    instagram,
    claude,
    claudeUsage,
    crm,
    cleverbox,
    beautypro,
    altegio,
    crmWrite,
    stt,
    agentLatency,
    adsSchema,
    respondAdsOnly,
  ];
  return {
    checkedAt: new Date().toISOString(),
    overall: summarizeHealthOverall(checks),
    checks,
  };
}
