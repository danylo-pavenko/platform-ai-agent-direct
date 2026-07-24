import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';
import { hostname } from 'node:os';

loadDotenv({ path: resolve(process.cwd(), '.env') });
loadDotenv({ path: resolve(process.cwd(), '../../.env.platform-worker') });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  WORKER_PORT: z.coerce.number().default(4100),
  WORKER_HOST: z.string().default('0.0.0.0'),
  WORKER_SHARED_SECRET: z.string().min(32),
  PLATFORM_REPO_ROOT: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  WORKER_NAME: z.string().default(hostname()),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  process.stderr.write('Invalid platform-worker env:\n');
  process.stderr.write(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2) + '\n');
  process.exit(1);
}

export const config = parsed.data;
