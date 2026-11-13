/**
 * Hard salon CRM cutover (e.g. BeautyPro → Altegio).
 * Rematch clients by phone, switch salon routing, keep legacy identities + appointments.
 */

import pino from 'pino';
import { Prisma } from '../generated/prisma/client.js';
import { prisma, toInputJsonValue } from '../lib/prisma.js';
import {
  getCrmRouting,
  SALON_CRM_ACTIONS,
  saveCrmRouting,
  type CrmRoutingConfig,
} from '../lib/crm-routing.js';
import {
  isCrmProviderName,
  type CrmProviderName,
} from '../lib/crm-providers.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { providerHasCredentials } from '../lib/crm-write.js';
import { getCrmAdapter } from './crm/index.js';
import { importBranchesFromCrm } from './branches.js';
import {
  markProviderLegacy,
  syncClientPrimaryFromRouting,
  upsertClientCrmIdentity,
} from './client-crm-identity.js';
import { normalizeUaPhone } from '../lib/client-contact-heuristics.js';

const log = pino({ name: 'crm-salon-cutover' });

export const CRM_SALON_CUTOVER_SETTING_KEY = 'crm_salon_cutover_last';

export type SalonCutoverReport = {
  fromProvider: CrmProviderName;
  toProvider: CrmProviderName;
  startedAt: string;
  finishedAt: string;
  status: 'ok' | 'partial' | 'error';
  routingUpdated: boolean;
  branches: { imported: number; updated: number; skipped: number };
  clients: {
    total: number;
    matched: number;
    pendingNoPhone: number;
    pendingNotFound: number;
    errors: number;
  };
  bookingOffersCleared: number;
  legacyIdentitiesMarked: number;
  pendingClientIds: string[];
  errorMessage?: string;
};

function applySalonRouting(
  current: CrmRoutingConfig,
  toProvider: CrmProviderName,
  fromProvider: CrmProviderName,
): CrmRoutingConfig {
  const enabled = [
    ...new Set([
      ...current.enabled_providers.filter((p) => p !== fromProvider || p === toProvider),
      toProvider,
      // Keep fromProvider enabled so legacy cancel can still use credentials.
      ...(current.enabled_providers.includes(fromProvider) || fromProvider !== toProvider
        ? [fromProvider]
        : []),
    ]),
  ];

  const routes = { ...current.routes };
  for (const action of SALON_CRM_ACTIONS) {
    routes[action] = toProvider;
  }

  // Preserve KeyCRM (or other) for catalog/order/lead when already hybrid.
  const catalog = routes.catalog ?? current.default;
  const order = routes.order ?? current.default;
  const lead = routes.lead ?? current.default;
  const keepHybrid =
    [catalog, order, lead].some(
      (t) => t !== 'none' && t !== toProvider && t !== fromProvider,
    ) || current.mode === 'by_action';

  if (keepHybrid) {
    return {
      mode: 'by_action',
      default:
        current.default === fromProvider ? toProvider : current.default,
      enabled_providers: enabled,
      routes,
    };
  }

  const singleRoutes = Object.fromEntries(
    (
      [
        'catalog',
        'services',
        'branches',
        'order',
        'lead',
        'booking',
        'client_upsert',
      ] as const
    ).map((a) => [a, toProvider]),
  ) as CrmRoutingConfig['routes'];

  return {
    mode: 'single',
    default: toProvider,
    enabled_providers: enabled,
    routes: singleRoutes,
  };
}

export async function getLastSalonCutoverReport(): Promise<SalonCutoverReport | null> {
  const row = await prisma.setting.findUnique({
    where: { key: CRM_SALON_CUTOVER_SETTING_KEY },
  });
  if (!row?.value || typeof row.value !== 'object') return null;
  return row.value as SalonCutoverReport;
}

