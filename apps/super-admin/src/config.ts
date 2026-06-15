import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

// Load .env.super-admin from repo root when running locally (PM2 injects env in production).
loadDotenv({ path: resolve(process.cwd(), '.env') });
loadDotenv({ path: resolve(process.cwd(), '../../.env.super-admin') });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SA_API_PORT: z.coerce.number().default(4000),
  SA_APP_PORT: z.coerce.number().default(4001),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('7d'),
  SA_ADMIN_USERNAME: z.string().default('superadmin'),
  SA_ADMIN_PASSWORD: z.string().min(6),
  // Shared secret forwarded to tenant backends as X-Supervisor-Token.
  // Must match each tenant's own SUPERVISOR_SHARED_SECRET for chat to work.
  SUPERVISOR_SHARED_SECRET: z.string().default(''),
  // Platform-level Instagram webhook verify token.
  // Set this in the Meta App Dashboard → Webhooks → Verify Token field.
  // Used by the hub to respond to Meta's GET challenge verification.
  PLATFORM_WEBHOOK_VERIFY_TOKEN: z.string().default('platform-verify-2026'),
  // App Secret of the single shared Meta App used for all tenants.
  // Used by the hub to verify X-Hub-Signature-256 on every inbound webhook.
  // If empty, HMAC verification is skipped (not recommended for production).
  PLATFORM_FACEBOOK_APP_SECRET: z.string().default(''),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Landing contact form (Resend)
  RESEND_API_KEY: z.string().default(''),
  RESEND_FROM: z.string().default('Direct AI Agents <onboarding@resend.dev>'),
  LANDING_CONTACT_TO: z.string().email().default('help@depsoftware.com'),
  // Base URL for tracked link destinations (landing page)
  LANDING_BASE_URL: z.string().url().default('https://direct-ai-agents.com'),
  // Public base URL for generated short links (usually same as landing)
  TRACKING_LINK_BASE_URL: z.string().url().default('https://direct-ai-agents.com'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  process.stderr.write('Invalid environment variables:\n');
  process.stderr.write(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2) + '\n');
  process.exit(1);
}

export const config: z.infer<typeof schema> = parsed.data;
