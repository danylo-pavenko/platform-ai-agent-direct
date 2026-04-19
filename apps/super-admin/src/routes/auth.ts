import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';

const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const body = loginSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Invalid body' });

    const { username, password } = body.data;
    if (username !== config.SA_ADMIN_USERNAME || password !== config.SA_ADMIN_PASSWORD) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const token = await reply.jwtSign(
      { username, role: 'superadmin' },
      { expiresIn: config.JWT_EXPIRES_IN }
    );

    return { token };
  });

  app.get('/api/auth/me', { onRequest: [app.authenticate] }, async (req) => {
    return req.user;
  });
}
