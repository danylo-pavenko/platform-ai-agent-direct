/**
 * Branch (salon location) management — manual config or CRM import.
 */

import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { resolveCrmProvider } from '../lib/crm-routing.js';
import { getCrmAdapter } from '../services/crm/index.js';

const slugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'slug: lowercase letters, digits, _ -');

export const branchInputSchema = z.object({
  slug: slugSchema,
  displayName: z.string().min(1).max(200),
  keywords: z.array(z.string().min(1).max(80)).default([]),
  address: z.string().max(500).optional(),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

export const branchUpdateSchema = branchInputSchema.partial().omit({ slug: true });

export type BranchInput = z.infer<typeof branchInputSchema>;

export async function listBranches(opts?: { activeOnly?: boolean }) {
  return prisma.branch.findMany({
    where: opts?.activeOnly ? { isActive: true } : undefined,
    orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
  });
}

export async function getBranchById(id: string) {
  return prisma.branch.findUnique({ where: { id } });
}

export async function getBranchBySlug(slug: string) {
  return prisma.branch.findUnique({ where: { slug } });
}

async function clearOtherDefaults(exceptId?: string) {
  await prisma.branch.updateMany({
    where: exceptId ? { isDefault: true, id: { not: exceptId } } : { isDefault: true },
    data: { isDefault: false },
  });
}

export async function createBranch(
  input: BranchInput,
  source: 'manual' | 'crm' = 'manual',
) {
  const data = branchInputSchema.parse(input);
  if (data.isDefault) await clearOtherDefaults();

  return prisma.branch.create({
    data: {
      ...data,
      source,
    },
  });
}

export async function updateBranch(id: string, input: z.infer<typeof branchUpdateSchema>) {
  const data = branchUpdateSchema.parse(input);
  if (data.isDefault) await clearOtherDefaults(id);

  return prisma.branch.update({
    where: { id },
    data,
  });
}

export async function deleteBranch(id: string) {
  await prisma.branch.delete({ where: { id } });
}

export interface CrmBranchCandidate {
  externalId: string;
  name: string;
  address?: string;
  provider: string;
  metadata?: Record<string, unknown>;
}

/**
 * Pull branch list from the active CRM adapter (CleverBOX filials when implemented).
 * KeyCRM has no native branch concept — returns empty with a hint.
 */
export async function getDefaultBranch() {
  return prisma.branch.findFirst({
    where: { isActive: true, isDefault: true },
    orderBy: { sortOrder: 'asc' },
  });
}

export async function resolveBranchSlug(slug: string) {
  const branch = await getBranchBySlug(slug.trim().toLowerCase());
  if (!branch || !branch.isActive) return null;
  return branch;
}

export async function fetchBranchesFromCrm(providerOverride?: string): Promise<{
  provider: string;
  branches: CrmBranchCandidate[];
  hint?: string;
}> {
  let providerName: string;
  try {
    providerName = providerOverride ?? (await resolveCrmProvider('branches'));
  } catch {
    providerName = 'keycrm';
  }

  const crm = getCrmAdapter(
    providerName === 'cleverbox' ? 'cleverbox' : providerName === 'keycrm' ? 'keycrm' : undefined,
  );

  if (typeof crm.fetchBranches !== 'function') {
    return {
      provider: crm.name,
      branches: [],
      hint:
        providerName === 'keycrm'
          ? 'KeyCRM не має філій — додайте локації вручну або підключіть CleverBOX.'
          : `Провайдер ${crm.name} не підтримує імпорт філій.`,
    };
  }

  const rows = await crm.fetchBranches();
  return {
    provider: crm.name,
    branches: rows.map((b) => ({
      externalId: b.id,
      name: b.name,
      address: b.address,
      provider: crm.name,
      metadata: b.metadata,
    })),
  };
}

export interface ImportBranchesOptions {
  externalIds?: string[];
  slugPrefix?: string;
}

function slugifyName(name: string, prefix?: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48);
  const raw = prefix ? `${prefix}-${base}` : base;
  const parsed = slugSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return `branch-${base.slice(0, 20) || 'crm'}`.replace(/[^a-z0-9_-]/g, '');
}

export async function importBranchesFromCrm(opts: ImportBranchesOptions = {}) {
  const { branches, provider, hint } = await fetchBranchesFromCrm();
  if (branches.length === 0) {
    return { imported: 0, updated: 0, skipped: 0, hint, provider };
  }

  const selected =
    opts.externalIds && opts.externalIds.length > 0
      ? branches.filter((b) => opts.externalIds!.includes(b.externalId))
      : branches;

  const skipped =
    opts.externalIds && opts.externalIds.length > 0
      ? branches.length - selected.length
      : 0;

  let imported = 0;
  let updated = 0;

  for (const candidate of selected) {
    const existing = await prisma.branch.findFirst({
      where: {
        crmProvider: candidate.provider,
        crmExternalId: candidate.externalId,
      },
    });

    if (existing) {
      await prisma.branch.update({
        where: { id: existing.id },
        data: {
          displayName: candidate.name,
          address: candidate.address ?? existing.address,
          crmSyncedAt: new Date(),
          metadata: candidate.metadata ?? undefined,
        },
      });
      updated++;
      continue;
    }

    let slug = slugifyName(candidate.name, opts.slugPrefix);
    let suffix = 1;
    while (await prisma.branch.findUnique({ where: { slug } })) {
      slug = `${slugifyName(candidate.name, opts.slugPrefix)}-${suffix++}`;
    }

    await prisma.branch.create({
      data: {
        slug,
        displayName: candidate.name,
        address: candidate.address,
        source: 'crm',
        crmProvider: candidate.provider,
        crmExternalId: candidate.externalId,
        crmSyncedAt: new Date(),
        metadata: candidate.metadata ?? undefined,
        keywords: [],
      },
    });
    imported++;
  }

  return { imported, updated, skipped, hint, provider };
}

export async function formatBranchesForPrompt(): Promise<string> {
  const rows = await listBranches({ activeOnly: true });
  if (rows.length === 0) return '(філії не налаштовані)';

  return rows
    .map((b) => {
      const kw = b.keywords.length > 0 ? ` | ключові слова: ${b.keywords.join(', ')}` : '';
      const addr = b.address ? ` | ${b.address}` : '';
      return `- [${b.slug}] ${b.displayName}${addr}${kw}`;
    })
    .join('\n');
}
