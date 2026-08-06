import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  findUniquePrompt,
  findFirstPrompt,
  updateManyPrompt,
  updatePrompt,
  upsertSetting,
  findUniqueSetting,
  createAudit,
  transaction,
} = vi.hoisted(() => {
  const findUniquePrompt = vi.fn();
  const findFirstPrompt = vi.fn();
  const updateManyPrompt = vi.fn();
  const updatePrompt = vi.fn();
  const upsertSetting = vi.fn();
  const findUniqueSetting = vi.fn();
  const createAudit = vi.fn();
  const transaction = vi.fn();
  return {
    findUniquePrompt,
    findFirstPrompt,
    updateManyPrompt,
    updatePrompt,
    upsertSetting,
    findUniqueSetting,
    createAudit,
    transaction,
  };
});

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    systemPrompt: {
      findUnique: findUniquePrompt,
      findFirst: findFirstPrompt,
      updateMany: updateManyPrompt,
      update: updatePrompt,
    },
    setting: {
      findUnique: findUniqueSetting,
      upsert: upsertSetting,
    },
    auditLog: {
      create: createAudit,
    },
    $transaction: transaction,
  },
}));

import { promptRoutes } from '../routes/prompts.js';

function makeApp() {
  const routes: Array<{
    method: string;
    path: string;
    handler: (req: unknown, reply: unknown) => Promise<unknown>;
  }> = [];

  const app = {
    authenticate: vi.fn(),
    requireOwner: vi.fn(),
    get: vi.fn((path: string, _opts: unknown, handler: (req: unknown, reply: unknown) => Promise<unknown>) => {
      routes.push({ method: 'GET', path, handler });
    }),
    post: vi.fn((path: string, _opts: unknown, handler: (req: unknown, reply: unknown) => Promise<unknown>) => {
      routes.push({ method: 'POST', path, handler });
    }),
  };

  return { app: app as never, routes };
}

describe('POST /prompts/:id/activate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('activates prompt, bumps runtime generation, and writes audit', async () => {
    const activated = {
      id: 'p-new',
      version: 7,
      content: 'new',
      isActive: true,
    };

    findUniquePrompt.mockResolvedValue({ id: 'p-new', version: 7, content: 'new', isActive: false });
    findFirstPrompt.mockResolvedValue({ id: 'p-old', version: 6 });

    transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        systemPrompt: {
          updateMany: updateManyPrompt.mockResolvedValue({ count: 1 }),
          update: updatePrompt.mockResolvedValue(activated),
        },
        setting: {
          findUnique: findUniqueSetting.mockResolvedValue({ value: 3 }),
          upsert: upsertSetting.mockResolvedValue({ key: 'prompt_runtime_generation', value: 4 }),
        },
        auditLog: {
          create: createAudit.mockResolvedValue({}),
        },
      };
      return fn(tx);
    });

    const { app, routes } = makeApp();
    await promptRoutes(app);

    const activate = routes.find((r) => r.method === 'POST' && r.path === '/:id/activate');
    expect(activate).toBeTruthy();

    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    const result = await activate!.handler(
      {
        params: { id: 'p-new' },
        user: { id: 'u1', username: 'owner' },
      },
      reply,
    );

    expect(updateManyPrompt).toHaveBeenCalledWith({ data: { isActive: false } });
    expect(updatePrompt).toHaveBeenCalledWith({
      where: { id: 'p-new' },
      data: { isActive: true },
    });
    expect(upsertSetting).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'prompt_runtime_generation' },
        create: { key: 'prompt_runtime_generation', value: 4 },
        update: { value: 4 },
      }),
    );
    expect(createAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actor: 'owner',
          action: 'prompt_activated',
          entityType: 'system_prompt',
          entityId: 'p-new',
          payload: expect.objectContaining({
            version: 7,
            runtimeGeneration: 4,
            previousId: 'p-old',
            previousVersion: 6,
          }),
        }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      id: 'p-new',
      version: 7,
      runtimeGeneration: 4,
    }));
  });

  it('returns 404 when prompt missing', async () => {
    findUniquePrompt.mockResolvedValue(null);
    const { app, routes } = makeApp();
    await promptRoutes(app);
    const activate = routes.find((r) => r.method === 'POST' && r.path === '/:id/activate')!;

    const reply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn((body: unknown) => body),
    };
    await activate.handler({ params: { id: 'missing' }, user: { username: 'o' } }, reply);
    expect(reply.code).toHaveBeenCalledWith(404);
    expect(transaction).not.toHaveBeenCalled();
  });
});
