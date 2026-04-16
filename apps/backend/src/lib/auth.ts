import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { prisma } from './prisma.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; username: string; role: string };
    user: { id: string; username: string; role: string };
  }
}

async function auth(app: FastifyInstance) {
  app.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const payload = await request.jwtVerify();
        const user = await prisma.adminUser.findUnique({
          where: { id: payload.sub },
        });
        if (!user) {
          return reply.code(401).send({ error: 'User not found' });
        }
        request.user = {
          id: user.id,
          username: user.username,
          role: user.role,
        };
      } catch {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    },
  );
}

export const authPlugin = fp(auth);

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}
