import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { clientIp } from '../lib/client-ip.js';
import { isLikelyBot, isLikelyPreviewBot } from '../lib/bot-detect.js';
import { resolveGeo } from '../lib/geo.js';
import { rateLimit } from '../lib/rate-limit.js';

const slugSchema = z.string().regex(/^[a-z0-9-]{2,48}$/);

const createLinkSchema = z.object({
  name: z.string().min(1).max(120),
  slug: slugSchema.optional(),
  destinationUrl: z.string().url().max(500).optional(),
  isActive: z.boolean().optional(),
});

const updateLinkSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: slugSchema.optional(),
  destinationUrl: z.string().url().max(500).optional(),
  isActive: z.boolean().optional(),
});

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'link';
}

async function uniqueSlug(preferred: string): Promise<string> {
  let slug = preferred;
  let n = 0;
  while (true) {
    const existing = await prisma.trackedLink.findUnique({ where: { slug } });
    if (!existing) return slug;
    n += 1;
    slug = `${preferred.slice(0, 28)}-${n}`;
  }
}

function defaultDestination(slug: string): string {
  const base = config.LANDING_BASE_URL.replace(/\/$/, '');
  return `${base}/?ref=${encodeURIComponent(slug)}`;
}

function trackingUrl(slug: string): string {
  const base = config.TRACKING_LINK_BASE_URL.replace(/\/$/, '');
  return `${base}/go/${slug}`;
}

