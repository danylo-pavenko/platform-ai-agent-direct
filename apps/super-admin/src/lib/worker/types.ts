import type { Server, Tenant } from '../../generated/prisma/client.js';

/** Minimal tenant fields needed for provision/deploy on a worker. */
export type TenantDeployInput = Pick<
  Tenant,
  | 'id'
  | 'instanceId'
  | 'name'
  | 'apiDomain'
  | 'adminDomain'
  | 'apiPort'
  | 'adminPort'
  | 'linuxUser'
  | 'appDir'
  | 'status'
  | 'gitRepo'
  | 'envExtra'
>;

export type WorkerHealthResult = {
  ok: boolean;
  service?: string;
  hostname?: string;
  detail?: string;
};

export type WorkerClient = {
  readonly server: Server;
  healthCheck(): Promise<WorkerHealthResult>;
  listListeningPorts(): Promise<number[]>;
  isDeployed(tenant: Pick<Tenant, 'linuxUser' | 'appDir'>): Promise<boolean>;
  /**
   * Run provision (if needed) + deploy. Stream log lines via onLine.
   * Returns process exit code (0 = success).
   */
  runDeployPipeline(
    tenant: TenantDeployInput,
    onLine: (line: string) => void,
    opts?: { signal?: AbortSignal },
  ): Promise<number>;
  /**
   * Run full host deprovision (Linux user, DB, nginx, PM2). Does not touch SA DB.
   * Returns process exit code (0 = success).
   */
  runDestroyPipeline(
    tenant: TenantDeployInput,
    onLine: (line: string) => void,
    opts?: { signal?: AbortSignal },
  ): Promise<number>;
};
