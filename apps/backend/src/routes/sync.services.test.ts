import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loadSyncedServices, prismaFindMany } = vi.hoisted(() => ({
  loadSyncedServices: vi.fn(),
  prismaFindMany: vi.fn(),
}));

vi.mock('../lib/synced-services.js', () => ({
  loadSyncedServices,
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    crmSyncRun: {
      findFirst: vi.fn(),
      findMany: prismaFindMany,
    },
  },
}));

vi.mock('../sync-worker.js', () => ({
  runSync: vi.fn(),
  SyncInProgressError: class SyncInProgressError extends Error {
    runId: string;
    constructor(runId: string) {
      super('in progress');
      this.runId = runId;
    }
  },
}));

import { syncRoutes } from './sync.js';

describe('GET /sync/services', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  beforeEach(() => {
    loadSyncedServices.mockReset();
    prismaFindMany.mockReset();
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function buildApp() {
    const app = Fastify();
    apps.push(app);
    app.decorate('authenticate', async () => {});
    app.decorate('requireOwner', async () => {});
    await app.register(syncRoutes, { prefix: '/sync' });
    return app;
  }

  it('returns empty snapshot when file is missing', async () => {
    loadSyncedServices.mockResolvedValue([]);
    prismaFindMany.mockResolvedValue([]);

    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/sync/services' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      services: [],
      count: 0,
      syncedAt: null,
      source: 'snapshot',
    });
  });

  it('returns services and syncedAt from last ok run with services count', async () => {
    const finishedAt = new Date('2026-08-07T08:00:00.000Z');
    loadSyncedServices.mockResolvedValue([
      {
        id: 's1',
        name: 'Стрижка',
        price: 500,
        durationMin: 45,
        provider: 'beautypro',
      },
    ]);
    prismaFindMany.mockResolvedValue([
      { counts: { products: 10 }, finishedAt: new Date('2026-08-07T09:00:00.000Z') },
      { counts: { services: 1 }, finishedAt },
    ]);

    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/sync/services' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      services: [
        {
          id: 's1',
          name: 'Стрижка',
          price: 500,
          durationMin: 45,
          provider: 'beautypro',
        },
      ],
      count: 1,
      syncedAt: finishedAt.toISOString(),
      source: 'snapshot',
    });
  });
});
