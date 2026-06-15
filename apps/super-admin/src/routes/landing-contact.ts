import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { rateLimit } from '../lib/rate-limit.js';
import { sendLeadEmail } from '../lib/resend.js';
import { clientIp } from '../lib/client-ip.js';
import { resolveGeo } from '../lib/geo.js';
import { prisma } from '../lib/prisma.js';

const optionalEmail = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().email().max(254).optional(),
);

const contactSchema = z
  .object({
    name: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().max(120).optional(),
    ),
    email: optionalEmail,
    instagram: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().max(120).optional(),
    ),
    messenger: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().max(200).optional(),
    ),
    message: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().max(2000).optional(),
    ),
    plan: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().max(40).optional(),
    ),
    lang: z.enum(['uk', 'en']).optional(),
    pageUrl: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().url().max(500).optional(),
    ),
    referer: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().max(500).optional(),
    ),
    ref: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().max(48).optional(),
    ),
    website: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.website?.trim()) return;
    if (!data.email && !data.instagram && !data.messenger) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide at least email, Instagram, or messenger',
        path: ['email'],
      });
    }
  });

export async function landingContactRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/landing/contact', async (req, reply) => {
    if (!config.RESEND_API_KEY) {
      return reply.status(503).send({ error: 'Contact form is temporarily unavailable' });
    }

    const ip = clientIp(req);
    if (!rateLimit(`landing-contact:${ip}`, 8, 60 * 60 * 1000)) {
      return reply.status(429).send({ error: 'Too many requests. Try again later.' });
    }

    const parsed = contactSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid form data',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const data = parsed.data;
    if (data.website?.trim()) {
      return { ok: true };
    }

    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
    const geo = await resolveGeo(ip, req.headers);

    let linkId: string | null = null;
    if (data.ref) {
      const link = await prisma.trackedLink.findUnique({ where: { slug: data.ref } });
      if (link) linkId = link.id;
    }

    const lead = await prisma.landingLead.create({
      data: {
        linkId,
        refSlug: data.ref ?? null,
        name: data.name ?? null,
        email: data.email ?? null,
        instagram: data.instagram ?? null,
        messenger: data.messenger ?? null,
        message: data.message ?? null,
        plan: data.plan ?? null,
        lang: data.lang ?? null,
        pageUrl: data.pageUrl ?? null,
        referer: data.referer ?? null,
        ip,
        userAgent: ua?.slice(0, 500) ?? null,
        country: geo.country,
        countryCode: geo.countryCode,
        region: geo.region,
      },
    });

    try {
      await sendLeadEmail({
        name: data.name,
        email: data.email || undefined,
        instagram: data.instagram,
        messenger: data.messenger,
        message: data.message,
        plan: data.plan,
        lang: data.lang,
        pageUrl: data.pageUrl,
        ref: data.ref,
      });
      await prisma.landingLead.update({
        where: { id: lead.id },
        data: { emailSent: true },
      });
      app.log.info({ ip, plan: data.plan, ref: data.ref, leadId: lead.id }, 'Landing contact lead sent');
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await prisma.landingLead.update({
        where: { id: lead.id },
        data: { emailError: message.slice(0, 500) },
      });
      app.log.error({ err, ip, leadId: lead.id }, 'Failed to send landing contact email');
      return reply.status(502).send({ error: 'Failed to send message. Please try again.' });
    }
  });
}
