/**
 * Tenant-admin chat actions in Conversation Detail:
 * send payment requisites, force a logical reply, complete an order.
 */

export const MANAGER_CHAT_ACTIONS = [
  'send_payment_details',
  'analyze_reply',
  'complete_order',
] as const;

export type ManagerChatAction = (typeof MANAGER_CHAT_ACTIONS)[number];

export type ManagerForcedClaudeAction = Exclude<ManagerChatAction, 'send_payment_details'>;

export const PAYMENT_REQUISITES_MAX_CHARS = 4000;

/** Stored on Order.note when the client sent a receipt / claimed they paid. */
export const PAYMENT_HUMAN_CONFIRM_NOTE =
  'Оплата: клієнт надіслав платіжку (або сказав, що оплатив). ПОТРІБНЕ ПІДТВЕРДЖЕННЯ ЛЮДИНИ — не вважати оплату фінально звіреною.';

export function isManagerChatAction(value: unknown): value is ManagerChatAction {
  return (
    typeof value === 'string' &&
    (MANAGER_CHAT_ACTIONS as readonly string[]).includes(value)
  );
}

export function normalizePaymentRequisites(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, PAYMENT_REQUISITES_MAX_CHARS);
}

/** Send the tenant text as-is; wrap only short raw IBAN/card blobs. */
export function formatPaymentRequisitesMessage(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  const looksComplete =
    t.includes('\n') ||
    t.length > 80 ||
    /реквізит|оплат|після оплати|квитанц/i.test(t);
  if (looksComplete) return t;
  return `Реквізити для оплати:\n\n${t}\n\nПісля оплати надішліть, будь ласка, скрін квитанції.`;
}

export function mergePaymentHumanConfirmNote(existing: unknown): string {
  const cur = typeof existing === 'string' ? existing.trim() : '';
  if (!cur) return PAYMENT_HUMAN_CONFIRM_NOTE;
  if (cur.includes('ПОТРІБНЕ ПІДТВЕРДЖЕННЯ ЛЮДИНИ')) return cur;
  return `${cur}\n${PAYMENT_HUMAN_CONFIRM_NOTE}`;
}

export function withCompleteOrderPaymentNote(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return { ...args, note: mergePaymentHumanConfirmNote(args.note) };
}

export function buildManagerForcedTurnUserMessage(params: {
  action: ManagerForcedClaudeAction;
  unansweredClientText: string;
  paymentRequisites: string;
}): string {
  const { action, unansweredClientText, paymentRequisites } = params;
  const latest = unansweredClientText.trim()
    ? unansweredClientText.trim()
    : '[Немає нового тексту від клієнта — орієнтуйся на історію чату та вкладення (фото / платіжка).]';

  const requisitesBlock = paymentRequisites.trim()
    ? `\nРеквізити тенанта (надсилай клієнту ЛИШЕ якщо просить карту/оплату, не вигадуй інші):\n---\n${paymentRequisites.trim()}\n---`
    : '\nРеквізити в налаштуваннях не заповнені — не вигадуй IBAN/карту.';

  if (action === 'analyze_reply') {
    return `[Платформа] Менеджер натиснув «Відповісти по суті» в адмінці. Це ПРИМУСОВА відповідь — навіть якщо розмова в handoff.
Дай одну логічну відповідь клієнту на останні повідомлення та фото.
ЗАБОРОНЕНО: request_handoff, collect_order, create_local_order, «менеджер відпише пізніше», повторне привітання.
Не оформлюй замовлення (для цього є окрема кнопка).${requisitesBlock}

Останнє від клієнта:
${latest}`;
  }

  return `[Платформа] Менеджер натиснув «Оформити замовлення» в адмінці. Це ПРИМУСОВА дія — навіть якщо розмова в handoff.
1. Якщо з контексту видно, що клієнт уже хоче оформити / надіслав дані / квитанцію — створи замовлення зараз.
2. collect_order, якщо є товар, ПІБ, телефон, місто і відділення/адреса НП.
3. Якщо відділення НП немає — create_local_order (kind=product) з відомими полями. Не вигадуй номер відділення.
4. Якщо є фото квитанції або клієнт написав, що оплатив: payment_method=transfer. У note обов'язково рядок: «${PAYMENT_HUMAN_CONFIRM_NOTE}» Коротко опиши, що видно на платіжці (сума, дата), без гарантії що бухгалтерія вже звірила.
5. update_client_info, якщо є нові ПІБ / телефон / місто.
6. Подякуй клієнту коротко, підтвердь що замовлення прийнято і людина перевірить оплату за потреби.
ЗАБОРОНЕНО: request_handoff, «менеджер відпише пізніше», повторне привітання.${requisitesBlock}

Останнє від клієнта:
${latest}`;
}
