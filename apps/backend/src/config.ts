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
  // Default order source_id for KeyCRM /order creation. Each KeyCRM tenant
  // has its own sources list — 1 is the safe default (usually "Manual" /
  // "Default"). Can be overridden per-instance via env.
  KEYCRM_DEFAULT_SOURCE_ID: z.coerce.number().default(1),
  // Optional: pipeline id for leadgen-mode brief cards. When 0 (default)
  // KeyCRM picks the first pipeline in the account — fine for single-pipeline
  // setups but should be set explicitly for tenants with multiple pipelines.
  KEYCRM_LEAD_PIPELINE_ID: z.coerce.number().default(0),
  // Feature flag — when false (default), CRM writes are disabled and the
  // bot operates in local-DB-only mode. Flip to true once credentials are
  // verified and the mapping is reviewed.
  CRM_WRITE_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),

  // Instagram (API with Instagram Login — no Facebook Page needed)
  INSTAGRAM_APP_ID: z.string().default(''),
  INSTAGRAM_APP_SECRET: z.string().default(''),
  IG_USER_ID: z.string().default(''),
  IG_ACCESS_TOKEN: z.string().default(''),
  IG_WEBHOOK_VERIFY_TOKEN: z.string().default('sb-verify-2026'),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_MANAGER_GROUP_ID: z.string().default(''),
  TELEGRAM_ADMIN_PASSWORD: z.string().default(''),

  // Claude
  CLAUDE_MAX_CONCURRENCY: z.coerce.number().default(2),
  CLAUDE_TIMEOUT_MS: z.coerce.number().default(30000),
  // Admin-facing channels (meta_agent, sandbox, supervisor) work with much
  // larger inputs (full system prompt, diagnostic snapshots) and expect
  // structured multi-section output. The 30s customer timeout is too tight
  // and triggers spurious "менеджер відпише" fallbacks in the admin UI.
  CLAUDE_ADMIN_TIMEOUT_MS: z.coerce.number().default(120000),
  CLAUDE_MODEL: z.enum(['sonnet', 'opus', 'haiku']).default('sonnet'),

  // Auth
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Supervisor (super-admin → tenant) shared secret.
  // If unset, /supervisor/* endpoints are disabled.
  SUPERVISOR_SHARED_SECRET: z.string().default(''),

  // Nova Poshta
  NOVA_POSHTA_API_KEY: z.string().default(''),

  // File storage
  UPLOADS_DIR: z.string().default('./uploads'),

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

export const config = parsed.data;
export type Config = z.infer<typeof envSchema>;
