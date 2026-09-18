import pino from 'pino';
import { Prisma } from '../generated/prisma/client.js';
import { prisma, toInputJsonValue } from '../lib/prisma.js';
import {
  isFreshBookingSlotOffer,
  parseBookingSlotOffer,
  type BookingSlotOffer,
} from '../lib/booking-slot-offer.js';

const log = pino({ name: 'booking-slot-offer-store' });

export async function loadFreshBookingSlotOffer(
  conversationId: string,
  now = new Date(),
): Promise<BookingSlotOffer | null> {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { bookingOffer: true },
  });
  const offer = parseBookingSlotOffer(row?.bookingOffer);
  if (!isFreshBookingSlotOffer(offer, now)) return null;
  return offer;
}

export async function persistBookingSlotOffer(
  conversationId: string,
  offer: BookingSlotOffer | null,
): Promise<void> {
  try {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        bookingOffer: offer ? (toInputJsonValue(offer) ?? Prisma.DbNull) : Prisma.DbNull,
      },
    });
  } catch (err) {
    log.warn({ err, conversationId }, 'Failed to persist booking slot offer');
  }
}

export async function clearConversationBookingOffer(conversationId: string): Promise<void> {
  await persistBookingSlotOffer(conversationId, null);
}
