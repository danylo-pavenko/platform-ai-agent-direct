import { prisma } from '../lib/prisma.js';
import type { IgAdReferral } from '../lib/ig-ad-referral.js';

/**
 * Sticky conversation referral (first wins) + client first/last attribution.
 */
export async function persistIgAdReferralAttribution(opts: {
  conversationId: string;
  clientId: string;
  referral: IgAdReferral;
  conversationHadReferral: boolean;
}): Promise<void> {
  const { conversationId, clientId, referral, conversationHadReferral } = opts;
  const now = new Date();
  const json = referral as unknown as object;

  await prisma.$transaction(async (tx) => {
    if (!conversationHadReferral) {
      await tx.conversation.update({
        where: { id: conversationId },
        data: { igAdReferral: json },
      });
    }

    const client = await tx.client.findUnique({
      where: { id: clientId },
      select: { igAdFirstAt: true },
    });
    await tx.client.update({
      where: { id: clientId },
      data: {
        igAdReferral: json,
        igAdLastAt: now,
        ...(client?.igAdFirstAt ? {} : { igAdFirstAt: now }),
      },
    });
  });
}
