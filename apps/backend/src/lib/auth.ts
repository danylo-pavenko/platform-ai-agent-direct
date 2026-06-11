import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { prisma } from './prisma.js';
import { checkPlatformAccess, type PlatformAccess } from './platform-access.js';

/**
 * Standard 403 payload for blocked/expired platform access.
 * code is machine-readable for the admin SPA; error is a human fallback.
 */
export function platformAccessError(access: PlatformAccess) {
  return access.reason === 'suspended'
    ? {
        error: 'Доступ до панелі заблоковано адміністратором платформи.',
        code: 'ACCESS_SUSPENDED' as const,
      }
    : {
        error: 'Термін доступу до панелі завершився. Зверніться до адміністратора платформи щодо оплати.',
        code: 'ACCESS_EXPIRED' as const,
        accessExpiresAt: access.accessExpiresAt,
      };
}

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
        const payload = await request.jwtVerify() as { sub: string; username: string; role: string };
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

      // Platform-level access (subscription expiry / super-admin block).
      // Cached for 60s in platform-access.ts, so this adds no per-request hub call.
      const access = await checkPlatformAccess();
      if (!access.allowed) {
        return reply.code(403).send(platformAccessError(access));
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
