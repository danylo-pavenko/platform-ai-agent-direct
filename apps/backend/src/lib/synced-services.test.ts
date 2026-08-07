import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSyncedServices, parseServicesSnapshot } from './synced-services.js';

describe('parseServicesSnapshot', () => {
  it('returns empty list for invalid JSON', () => {
    expect(parseServicesSnapshot('not-json')).toEqual([]);
    expect(parseServicesSnapshot('{}')).toEqual([]);
  });

  it('returns empty list for empty array', () => {
    expect(parseServicesSnapshot('[]')).toEqual([]);
  });

  it('keeps valid rows and skips invalid ones', () => {
    const raw = JSON.stringify([
      {
        id: 'svc-1',
        name: 'Стрижка',
        price: 500,
        durationMin: 45,
        categoryName: 'Волосся',
        provider: 'beautypro',
        priceRows: [
          {
            branchId: 'loc',
            positionId: 'top',
            positionName: 'Топ майстер',
            price: 640,
          },
        ],
      },
      { id: 1, name: 'bad' },
      {
        id: 'svc-2',
        name: 'Борода',
        price: 300,
        durationMin: 30,
        provider: 'cleverbox',
        branchPrices: [{ branchId: 'b1', branchName: 'Центр', price: 350 }],
      },
    ]);

    expect(parseServicesSnapshot(raw)).toEqual([
      {
        id: 'svc-1',
        name: 'Стрижка',
        price: 500,
        durationMin: 45,
        categoryName: 'Волосся',
        provider: 'beautypro',
        priceRows: [
          {
            branchId: 'loc',
            positionId: 'top',
            positionName: 'Топ майстер',
            price: 640,
          },
        ],
      },
      {
        id: 'svc-2',
        name: 'Борода',
        price: 300,
        durationMin: 30,
        provider: 'cleverbox',
        branchPrices: [{ branchId: 'b1', branchName: 'Центр', price: 350 }],
      },
    ]);
  });
});

describe('loadSyncedServices', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('returns empty list when snapshot file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synced-services-'));
    dirs.push(dir);
    const services = await loadSyncedServices(join(dir, 'missing-services.json'));
    expect(services).toEqual([]);
  });

  it('loads valid snapshot from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synced-services-'));
    dirs.push(dir);
    const path = join(dir, 'services.json');
    await writeFile(
      path,
      JSON.stringify([
        {
          id: 'uuid-1',
          name: 'Манікюр',
          price: 700,
          durationMin: 60,
          provider: 'beautypro',
        },
      ]),
      'utf8',
    );

    const services = await loadSyncedServices(path);
    expect(services).toHaveLength(1);
    expect(services[0]?.name).toBe('Манікюр');
    expect(services[0]?.price).toBe(700);
  });
});
