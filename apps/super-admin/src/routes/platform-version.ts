import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getPlatformVersion } from '../lib/platform-version.js';

/**
 * Platform version for tenant auto-update polls.
 * Auth: X-Supervisor-Token (same shared secret as by-instance endpoints).
 */
export async function platformVersionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/platform/version', async (req, reply) => {
    const token = req.headers['x-supervisor-token'];
    if (!config.SUPERVISOR_SHARED_SECRET || token !== config.SUPERVISOR_SHARED_SECRET) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const version = getPlatformVersion();
    return {
      name: version.name,
      code: version.code,
      label: version.label,
    };
  });
}