function redirectHtml(slug: string, destination: string): string {
  const pingUrl = `/go/${encodeURIComponent(slug)}/p`;
  const dest = destination.replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="uk"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="1;url=${dest}">
<title>Redirecting…</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0f;color:#e8e8f0}a{color:#7c6eff}</style>
</head><body>
<p>Переходимо на сайт… <a href="${dest}">Натисніть тут</a>, якщо не перенаправило.</p>
<script>
(function(){
  try {
    fetch(${JSON.stringify(pingUrl)}, { method: 'POST', keepalive: true, credentials: 'same-origin' }).catch(function(){});
  } catch(e) {}
  setTimeout(function(){ location.replace(${JSON.stringify(destination)}); }, 120);
})();
</script>
</body></html>`;
}

async function aggregateLinkStats(linkIds: string[]) {
  if (linkIds.length === 0) {
    return new Map<string, { rawClicks: number; humanClicks: number; formSubmissions: number; countries: Record<string, number> }>();
  }

  const [allClicks, humanClicks, leads, geoRows] = await Promise.all([
    prisma.linkClick.groupBy({
      by: ['linkId'],
      where: { linkId: { in: linkIds } },
      _count: { _all: true },
    }),
    prisma.linkClick.groupBy({
      by: ['linkId'],
      where: { linkId: { in: linkIds }, isHuman: true },
      _count: { _all: true },
    }),
    prisma.landingLead.groupBy({
      by: ['linkId'],
      where: { linkId: { in: linkIds } },
      _count: { _all: true },
    }),
    prisma.linkClick.findMany({
      where: { linkId: { in: linkIds }, isHuman: true, countryCode: { not: null } },
      select: { linkId: true, countryCode: true, country: true },
    }),
  ]);

  const rawMap = new Map(allClicks.map((g) => [g.linkId, g._count._all]));
  const humanMap = new Map(humanClicks.map((g) => [g.linkId, g._count._all]));
  const leadMap = new Map(leads.map((g) => [g.linkId, g._count._all]));

  const countriesByLink = new Map<string, Record<string, number>>();
  for (const row of geoRows) {
    if (!row.countryCode) continue;
    const label = row.country || row.countryCode;
    const map = countriesByLink.get(row.linkId) ?? {};
    map[label] = (map[label] ?? 0) + 1;
    countriesByLink.set(row.linkId, map);
  }

  return new Map(
    linkIds.map((id) => [
      id,
      {
        rawClicks: rawMap.get(id) ?? 0,
        humanClicks: humanMap.get(id) ?? 0,
        formSubmissions: leadMap.get(id) ?? 0,
        countries: countriesByLink.get(id) ?? {},
      },
    ]),
  );
}

export async function trackedLinksRoutes(app: FastifyInstance): Promise<void> {
  // ── Public redirect (no auth) ──
  app.get('/go/:slug', async (req, reply) => {
    const slug = slugSchema.safeParse((req.params as { slug: string }).slug);
    if (!slug.success) return reply.status(404).send('Not found');

    const link = await prisma.trackedLink.findUnique({ where: { slug: slug.data } });
    if (!link || !link.isActive) return reply.status(404).send('Link not found');

    const ip = clientIp(req);
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
    const referer = typeof req.headers.referer === 'string' ? req.headers.referer : undefined;
    const bot = isLikelyBot(ua);
    const preview = isLikelyPreviewBot(ua);
    const geo = await resolveGeo(ip, req.headers);

    await prisma.linkClick.create({
      data: {
        linkId: link.id,
        ip,
        userAgent: ua?.slice(0, 500),
        referer: referer?.slice(0, 500),
        isBot: bot,
        isPreview: preview,
        isHuman: false,
        country: geo.country,
        countryCode: geo.countryCode,
        region: geo.region,
      },
    });

    reply.header('Cache-Control', 'no-store');
    return reply.type('text/html; charset=utf-8').send(redirectHtml(link.slug, link.destinationUrl));
  });

  app.post('/go/:slug/p', async (req, reply) => {
    const slug = slugSchema.safeParse((req.params as { slug: string }).slug);
    if (!slug.success) return reply.status(404).send({ error: 'Not found' });

    const ip = clientIp(req);
    if (!rateLimit(`go-ping:${slug.data}:${ip}`, 20, 60 * 60 * 1000)) {
      return reply.status(429).send({ error: 'Too many requests' });
    }

    const link = await prisma.trackedLink.findUnique({ where: { slug: slug.data } });
    if (!link || !link.isActive) return reply.status(404).send({ error: 'Not found' });

    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
    if (isLikelyBot(ua)) return { ok: true };

    const geo = await resolveGeo(ip, req.headers);
    const referer = typeof req.headers.referer === 'string' ? req.headers.referer : undefined;

    // Mark the most recent unconfirmed click from this IP as human, or create a new one.
    const recent = await prisma.linkClick.findFirst({
      where: { linkId: link.id, ip, isHuman: false },
      orderBy: { clickedAt: 'desc' },
    });

    if (recent && Date.now() - recent.clickedAt.getTime() < 5 * 60 * 1000) {
      await prisma.linkClick.update({
        where: { id: recent.id },
        data: { isHuman: true, isBot: false },
      });
    } else {
      await prisma.linkClick.create({
        data: {
          linkId: link.id,
          ip,
          userAgent: ua?.slice(0, 500),
          referer: referer?.slice(0, 500),
          isBot: false,
          isPreview: false,
          isHuman: true,
          country: geo.country,
          countryCode: geo.countryCode,
          region: geo.region,
        },
      });
    }

    return { ok: true };
  });

  // ── Admin CRUD ──
  app.get('/api/links', { onRequest: [app.authenticate] }, async () => {
    const links = await prisma.trackedLink.findMany({ orderBy: { createdAt: 'desc' } });
    const stats = await aggregateLinkStats(links.map((l) => l.id));

    return links.map((l) => ({
      ...l,
      trackingUrl: trackingUrl(l.slug),
      stats: stats.get(l.id) ?? { rawClicks: 0, humanClicks: 0, formSubmissions: 0, countries: {} },
    }));
  });

  app.post('/api/links', { onRequest: [app.authenticate] }, async (req, reply) => {
    const parsed = createLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid data', details: parsed.error.flatten().fieldErrors });
    }

    const preferred = parsed.data.slug ?? slugify(parsed.data.name);
    const slug = await uniqueSlug(preferred);
    const destinationUrl = parsed.data.destinationUrl ?? defaultDestination(slug);

    const link = await prisma.trackedLink.create({
      data: {
        name: parsed.data.name,
        slug,
        destinationUrl,
        isActive: parsed.data.isActive ?? true,
      },
    });

    return {
      ...link,
      trackingUrl: trackingUrl(link.slug),
      stats: { rawClicks: 0, humanClicks: 0, formSubmissions: 0, countries: {} },
    };
  });

  app.put('/api/links/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = updateLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid data', details: parsed.error.flatten().fieldErrors });
    }

    const existing = await prisma.trackedLink.findUnique({ where: { id } });
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    if (parsed.data.slug && parsed.data.slug !== existing.slug) {
      const taken = await prisma.trackedLink.findUnique({ where: { slug: parsed.data.slug } });
      if (taken) return reply.status(409).send({ error: 'Slug already in use' });
    }

    const link = await prisma.trackedLink.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.slug !== undefined ? { slug: parsed.data.slug } : {}),
        ...(parsed.data.destinationUrl !== undefined ? { destinationUrl: parsed.data.destinationUrl } : {}),
        ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      },
    });

    const stats = await aggregateLinkStats([link.id]);
    return {
      ...link,
      trackingUrl: trackingUrl(link.slug),
      stats: stats.get(link.id),
    };
  });

  app.delete('/api/links/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.trackedLink.findUnique({ where: { id } });
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    try {
      await prisma.$transaction([
        prisma.linkClick.deleteMany({ where: { linkId: id } }),
        prisma.landingLead.updateMany({ where: { linkId: id }, data: { linkId: null } }),
        prisma.trackedLink.delete({ where: { id } }),
      ]);
      return reply.status(204).send();
    } catch (err) {
      req.log.error({ err, id }, 'Failed to delete tracked link');
      return reply.status(500).send({ error: 'Failed to delete link' });
    }
  });

  app.get('/api/links/:id/clicks', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const link = await prisma.trackedLink.findUnique({ where: { id } });
    if (!link) return reply.status(404).send({ error: 'Not found' });

    const clicks = await prisma.linkClick.findMany({
      where: { linkId: id },
      orderBy: { clickedAt: 'desc' },
      take: 200,
    });

    return clicks;
  });
}
