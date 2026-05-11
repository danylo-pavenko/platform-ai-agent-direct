import { z } from 'zod';

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
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  process.stderr.write('Invalid environment variables:\n');
  process.stderr.write(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2) + '\n');
  process.exit(1);
}

export const config: z.infer<typeof schema> = parsed.data;
