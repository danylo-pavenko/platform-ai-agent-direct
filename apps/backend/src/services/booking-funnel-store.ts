import pino from 'pino';
import { Prisma } from '../generated/prisma/client.js';
import { prisma, toInputJsonValue } from '../lib/prisma.js';
import {
  freshBookingFunnel,
  parseBookingFunnel,
  type BookingFunnel,
} from '../lib/booking-funnel.js';

const log = pino({ name: 'booking-funnel-store' });

export async function loadFreshBookingFunnel(
  conversationId: string,
  now = new Date(),
): Promise<BookingFunnel | null> {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { bookingFunnel: true },
  });
  return freshBookingFunnel(row?.bookingFunnel, now);
}

export async function persistBookingFunnel(
  conversationId: string,
  funnel: BookingFunnel | null,
): Promise<void> {
  try {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        bookingFunnel: funnel ? (toInputJsonValue(funnel) ?? Prisma.DbNull) : Prisma.DbNull,
      },
    });
  } catch (err) {
    log.warn({ err, conversationId }, 'Failed to persist booking funnel');
  }
}

export async function clearConversationBookingFunnel(conversationId: string): Promise<void> {
  await persistBookingFunnel(conversationId, null);
}

/** Load raw parsed funnel even if expired (for tests / diagnostics). */
export async function loadParsedBookingFunnel(
  conversationId: string,
): Promise<BookingFunnel | null> {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { bookingFunnel: true },
  });
  return parseBookingFunnel(row?.bookingFunnel);
}
