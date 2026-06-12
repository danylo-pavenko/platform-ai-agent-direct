/**
 * Retries failed / stuck CRM order mirrors.
 *
 * Called from sync-worker (every catalog sync cron) and manually via
 * POST /orders/:id/sync-crm. Idempotent — mirrorOrderToCrm skips
 * orders that already have keycrmOrderId.
 */

import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import { isCrmWriteEnabled } from '../lib/crm-write.js';
import { mirrorOrderToCrm } from './crm-sync.js';

const log = pino({ name: 'crm-mirror-retry' });

const RETRY_MIN_AGE_MS = 5 * 60 * 1000;
const BATCH_SIZE = 20;

export interface CrmMirrorRetryStats {
  attempted: number;
  synced: number;
  failed: number;
}

/**
 * Re-attempt mirror for orders stuck in pending/failed without a CRM id.
 * Skips very fresh pending rows — the initial async mirror may still run.
 */
export async function retryPendingCrmMirrors(): Promise<CrmMirrorRetryStats> {
  if (!(await isCrmWriteEnabled())) {
    return { attempted: 0, synced: 0, failed: 0 };
  }

  const cutoff = new Date(Date.now() - RETRY_MIN_AGE_MS);
  const orders = await prisma.order.findMany({
    where: {
      keycrmOrderId: null,
      crmSyncStatus: { in: ['pending', 'failed'] },
      OR: [
        { crmSyncStatus: 'failed' },
        { crmSyncStatus: 'pending', createdAt: { lt: cutoff } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH_SIZE,
    select: { id: true },
  });

  let synced = 0;
  let failed = 0;

  for (const { id } of orders) {
    try {
      await mirrorOrderToCrm(id);
      const row = await prisma.order.findUnique({
        where: { id },
        select: { crmSyncStatus: true },
      });
      if (row?.crmSyncStatus === 'synced') synced += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      log.warn({ err, orderId: id }, 'CRM mirror retry failed');
    }
  }

  if (orders.length > 0) {
    log.info({ attempted: orders.length, synced, failed }, 'CRM mirror retry batch done');
  }

  return { attempted: orders.length, synced, failed };
}
