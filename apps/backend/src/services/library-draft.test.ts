import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const update = vi.fn();
const create = vi.fn();

vi.mock('../config.js', () => ({
  config: { BRAND_NAME: 'Test', TENANT_KNOWLEDGE_DIR: '/tmp' },
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    knowledgeArticle: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      findMany: vi.fn(),
      update: (...args: unknown[]) => update(...args),
      create: (...args: unknown[]) => create(...args),
    },
  },
}));

import { saveLibraryDraft } from './library.js';

describe('saveLibraryDraft upsert', () => {
  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
    create.mockReset();
  });

  it('updates existing meta_agent draft by slug', async () => {
    findUnique.mockResolvedValueOnce({
      id: 'draft-1',
      author: 'meta_agent',
      status: 'draft',
      title: 'Old',
    });
    update.mockResolvedValueOnce({
      id: 'draft-1',
      slug: 'black-friday',
      title: 'Чорна пʼятниця',
    });

    const row = await saveLibraryDraft({
      slug: 'black-friday',
      title: 'Чорна пʼятниця',
      description: 'Акція',
      body: '−20%',
      aliases: ['black friday'],
    });

    expect(update).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(row.slug).toBe('black-friday');
  });

  it('creates when slug is free', async () => {
    findUnique.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({
      id: 'new-1',
      slug: 'new-event',
      title: 'Подія',
    });

    const row = await saveLibraryDraft({
      slug: 'new-event',
      title: 'Подія',
      description: 'Коли питають',
      body: 'Текст',
      aliases: ['подія'],
    });

    expect(create).toHaveBeenCalled();
    expect(row.id).toBe('new-1');
  });
});
