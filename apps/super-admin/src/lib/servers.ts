import type { Server } from '../generated/prisma/client.js';
import { config } from '../config.js';
import { prisma } from './prisma.js';

/** Ensure the in-process `local` worker row exists; backfill tenants without serverId. */
export async function ensureLocalServer(): Promise<Server> {
  let local = await prisma.server.findUnique({ where: { name: 'local' } });
  if (!local) {
    local = await prisma.server.create({
      data: {
        name: 'local',
        kind: 'local',
        baseUrl: null,
        publicIp: config.SA_LOCAL_PUBLIC_IP || '127.0.0.1',
        sharedSecret: null,
        maxTenants: 12,
        status: 'active',
      },
    });
  }

  await prisma.tenant.updateMany({
    where: { serverId: null },
    data: { serverId: local.id },
  });

  return local;
}

export async function getServerForTenant(serverId: string | null | undefined): Promise<Server> {
  if (serverId) {
    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (server) return server;
  }
  return ensureLocalServer();
}

export function isLocalServer(server: Pick<Server, 'kind'>): boolean {
  return server.kind === 'local';
}
