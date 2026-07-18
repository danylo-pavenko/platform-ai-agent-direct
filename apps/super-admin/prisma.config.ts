import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Prefer repo-root .env.super-admin (production / deploy), then local .env
loadDotenv({ path: resolve(__dirname, '../../.env.super-admin') });
loadDotenv({ path: resolve(__dirname, '.env') });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});
