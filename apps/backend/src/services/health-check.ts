import { config } from '../config.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { checkIgConnectionStatus } from './ig-connection.js';
import {
  claudeAuthCheck,
  claudeHealthCheck,
  probeAgentLatency,
} from './claude.js';
import { getCrmAdapter } from './crm/registry.js';

export type HealthCheckStatus = 'ok' | 'not_configured' | 'error';

export interface HealthCheckItem {
  id: 'instagram' | 'claude' | 'crm' | 'agent_latency';
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
    return {
      id: 'instagram',
      label,
      status: 'not_configured',
      message: 'OAuth не виконано — натисніть «Авторизуватись через Facebook»',
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
  return {
    id: 'instagram',
    label,
    status: 'ok',
    message: username
      ? `Підключено @${username}`
      : `Підключено (IG ID: ${status.igAccount?.id ?? meta.igUserId})`,
    details: {
      igUserId: status.igAccount?.id ?? meta.igUserId,
      igUsername: username ?? meta.igUsername,
      conversationsSample: status.conversationsCount,
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

async function checkCrm(): Promise<HealthCheckItem> {
  const label = 'CRM';
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
  const [instagram, claude, crm] = await Promise.all([
    checkInstagram(),
    checkClaude(),
    checkCrm(),
  ]);

  const claudeReady = claude.status === 'ok';
  const agentLatency = await checkAgentLatency(claudeReady);

  const checks = [instagram, claude, crm, agentLatency];
  const overall = checks.every((c) => c.status === 'ok') ? 'ok' : 'degraded';

  return {
    checkedAt: new Date().toISOString(),
    overall,
    checks,
  };
}
