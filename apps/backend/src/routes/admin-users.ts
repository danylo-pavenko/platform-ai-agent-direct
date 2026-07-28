import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  generateAdminPassword,
  generateManagerUsername,
  generateTelegramLinkCode,
  TELEGRAM_LINK_CODE_TTL_MS,
  toAdminUserPublic,
} from '../lib/admin-user.js';

const createBodySchema = z.object({
  displayName: z.string().trim().max(80).optional(),
});

const patchBodySchema = z.object({
  displayName: z.string().trim().max(80).nullable().optional(),
  isActive: z.boolean().optional(),
  resetPassword: z.boolean().optional(),
});

export async function adminUsersRoutes(app: FastifyInstance): Promise<void> {
  const ownerOnly = { onRequest: [app.authenticate, app.requireOwner] };

  // GET /admin/users
  app.get('/', ownerOnly, async () => {
    const users = await prisma.adminUser.findMany({
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });
    return { data: users.map(toAdminUserPublic) };
  });

  // POST /admin/users — create manager with generated credentials
  app.post<{ Body: unknown }>('/', ownerOnly, async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body' });
    }

    const displayName = parsed.data.displayName?.trim() || null;
    let username = generateManagerUsername();
    for (let i = 0; i < 5; i++) {
      const exists = await prisma.adminUser.findUnique({ where: { username } });
      if (!exists) break;
      username = generateManagerUsername();
    }

    const password = generateAdminPassword();
    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.adminUser.create({
      data: {
        username,
        passwordHash,
        role: 'manager',
        displayName,
        isActive: true,
      },
    });

    return {
      user: toAdminUserPublic(user),
      password,
    };
  });

  // PATCH /admin/users/:id
  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/:id',
    ownerOnly,
    async (request, reply) => {
      const parsed = patchBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid body' });
      }

      const existing = await prisma.adminUser.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.code(404).send({ error: 'User not found' });
      }

      if (existing.role === 'owner' && parsed.data.isActive === false) {
        const activeOwners = await prisma.adminUser.count({
          where: { role: 'owner', isActive: true },
        });
        if (activeOwners <= 1) {
          return reply.code(400).send({
            error: 'Не можна вимкнути останнього власника.',
            code: 'LAST_OWNER',
          });
        }
      }

      const data: {
        displayName?: string | null;
        isActive?: boolean;
        passwordHash?: string;
      } = {};

      if (parsed.data.displayName !== undefined) {
        data.displayName =
          parsed.data.displayName === null || parsed.data.displayName.trim() === ''
            ? null
            : parsed.data.displayName.trim();
      }
      if (parsed.data.isActive !== undefined) {
        data.isActive = parsed.data.isActive;
      }

      let password: string | undefined;
      if (parsed.data.resetPassword) {
        password = generateAdminPassword();
        data.passwordHash = await bcrypt.hash(password, 12);
      }

      if (Object.keys(data).length === 0) {
        return reply.code(400).send({ error: 'No changes' });
      }

      const updated = await prisma.adminUser.update({
        where: { id: existing.id },
        data,
      });

      return {
        user: toAdminUserPublic(updated),
        ...(password ? { password } : {}),
      };
    },
  );

  // POST /admin/users/:id/telegram-link-code
  app.post<{ Params: { id: string } }>(
    '/:id/telegram-link-code',
    ownerOnly,
    async (request, reply) => {
      const user = await prisma.adminUser.findUnique({
        where: { id: request.params.id },
      });
      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }
      if (!user.isActive) {
        return reply.code(400).send({
          error: 'Спочатку увімкніть користувача.',
          code: 'ACCOUNT_DISABLED',
        });
      }

      await prisma.adminTelegramLinkCode.deleteMany({
        where: {
          adminUserId: user.id,
          usedAt: null,
        },
      });

      let code = generateTelegramLinkCode();
      for (let i = 0; i < 5; i++) {
        const clash = await prisma.adminTelegramLinkCode.findUnique({ where: { code } });
        if (!clash) break;
        code = generateTelegramLinkCode();
      }

      const expiresAt = new Date(Date.now() + TELEGRAM_LINK_CODE_TTL_MS);
      const row = await prisma.adminTelegramLinkCode.create({
        data: {
          adminUserId: user.id,
          code,
          expiresAt,
        },
      });

      return {
        code: row.code,
        expiresAt: row.expiresAt.toISOString(),
        command: `/link ${row.code}`,
      };
    },
  );
}