export async function runSalonCrmCutover(opts: {
  fromProvider: string;
  toProvider: string;
}): Promise<SalonCutoverReport> {
  const startedAt = new Date();
  if (!isCrmProviderName(opts.fromProvider) || !isCrmProviderName(opts.toProvider)) {
    throw new Error('fromProvider / toProvider must be known CRM names');
  }
  const fromProvider = opts.fromProvider;
  const toProvider = opts.toProvider;
  if (fromProvider === toProvider) {
    throw new Error('fromProvider і toProvider мають відрізнятись');
  }

  const cfg = await getIntegrationConfig({ fresh: true });
  if (!providerHasCredentials(toProvider, cfg)) {
    throw new Error(`CRM ${toProvider} не підключена (немає credentials)`);
  }
  const toAdapter = getCrmAdapter(toProvider);
  if (!toAdapter.findClient) {
    throw new Error(`CRM ${toProvider} не підтримує пошук клієнта (findClient)`);
  }

  const syncRun = await prisma.crmSyncRun.create({
    data: {
      status: 'running',
      provider: toProvider,
      syncType: 'salon_cutover',
      counts: toInputJsonValue({ phase: 'start' }),
    },
  });

  const report: SalonCutoverReport = {
    fromProvider,
    toProvider,
    startedAt: startedAt.toISOString(),
    finishedAt: '',
    status: 'ok',
    routingUpdated: false,
    branches: { imported: 0, updated: 0, skipped: 0 },
    clients: {
      total: 0,
      matched: 0,
      pendingNoPhone: 0,
      pendingNotFound: 0,
      errors: 0,
    },
    bookingOffersCleared: 0,
    legacyIdentitiesMarked: 0,
    pendingClientIds: [],
  };

  try {
    // 1. Routing
    const current = await getCrmRouting({ fresh: true });
    const next = applySalonRouting(current, toProvider, fromProvider);
    await saveCrmRouting(next);
    report.routingUpdated = true;

    // 2. Branches from new CRM (do not delete old provider rows)
    try {
      const branchResult = await importBranchesFromCrm();
      report.branches = {
        imported: branchResult.imported,
        updated: branchResult.updated,
        skipped: branchResult.skipped,
      };
    } catch (err) {
      log.warn({ err }, 'Branch import during cutover failed');
      report.status = 'partial';
      report.errorMessage =
        (report.errorMessage ? report.errorMessage + '; ' : '') +
        `branches: ${err instanceof Error ? err.message : String(err)}`;
    }

    // 3. Clients rematch
    const clients = await prisma.client.findMany({
      select: {
        id: true,
        phone: true,
        email: true,
        displayName: true,
        igUsername: true,
      },
    });
    report.clients.total = clients.length;

    for (const client of clients) {
      try {
        // Mark old identity legacy if present
        const fromId = await prisma.clientCrmIdentity.findUnique({
          where: {
            clientId_provider: { clientId: client.id, provider: fromProvider },
          },
        });
        if (fromId) {
          await markProviderLegacy(client.id, fromProvider);
          report.legacyIdentitiesMarked += 1;
        }

        const phone = client.phone ? normalizeUaPhone(client.phone) ?? client.phone : null;
        if (!phone) {
          report.clients.pendingNoPhone += 1;
          report.pendingClientIds.push(client.id);
          await syncClientPrimaryFromRouting(client.id);
          continue;
        }

        const match = await toAdapter.findClient!({
          phone,
          email: client.email ?? undefined,
          name: client.displayName ?? undefined,
          instagramUsername: client.igUsername ?? undefined,
        });

        if (match?.crmBuyerId) {
          await upsertClientCrmIdentity({
            clientId: client.id,
            provider: toProvider,
            externalId: match.crmBuyerId,
            source: 'migration',
            status: 'active',
            force: true,
          });
          await syncClientPrimaryFromRouting(client.id);
          report.clients.matched += 1;
        } else {
          report.clients.pendingNotFound += 1;
          report.pendingClientIds.push(client.id);
          await syncClientPrimaryFromRouting(client.id);
        }
      } catch (err) {
        report.clients.errors += 1;
        report.pendingClientIds.push(client.id);
        log.warn({ err, clientId: client.id }, 'Cutover client rematch failed');
      }
    }

    // 4. Clear stale booking offers (old CRM slot UUIDs)
    const cleared = await prisma.conversation.updateMany({
      where: { bookingOffer: { not: Prisma.DbNull } },
      data: { bookingOffer: Prisma.DbNull },
    });
    report.bookingOffersCleared = cleared.count;

    if (
      report.clients.errors > 0 ||
      report.clients.pendingNotFound > 0 ||
      report.clients.pendingNoPhone > 0
    ) {
      report.status = report.clients.matched > 0 || report.routingUpdated ? 'partial' : 'partial';
    }

    report.finishedAt = new Date().toISOString();
    await prisma.setting.upsert({
      where: { key: CRM_SALON_CUTOVER_SETTING_KEY },
      create: {
        key: CRM_SALON_CUTOVER_SETTING_KEY,
        value: toInputJsonValue(report) as never,
      },
      update: { value: toInputJsonValue(report) as never },
    });

    await prisma.crmSyncRun.update({
      where: { id: syncRun.id },
      data: {
        status: report.status === 'error' ? 'error' : 'ok',
        finishedAt: new Date(),
        counts: toInputJsonValue(report.clients) as never,
        artifacts: toInputJsonValue({
          pendingClientIds: report.pendingClientIds.slice(0, 200),
          branches: report.branches,
          bookingOffersCleared: report.bookingOffersCleared,
        }) as never,
        errorMessage: report.errorMessage ?? null,
      },
    });

    log.info(
      {
        fromProvider,
        toProvider,
        matched: report.clients.matched,
        pending: report.pendingClientIds.length,
      },
      'Salon CRM cutover finished',
    );
    return report;
  } catch (err) {
    report.status = 'error';
    report.errorMessage = err instanceof Error ? err.message : String(err);
    report.finishedAt = new Date().toISOString();
    await prisma.crmSyncRun.update({
      where: { id: syncRun.id },
      data: {
        status: 'error',
        finishedAt: new Date(),
        errorMessage: report.errorMessage,
      },
    }).catch(() => undefined);
    await prisma.setting.upsert({
      where: { key: CRM_SALON_CUTOVER_SETTING_KEY },
      create: {
        key: CRM_SALON_CUTOVER_SETTING_KEY,
        value: toInputJsonValue(report) as never,
      },
      update: { value: toInputJsonValue(report) as never },
    }).catch(() => undefined);
    throw err;
  }
}
