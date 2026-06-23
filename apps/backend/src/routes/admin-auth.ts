import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { checkPlatformAccess } from '../lib/platform-access.js';
import { platformAccessError } from '../lib/auth.js';
import {
  CHANGE_PASSWORD_ERROR_UK,
  validateChangePasswordInput,
} from '../lib/change-password.js';

function signAdminToken(
  app: FastifyInstance,
  user: { id: string; username: string; role: string },
) {
  return app.jwt.sign({
    sub: user.id,
    username: user.username,
    role: user.role,
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // POST /auth/login
  app.post<{
    Body: { username: string; password: string };
  }>('/login', async (request, reply) => {
    const { username, password } = request.body ?? {};

    if (!username || !password) {
      return reply.code(400).send({ error: 'Username and password required' });
    }

    const user = await prisma.adminUser.findUnique({ where: { username } });
    if (!user) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    // Platform-level access (subscription / manual block by super-admin).
    // Checked after credentials so we don't leak access status to strangers.
    const access = await checkPlatformAccess();
    if (!access.allowed) {
      return reply.code(403).send(platformAccessError(access));
    }

    const token = signAdminToken(app, user);

    return { token, user: { id: user.id, username: user.username, role: user.role } };
  });

  // POST /auth/change-password — authenticated admin changes own password
  app.post<{
    Body: {
      currentPassword?: string;
      newPassword?: string;
      confirmPassword?: string;
    };
  }>('/change-password', { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = request.body ?? {};
    const validationError = validateChangePasswordInput({
      currentPassword: body.currentPassword ?? '',
      newPassword: body.newPassword ?? '',
      confirmPassword: body.confirmPassword ?? '',
    });
    if (validationError) {
      return reply.code(400).send({ error: CHANGE_PASSWORD_ERROR_UK[validationError] });
    }

    const user = await prisma.adminUser.findUnique({
      where: { id: request.user.id },
    });
    if (!user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const currentPassword = body.currentPassword!.trim();
    const newPassword = body.newPassword!;

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      return reply.code(401).send({ error: 'Невірний поточний пароль' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const updated = await prisma.adminUser.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    const token = signAdminToken(app, {
      id: updated.id,
      username: updated.username,
      role: updated.role,
    });

    return {
      token,
      user: { id: updated.id, username: updated.username, role: updated.role },
    };
  });

  // GET /auth/me (authenticated)
  app.get('/me', { onRequest: [app.authenticate] }, async (request) => {
    return { user: request.user };
  });
}
