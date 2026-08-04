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
  const fromConversation = conversationBranchCrmId?.trim();
  if (fromConversation) return fromConversation;

  const def = await getDefaultBranch();
  if (def?.crmExternalId?.trim()) return def.crmExternalId.trim();

  const first = await prisma.branch.findFirst({
    where: {
      isActive: true,
      NOT: { crmExternalId: null },
    },
    orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
  });
  if (first?.crmExternalId?.trim()) return first.crmExternalId.trim();

  const { beautypro } = await getIntegrationConfig();
  const loc = beautypro.defaultLocationId?.trim();
  return loc || null;
}
