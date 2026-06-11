import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { checkPlatformAccess } from '../lib/platform-access.js';
import { platformAccessError } from '../lib/auth.js';

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

    const token = app.jwt.sign({
      sub: user.id,
      username: user.username,
      role: user.role,
    });

    return { token, user: { id: user.id, username: user.username, role: user.role } };
  });

  // GET /auth/me (authenticated)
  app.get('/me', { onRequest: [app.authenticate] }, async (request) => {
    return { user: request.user };
  });
}
