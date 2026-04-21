import '../config.js'; // loads .env via dotenv and validates

import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { existsSync, readFileSync } from 'node:fs';

import { PrismaClient } from '../generated/prisma/client.js';
import { getSalesAgentPromptPath, getSalesAgentTemplatePath } from '../lib/paths.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  const password = process.env.DEFAULT_ADMIN_PASSWORD || 'change-me!';

  const passwordHash = await bcrypt.hash(password, 12);

  await prisma.adminUser.upsert({
    where: { username },
    update: {},
    create: {
      username,
      passwordHash,
      role: 'owner',
    },
  });

  console.log(`Admin user "${username}" seeded (or already exists).`);

  // Default settings
  const defaults: Record<string, unknown> = {
    working_hours: {
      mon: { start: '09:00', end: '20:00', enabled: true },
      tue: { start: '09:00', end: '20:00', enabled: true },
      wed: { start: '09:00', end: '20:00', enabled: true },
      thu: { start: '09:00', end: '20:00', enabled: true },
      fri: { start: '09:00', end: '20:00', enabled: true },
      sat: { start: '10:00', end: '18:00', enabled: true },
      sun: { start: '00:00', end: '00:00', enabled: false },
    },
    out_of_hours_template:
      'Дякуємо за повідомлення! Зараз ми не на зв\'язку. Відповімо вам у робочий час.',
    handoff_keywords: ['менеджер', 'людина', 'оператор', 'скарга', 'повернення'],
    feature_flags: {
      auto_handoff: true,
      send_typing_indicator: false,
    },
  };

  for (const [key, value] of Object.entries(defaults)) {
    await prisma.setting.upsert({
      where: { key },
      update: {},
      create: { key, value: value as any },
    });
  }

  console.log('Default settings seeded.');

  // Seed system prompt from sales-agent.txt (if no prompts exist yet).
  // Prefer the tenant-local copy; fall back to the repo template on first
  // seed before bootstrap-tenant-knowledge has had a chance to run.
  const promptCount = await prisma.systemPrompt.count();
  if (promptCount === 0) {
    const tenantPath = getSalesAgentPromptPath();
    const templatePath = getSalesAgentTemplatePath();
    const promptPath = existsSync(tenantPath) ? tenantPath : templatePath;
    try {
      const content = readFileSync(promptPath, 'utf-8');
      await prisma.systemPrompt.create({
        data: {
          version: 1,
          content,
          author: 'human',
          changeSummary: 'Initial system prompt (Version 3)',
          isActive: true,
        },
      });
      console.log(`System prompt v1 seeded from ${promptPath} and activated.`);
    } catch (err) {
      console.warn(`Could not seed system prompt from ${promptPath}:`, err);
    }
  } else {
    console.log(`System prompts already exist (${promptCount}), skipping seed.`);
  }
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
