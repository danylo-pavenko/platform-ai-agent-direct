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
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  process.stderr.write('Invalid environment variables:\n');
  process.stderr.write(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2) + '\n');
  process.exit(1);
}

export const config: z.infer<typeof schema> = parsed.data;
