import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // GET / — Get all settings
  app.get('/', { onRequest: [app.authenticate] }, async () => {
    const settings = await prisma.setting.findMany();

    const result: Record<string, unknown> = {};
    for (const setting of settings) {
      result[setting.key] = setting.value;
    }

    return result;
  });

  // PUT / — Update settings
  app.put<{
    Body: Record<string, unknown>;
  }>('/', { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = request.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: 'Body must be a JSON object' });
    }

    const entries = Object.entries(body);

    if (entries.length === 0) {
      return reply.code(400).send({ error: 'No settings provided' });
    }

    // Upsert each key
    await Promise.all(
      entries.map(([key, value]) =>
        prisma.setting.upsert({
          where: { key },
          create: { key, value: value as any },
          update: { value: value as any },
        }),
      ),
    );

    // Return updated settings
    const settings = await prisma.setting.findMany();
    const result: Record<string, unknown> = {};
    for (const setting of settings) {
      result[setting.key] = setting.value;
    }

    return result;
  });
}
