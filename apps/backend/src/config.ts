import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load .env from project root (two levels up from apps/backend)
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '..', '..', '..', '.env') });

const envSchema = z.object({
  // Identity
  INSTANCE_ID: z.string().default('sb'),
  INSTANCE_NAME: z.string().default('StatusBlessed'),
  BRAND_NAME: z.string().default('Status Blessed'),

  // Domains
  ADMIN_DOMAIN: z.string(),
  API_DOMAIN: z.string().default('localhost'),
  API_PORT: z.coerce.number().default(3100),
  ADMIN_PORT: z.coerce.number().default(3101),

  // Database
  DATABASE_URL: z.string().url(),

  // CRM
  CRM_PROVIDER: z.string().default('keycrm'),
  KEYCRM_API_KEY: z.string().default(''),
  KEYCRM_SYNC_INTERVAL_MIN: z.coerce.number().default(30),
  // Default order source_id for KeyCRM /order creation. Overridden per tenant
  // by integration_keycrm.defaultSourceId in admin Settings when set.
  KEYCRM_DEFAULT_SOURCE_ID: z.coerce.number().default(1),
  /** Optional env fallback for KeyCRM web UI deep links (per-tenant value preferred in Settings). */
  KEYCRM_APP_URL: z.string().default(''),
  // Optional: pipeline id for leadgen-mode brief cards. When 0 (default)
  // KeyCRM picks the first pipeline in the account — fine for single-pipeline
  // setups but should be set explicitly for tenants with multiple pipelines.
  KEYCRM_LEAD_PIPELINE_ID: z.coerce.number().default(0),
  // Feature flag — when true (default), orders/clients are mirrored to CRM
  // when a KeyCRM API key is configured. Disable explicitly for local-DB-only
  // mode or while field mapping is still being reviewed.
  CRM_WRITE_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),

  // Facebook / Instagram (Facebook Login for Business — Page Access Token)
  FACEBOOK_APP_ID: z.string().default(''),
  FACEBOOK_APP_SECRET: z.string().default(''),
  IG_WEBHOOK_VERIFY_TOKEN: z.string().default('sb-verify-2026'),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_MANAGER_GROUP_ID: z.string().default(''),
  TELEGRAM_ADMIN_PASSWORD: z.string().default(''),

  // Claude
  CLAUDE_MAX_CONCURRENCY: z.coerce.number().default(2),
  // IG/TG customer turns — catalog tool calls on a VPS often exceed 30s.
  CLAUDE_TIMEOUT_MS: z.coerce.number().default(60000),
  // Voice notes: STT already consumed wall time; allow a longer Claude window.
  CLAUDE_VOICE_TIMEOUT_MS: z.coerce.number().default(90000),
  // Admin-facing channels (meta_agent, sandbox, supervisor) work with much
  // larger inputs (full system prompt, diagnostic snapshots) and expect
  // structured multi-section output. The 30s customer timeout is too tight
  // and triggers spurious "менеджер відпише" fallbacks in the admin UI.
  CLAUDE_ADMIN_TIMEOUT_MS: z.coerce.number().default(120000),
  // Meta-agent teach chat may query CRM context and draft multi-section prompt
  // diffs — allow a longer window than generic admin turns.
  CLAUDE_TEACH_TIMEOUT_MS: z.coerce.number().default(300000),
  CLAUDE_MODEL: z.enum(['sonnet', 'opus', 'haiku']).default('sonnet'),
  // Poll Claude Code `/usage` for subscription limits (Pro/Max rolling windows).
  CLAUDE_USAGE_CHECK_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  CLAUDE_USAGE_CHECK_INTERVAL_MIN: z.coerce.number().default(30),
  CLAUDE_USAGE_WARNING_PERCENT: z.coerce.number().min(50).max(100).default(90),

  // Auth
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Supervisor (super-admin → tenant) shared secret.
  // If unset, /supervisor/* endpoints are disabled.
  SUPERVISOR_SHARED_SECRET: z.string().default(''),

  // Internal URL of the super-admin server for auto-syncing webhook config.
  // After a successful Facebook OAuth the tenant backend calls the SA hub
  // to register its instagramUserId so the hub can route webhooks automatically.
  // Empty = skip auto-sync (manual SA configuration required).
  SA_INTERNAL_URL: z.string().default(''),

  // Nova Poshta
  NOVA_POSHTA_API_KEY: z.string().default(''),

  // File storage
  UPLOADS_DIR: z.string().default('./uploads'),

  // Speech-to-text (local faster-whisper PM2 service)
  STT_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  WHISPER_SERVICE_URL: z.string().default(''),
  WHISPER_SERVICE_PORT: z.coerce.number().optional(),
  WHISPER_SERVICE_TOKEN: z.string().default(''),
  WHISPER_MODEL: z.string().default('small'),
  WHISPER_LANGUAGE: z.string().default('uk'),
  WHISPER_MAX_SECONDS: z.coerce.number().default(90),
  WHISPER_TIMEOUT_MS: z.coerce.number().default(120000),
  WHISPER_DEVICE: z.string().default('cpu'),
  WHISPER_COMPUTE_TYPE: z.string().default('int8'),
  WHISPER_CACHE_DIR: z.string().default(''),

  // Per-tenant knowledge & prompts dir. When empty, resolves to
  // <os.homedir()>/tenant_knowledge at runtime (see lib/paths.ts).
  TENANT_KNOWLEDGE_DIR: z.string().default(''),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

/** Per-tenant whisper port on shared VPS: API_PORT + 5000 (8100 only for API 3100). */
function resolveWhisperPort(apiPort: number, envPort?: number): number {
  const derived = apiPort + 5000;
  if (envPort == null) return derived;
  if (envPort === 8100 && apiPort !== 3100) return derived;
  return envPort;
}

const _raw = parsed.data;
const _whisperPort = resolveWhisperPort(_raw.API_PORT, _raw.WHISPER_SERVICE_PORT);
const _whisperUrl =
  _raw.WHISPER_SERVICE_URL.trim() ||
  `http://127.0.0.1:${_whisperPort}`;

export const config = {
  ..._raw,
  WHISPER_SERVICE_PORT: _whisperPort,
  WHISPER_SERVICE_URL: _whisperUrl,
};
export type Config = typeof config;
