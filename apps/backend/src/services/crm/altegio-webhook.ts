/**
 * Optional Altegio record/client webhooks.
 * Tenant registers POST {api}/webhooks/altegio in their Altegio callback settings.
 * A saved webhook secret must be sent as ?token= or X-Webhook-Token.
 * Without a secret, the body must include partner_token equal to the saved one.
 * Events for another company id are ignored.
 */

import { getIntegrationConfig } from '../../lib/integration-config.js';
import { prisma } from '../../lib/prisma.js';
import { altegioWebhookAllowed, planAltegioWebhook } from './altegio-map.js';

export { altegioWebhookAllowed };

export async function authorizeAltegioWebhook(
  body: unknown,
  presentedSecret?: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { altegio } = await getIntegrationConfig();
  if (!altegio.partnerToken || !altegio.userToken || !altegio.locationId) {
    return { ok: false, reason: 'not_configured' };
  }
  const partner =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as { partner_token?: unknown }).partner_token
      : undefined;
  return altegioWebhookAllowed({
    bodyPartnerToken: typeof partner === 'string' ? partner : undefined,
    presentedSecret,
    savedPartnerToken: altegio.partnerToken,
    savedWebhookSecret: altegio.webhookSecret,
  });
}

export async function applyAltegioWebhook(
  body: unknown,
): Promise<{ applied: string; updated: number }> {
  const { altegio } = await getIntegrationConfig();
  const plan = planAltegioWebhook(body);
  if (plan.action === 'ignore') return { applied: plan.reason, updated: 0 };
  if (plan.companyId && altegio.locationId && plan.companyId !== altegio.locationId) {
    return { applied: 'company_mismatch', updated: 0 };
  }

  if (plan.action === 'cancel_record') {
    const result = await prisma.appointment.updateMany({
      where: {
        crmRecordId: plan.recordId,
        crmProvider: 'altegio',
        status: { not: 'cancelled' },
      },
      data: {
        status: 'cancelled',
        crmSyncStatus: 'synced',
        crmSyncedAt: new Date(),
      },
    });
    return { applied: 'cancel_record', updated: result.count };
  }

  if (plan.action === 'update_record') {
    if (!plan.dateUa || !plan.time) return { applied: 'update_record_no_datetime', updated: 0 };
    const result = await prisma.appointment.updateMany({
      where: {
        crmRecordId: plan.recordId,
        crmProvider: 'altegio',
        status: { not: 'cancelled' },
      },
      data: {
        scheduledDate: plan.dateUa,
        scheduledTime: plan.time,
        crmSyncStatus: 'synced',
        crmSyncedAt: new Date(),
      },
    });
    return { applied: 'update_record', updated: result.count };
  }

  if (!plan.name) return { applied: 'update_client_no_name', updated: 0 };
  const result = await prisma.client.updateMany({
    where: { crmBuyerId: plan.clientId, crmProvider: 'altegio' },
    data: { displayName: plan.name },
  });
  return { applied: 'update_client', updated: result.count };
}
