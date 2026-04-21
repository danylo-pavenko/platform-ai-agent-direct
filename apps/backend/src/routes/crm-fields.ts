/**
 * crm-fields.ts
 *
 * Admin CRUD for CrmFieldMapping — the per-tenant bridge between local
 * slugs (used in Claude tool output) and CRM-side custom-field UUIDs.
 *
 * Exposes:
 *   GET    /crm-fields/available?scope=buyer|order   (live from CRM)
 *   GET    /crm-fields/mappings
 *   POST   /crm-fields/mappings
 *   PATCH  /crm-fields/mappings/:id
 *   DELETE /crm-fields/mappings/:id
 *
 * Every mutation calls invalidateCrmFieldMappingsCache() so the next
 * inbound message picks up fresh schema without a process restart.
 */

import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { invalidateCrmFieldMappingsCache } from '../lib/crm-field-mappings.js';
import { getCrmAdapter } from '../services/crm/index.js';

const VALID_SCOPES = ['buyer', 'order', 'lead'] as const;
type Scope = (typeof VALID_SCOPES)[number];
const SCOPE_ERROR = 'scope must be "buyer", "order" or "lead"';

interface CreateBody {
  localKey?: string;
  crmFieldKey?: string;
  scope?: string;
  label?: string;
  promptHint?: string | null;
  extractType?: string;
  options?: string[];
  isActive?: boolean;
}

interface UpdateBody {
  crmFieldKey?: string;
  scope?: string;
  label?: string;
  promptHint?: string | null;
  extractType?: string;
  options?: string[];
  isActive?: boolean;
}

function isScope(v: unknown): v is Scope {
  return typeof v === 'string' && VALID_SCOPES.includes(v as Scope);
}

export async function crmFieldsRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /available — live custom-field catalogue from the active CRM ──
  app.get<{
    Querystring: { scope?: string };
  }>('/available', { onRequest: [app.authenticate] }, async (request, reply) => {
    const scope = request.query.scope;
    if (!isScope(scope)) {
      return reply.code(400).send({ error: SCOPE_ERROR });
    }

    const crm = getCrmAdapter();
    if (!crm.listCustomFields) {
      return reply.code(501).send({
        error: `CRM provider "${crm.name}" does not expose custom-field discovery`,
      });
    }

    try {
      const fields = await crm.listCustomFields(scope);
      return { data: fields };
    } catch (err) {
      app.log.error({ err, scope }, 'Failed to list CRM custom fields');
      return reply.code(502).send({ error: 'Failed to fetch custom fields from CRM' });
    }
  });

  // ── GET /mappings — list all mappings (active + inactive) ──
  app.get('/mappings', { onRequest: [app.authenticate] }, async () => {
    const data = await prisma.crmFieldMapping.findMany({
      orderBy: [{ scope: 'asc' }, { label: 'asc' }],
    });
    return { data };
  });

  // ── POST /mappings — create a new mapping ──
  app.post<{ Body: CreateBody }>(
    '/mappings',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const b = request.body ?? {};
      const localKey = b.localKey?.trim();
      const crmFieldKey = b.crmFieldKey?.trim();
      const label = b.label?.trim();

      if (!localKey) return reply.code(400).send({ error: 'localKey is required' });
      if (!crmFieldKey) return reply.code(400).send({ error: 'crmFieldKey is required' });
      if (!label) return reply.code(400).send({ error: 'label is required' });
      if (!isScope(b.scope)) {
        return reply.code(400).send({ error: SCOPE_ERROR });
      }

      // Reject keys that would break the tool schema — Claude uses these as
      // JSON property names, so they must be a plain identifier-like slug.
      if (!/^[a-z][a-z0-9_]*$/.test(localKey)) {
        return reply.code(400).send({
          error: 'localKey must be lowercase snake_case (letters, digits, underscore)',
        });
      }

      const existing = await prisma.crmFieldMapping.findUnique({ where: { localKey } });
      if (existing) {
        return reply.code(409).send({ error: `Mapping with localKey "${localKey}" already exists` });
      }

      const created = await prisma.crmFieldMapping.create({
        data: {
          localKey,
          crmFieldKey,
          scope: b.scope,
          label,
          promptHint: b.promptHint?.trim() || null,
          extractType: b.extractType?.trim() || 'text',
          options: Array.isArray(b.options) ? b.options.filter((o) => typeof o === 'string') : [],
          isActive: b.isActive ?? true,
        },
      });

      invalidateCrmFieldMappingsCache();
      return reply.code(201).send(created);
    },
  );

  // ── PATCH /mappings/:id — partial update ──
  app.patch<{ Params: { id: string }; Body: UpdateBody }>(
    '/mappings/:id',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const b = request.body ?? {};
      const data: Record<string, unknown> = {};

      if (b.crmFieldKey !== undefined) {
        const v = b.crmFieldKey.trim();
        if (!v) return reply.code(400).send({ error: 'crmFieldKey cannot be empty' });
        data.crmFieldKey = v;
      }
      if (b.scope !== undefined) {
        if (!isScope(b.scope)) {
          return reply.code(400).send({ error: SCOPE_ERROR });
        }
        data.scope = b.scope;
      }
      if (b.label !== undefined) {
        const v = b.label.trim();
        if (!v) return reply.code(400).send({ error: 'label cannot be empty' });
        data.label = v;
      }
      if (b.promptHint !== undefined) {
        data.promptHint = b.promptHint?.trim() || null;
      }
      if (b.extractType !== undefined) {
        data.extractType = b.extractType.trim() || 'text';
      }
      if (b.options !== undefined) {
        data.options = Array.isArray(b.options) ? b.options.filter((o) => typeof o === 'string') : [];
      }
      if (b.isActive !== undefined) {
        data.isActive = b.isActive;
      }

      if (Object.keys(data).length === 0) {
        return reply.code(400).send({ error: 'No updatable fields provided' });
      }

      try {
        const updated = await prisma.crmFieldMapping.update({
          where: { id: request.params.id },
          data,
        });
        invalidateCrmFieldMappingsCache();
        return updated;
      } catch {
        return reply.code(404).send({ error: 'Mapping not found' });
      }
    },
  );

  // ── DELETE /mappings/:id ──
  app.delete<{ Params: { id: string } }>(
    '/mappings/:id',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      try {
        await prisma.crmFieldMapping.delete({ where: { id: request.params.id } });
        invalidateCrmFieldMappingsCache();
        return reply.code(204).send();
      } catch {
        return reply.code(404).send({ error: 'Mapping not found' });
      }
    },
  );
}
