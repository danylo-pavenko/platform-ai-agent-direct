import type { Server } from '../../generated/prisma/client.js';
import { isLocalServer } from '../servers.js';
import { createHttpWorkerClient } from './http.js';
import { createInProcessWorkerClient } from './in-process.js';
import type { WorkerClient } from './types.js';

export function getWorkerClient(server: Server): WorkerClient {
  if (isLocalServer(server)) {
    return createInProcessWorkerClient(server);
  }
  return createHttpWorkerClient(server);
}

export type { WorkerClient, TenantDeployInput, WorkerHealthResult } from './types.js';
export {
  resolveTenantApiUrl,
  resolveTenantOAuthCallbackUrl,
  resolveTenantWebhookUrl,
  dnsHintsForTenant,
} from './tenant-url.js';
