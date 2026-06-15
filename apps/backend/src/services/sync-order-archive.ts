/**
 * During catalog sync, refresh local archive flags for orders mirrored to KeyCRM.
 * Archived / closed orders in KeyCRM are hidden from the admin list by default.
 */

import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import {
  isKeycrmOrderArchived,
  type KeycrmOrderArchiveSnapshot,
} from '../lib/keycrm-order-archive.js';
import { fetchKeycrmOrderSnapshot } from './crm/keycrm.js';

const log = pino({ name: 'sync-order-archive' });

const BATCH_SIZE = 25;
const PACING_MS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSnapshot(raw: {
  closed_at: string | null;
  status?: { name?: string; alias?: string };
}): KeycrmOrderArchiveSnapshot {
  return {
    closedAt: raw.closed_at,
    statusAlias: raw.status?.alias ?? null,
    statusName: raw.status?.name ?? null,
  };
}

export interface SyncOrderArchiveStats {
  checked: number;
  archived: number;
}

/**
 * For each local order linked to KeyCRM, pull remote status and mark
 * `isArchived` when the CRM order is closed or in a terminal status.
 */
export async function syncOrderArchiveFlags(): Promise<SyncOrderArchiveStats> {
  const orders = await prisma.order.findMany({
    where: {
      keycrmOrderId: { not: null },
      isArchived: false,
    },
    select: { id: true, keycrmOrderId: true },
    orderBy: { createdAt: 'asc' },
  });

  if (orders.length === 0) {
    return { checked: 0, archived: 0 };
  }

  let archived = 0;

  for (let i = 0; i < orders.length; i += BATCH_SIZE) {
    const batch = orders.slice(i, i + BATCH_SIZE);

    for (const order of batch) {
      const keycrmId = order.keycrmOrderId;
      if (!keycrmId) continue;

      const remote = await fetchKeycrmOrderSnapshot(keycrmId);
      if (!remote) continue;

      if (!isKeycrmOrderArchived(toSnapshot(remote))) continue;

      await prisma.order.update({
        where: { id: order.id },
        data: {
          isArchived: true,
          archivedAt: new Date(),
          status: 'cancelled',
        },
      });
      archived += 1;
    }

    if (i + BATCH_SIZE < orders.length) {
      await sleep(PACING_MS);
    }
  }

  if (archived > 0) {
    log.info({ checked: orders.length, archived }, 'Marked KeyCRM-archived orders locally');
  } else {
    log.debug({ checked: orders.length }, 'No KeyCRM orders needed archive sync');
  }

  return { checked: orders.length, archived };
}
