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

  // Meta / Instagram
  META_APP_ID: z.string().default(''),
  META_APP_SECRET: z.string().default(''),
  IG_PAGE_ACCESS_TOKEN: z.string().default(''),
  IG_PAGE_ID: z.string().default(''),
  IG_WEBHOOK_VERIFY_TOKEN: z.string().default('sb-verify-2026'),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_MANAGER_GROUP_ID: z.string().default(''),
  TELEGRAM_ADMIN_PASSWORD: z.string().default(''),

  // Claude
  CLAUDE_MAX_CONCURRENCY: z.coerce.number().default(2),
  CLAUDE_TIMEOUT_MS: z.coerce.number().default(30000),
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
