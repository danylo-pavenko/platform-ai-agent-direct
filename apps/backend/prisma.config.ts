import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Load .env from project root (2 levels up: apps/backend/ → apps/ → root)
config({ path: resolve(__dirname, '..', '..', '.env') });

export default defineConfig({
  earlyAccess: true,
  schema: 'src/prisma/schema.prisma',
  migrations: {
    path: 'src/prisma/migrations',
    seed: 'tsx src/prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});
