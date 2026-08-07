/**
 * Resolve CRM location/branch id for get_available_slots / booking.
 * Order: conversation branch → default branch → first active with CRM id → BeautyPro defaultLocationId.
 */
import { prisma } from '../lib/prisma.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { getDefaultBranch } from './branches.js';

export async function resolveBookingBranchCrmId(
  conversationBranchCrmId?: string | null,
): Promise<string | null> {
  const resolved = await resolveBookingBranchForAppointment({
    conversationBranchCrmId,
  });
  return resolved?.crmExternalId ?? null;
}

export type ResolvedBookingBranch = {
  /** Local Branch.id when known (may be null if only BeautyPro defaultLocationId). */
  branchId: string | null;
  crmExternalId: string;
  displayName: string | null;
  source: 'conversation' | 'default' | 'first_active' | 'beautypro_default';
};

/**
 * Resolve salon location for book_appointment — same cascade as slots,
 * but also returns the local Branch row when available.
 */
export async function resolveBookingBranchForAppointment(opts?: {
  conversationBranchId?: string | null;
  conversationBranchCrmId?: string | null;
}): Promise<ResolvedBookingBranch | null> {
  const convBranchId = opts?.conversationBranchId?.trim() || null;
  if (convBranchId) {
    const branch = await prisma.branch.findUnique({ where: { id: convBranchId } });
    const crmId = branch?.crmExternalId?.trim();
    if (crmId) {
      return {
        branchId: branch!.id,
        crmExternalId: crmId,
        displayName: branch!.displayName,
        source: 'conversation',
      };
    }
  }

  const fromConversationCrm = opts?.conversationBranchCrmId?.trim();
  if (fromConversationCrm) {
    const byCrm = await prisma.branch.findFirst({
      where: { crmExternalId: fromConversationCrm },
    });
    return {
      branchId: byCrm?.id ?? null,
      crmExternalId: fromConversationCrm,
      displayName: byCrm?.displayName ?? null,
      source: 'conversation',
    };
  }

  const def = await getDefaultBranch();
  if (def?.crmExternalId?.trim()) {
    return {
      branchId: def.id,
      crmExternalId: def.crmExternalId.trim(),
      displayName: def.displayName,
      source: 'default',
    };
  }

  const first = await prisma.branch.findFirst({
    where: {
      isActive: true,
      NOT: { crmExternalId: null },
    },
    orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
  });
  if (first?.crmExternalId?.trim()) {
    return {
      branchId: first.id,
      crmExternalId: first.crmExternalId.trim(),
      displayName: first.displayName,
      source: 'first_active',
    };
  }

  const { beautypro } = await getIntegrationConfig();
  const loc = beautypro.defaultLocationId?.trim();
  if (loc) {
    const byCrm = await prisma.branch.findFirst({
      where: { crmExternalId: loc },
    });
    return {
      branchId: byCrm?.id ?? null,
      crmExternalId: loc,
      displayName: byCrm?.displayName ?? null,
      source: 'beautypro_default',
    };
  }

  return null;
}
