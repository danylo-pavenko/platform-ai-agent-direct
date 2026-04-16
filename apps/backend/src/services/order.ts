import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import { sendText } from './instagram.js';
import { notifyOrder } from './telegram-notify.js';

const log = pino({ name: 'order' });

const VALID_PAYMENT_METHODS = ['card', 'transfer', 'cod'] as const;
type PaymentMethod = (typeof VALID_PAYMENT_METHODS)[number];

function toPaymentMethod(value: unknown): PaymentMethod {
  if (typeof value === 'string' && VALID_PAYMENT_METHODS.includes(value as PaymentMethod)) {
    return value as PaymentMethod;
  }
  return 'cod';
}

/**
 * Handles the `collect_order` tool call from Claude.
 *
 * Creates the order in DB, confirms to the client via IG,
 * and notifies the manager group in Telegram.
 */
export async function handleCollectOrder(
  conversationId: string,
  clientId: string,
  clientIgUserId: string,
  args: Record<string, unknown>,
): Promise<void> {
  const items = args.items as Array<{
    name: string;
    variant?: string;
    price: number;
    qty: number;
  }>;
  const customerName = args.customer_name as string;
  const phone = args.phone as string;
  const city = args.city as string;
  const npBranch = args.np_branch as string;
  const paymentMethod = toPaymentMethod(args.payment_method);
  const note = (args.note as string) || null;

  // Normalise qty: default to 1 if missing
  const normalisedItems = items.map((item) => ({
    name: item.name,
    variant: item.variant ?? undefined,
    price: item.price,
    qty: item.qty ?? 1,
  }));

  // 1. Create order in DB
  const order = await prisma.order.create({
    data: {
      conversationId,
      clientId,
      items: normalisedItems as any,
      customerName,
      phone,
      city,
      npBranch,
      paymentMethod,
      note,
      status: 'submitted',
      submittedToManagerAt: new Date(),
    },
  });

  // 2. Send confirmation to client via Instagram
  const confirmationText =
    'Замовлення прийнято! Менеджер підтвердить і напише вам найближчим часом.';

  await sendText(clientIgUserId, confirmationText);

  // 3. Persist the bot confirmation message
  await prisma.message.create({
    data: {
      conversationId,
      direction: 'out',
      sender: 'bot',
      text: confirmationText,
    },
  });

  // 4. Send Telegram notification to manager group
  await notifyOrder({
    orderId: order.id,
    conversationId,
    clientIgUserId,
    items: normalisedItems,
    customerName,
    phone,
    city,
    npBranch,
    paymentMethod,
  });

  log.info(
    { orderId: order.id, conversationId, itemCount: normalisedItems.length },
    'Order created and notifications sent',
  );
}
