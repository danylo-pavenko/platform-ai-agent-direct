import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { rateLimit } from '../lib/rate-limit.js';
import { sendLeadEmail } from '../lib/resend.js';

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

function clientIp(req: { ip: string; headers: Record<string, unknown> }): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]?.trim() || req.ip;
  }
  return req.ip;
}

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
      });
      app.log.info({ ip, plan: data.plan }, 'Landing contact lead sent');
      return { ok: true };
    } catch (err) {
      app.log.error({ err, ip }, 'Failed to send landing contact email');
      return reply.status(502).send({ error: 'Failed to send message. Please try again.' });
    }
  });
}
