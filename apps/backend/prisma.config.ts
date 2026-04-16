import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  earlyAccess: true,
  schema: 'src/prisma/schema.prisma',
  migrate: {
    migrations: 'src/prisma/migrations',
    seed: 'tsx src/prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});
