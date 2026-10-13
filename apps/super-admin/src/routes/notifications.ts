import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

const MAX_TOASTS = 20;

export type SaNotification = {
  id: string;
  type: 'lead';
  title: string;
  body: string;
  createdAt: string;
  meta: {
    leadId: string;
    plan: string | null;
    status: string;
    contact: string;
  };
};

function leadContact(l: {
  name: string | null;
  email: string | null;
  instagram: string | null;
  messenger: string | null;
}): string {
  return l.name || l.instagram || l.email || l.messenger || 'Без контакту';
}

function leadToNotification(l: {
  id: string;
  name: string | null;
  email: string | null;
  instagram: string | null;
  messenger: string | null;
  message: string | null;
  plan: string | null;
  status: string;
  createdAt: Date;
  link: { name: string; slug: string } | null;
  refSlug: string | null;
}): SaNotification {
  const contact = leadContact(l);
  const source = l.link?.name
    ? `via ${l.link.name}`
    : l.refSlug
      ? `ref ${l.refSlug}`
      : 'прямий вхід';
  const bits = [
    l.plan ? `тариф ${l.plan}` : null,
    source,
    l.message ? l.message.slice(0, 120) : null,
  ].filter(Boolean);
  return {
    id: `lead:${l.id}`,
    type: 'lead',
    title: 'Нова заявка з лендингу',
    body: `${contact}${bits.length ? ` · ${bits.join(' · ')}` : ''}`,
    createdAt: l.createdAt.toISOString(),
    meta: {
      leadId: l.id,
      plan: l.plan,
      status: l.status,
      contact,
    },
  };
}

export async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/notifications', { onRequest: [app.authenticate] }, async () => {
    const leads = await prisma.landingLead.findMany({
      where: {
        status: 'new',
        toastDismissedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_TOASTS,
      include: {
        link: { select: { name: true, slug: true } },
      },
    });

    const notifications = leads.map(leadToNotification);
    return {
      notifications,
      unreadCount: notifications.length,
    };
  });

  app.post('/api/notifications/:id/dismiss', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const leadMatch = /^lead:(.+)$/.exec(id);
    if (!leadMatch) {
      return reply.status(400).send({ error: 'Unknown notification id' });
    }
    const leadId = leadMatch[1];
    try {
      await prisma.landingLead.update({
        where: { id: leadId },
        data: { toastDismissedAt: new Date() },
      });
      return { ok: true };
    } catch {
      return reply.status(404).send({ error: 'Not found' });
    }
  });

  app.post('/api/notifications/dismiss-all', { onRequest: [app.authenticate] }, async () => {
    const result = await prisma.landingLead.updateMany({
      where: { status: 'new', toastDismissedAt: null },
      data: { toastDismissedAt: new Date() },
    });
    return { ok: true, dismissed: result.count };
  });
}
