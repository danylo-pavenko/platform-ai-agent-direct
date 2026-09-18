/**
 * Tenant-admin chat actions in Conversation Detail:
 * send payment requisites, force a logical reply, complete an order.
 */

import {
  modeHasBookingTools,
  modeHasLeadgenTools,
  modeHasSalesTools,
  type AgentMode,
} from './tool-definitions.js';

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

export type ManagerForcedTurnKnownClient = {
  displayName?: string | null;
  phone?: string | null;
  email?: string | null;
  deliveryCity?: string | null;
  deliveryNpBranch?: string | null;
};

function formatKnownClientLine(c?: ManagerForcedTurnKnownClient | null): string {
  const known: string[] = [];
  const name = c?.displayName?.trim();
  const phone = c?.phone?.trim();
  const email = c?.email?.trim();
  const city = c?.deliveryCity?.trim();
  const np = c?.deliveryNpBranch?.trim();
  if (name) known.push(`імʼя ${name}`);
  if (phone) known.push(`телефон ${phone}`);
  if (email) known.push(`email ${email}`);
  if (city) known.push(`місто ${city}`);
  if (np) known.push(`НП ${np}`);
  return known.length > 0
    ? `Вже в профілі платформи: ${known.join(', ')}. Не питай повторно, якщо клієнт це вже назвав.`
    : 'У профілі ще немає контактів — якщо вони є в історії/фото/поточному блоці, одразу update_client_info.';
}

export function formatManagerForcedKnownFacts(params: {
  agentMode?: AgentMode;
  knownClient?: ManagerForcedTurnKnownClient | null;
  hasFreshSlotOffer?: boolean;
}): string {
  const mode = params.agentMode ?? 'general';
  const lines: string[] = [`Режим агента: ${mode}`, formatKnownClientLine(params.knownClient)];
  if (modeHasBookingTools(mode)) {
    if (params.hasFreshSlotOffer) {
      lines.push(
        'Запропоновані вікна в сесії: ТАК. Якщо клієнт обирає одну з тих годин — book_appointment без нового get_available_slots.',
      );
    } else {
      lines.push(
        'Запропоновані вікна в сесії: немає свіжих. Якщо клієнт питає час/запис — search_services (якщо ще немає id) і get_available_slots, потім 2–3 години.',
      );
    }
  }
  return lines.join('\n');
}

function analyzeReplyScenarioPlaybook(mode: AgentMode): string {
  const blocks: string[] = [
    'Спільне (якщо дані вже є, а tool ще не викликали):',
    '- update_client_info — ПІБ, телефон, email, місто, НП, custom_fields з чату/фото.',
    '- set_conversation_branch — якщо клієнт обрав філію.',
    '- Дивись фото, поділений пост, Stories і історію цього дня. Не вигадуй ціну/наявність/вікна.',
  ];

  if (modeHasSalesTools(mode)) {
    blocks.push(
      'Продаж товару:',
      '- search_catalog за словами клієнта або підписом поста; get_delivery_cost якщо є місто. Ціна клієнту — з результату tool, не з голови.',
      '- Підтвердь товар/розмір/колір з чату або фото. Якщо клієнт питає оплату — реквізити з блоку нижче, не вигадуй карту.',
      '- Не викликай collect_order / create_local_order (для цього є «Оформити замовлення»). Якщо клієнт уже готовий купити — коротко підтверди позицію, доставку і наступний крок зі системного промпту; клієнту не згадуй кнопки адмінки.',
    );
  }

  if (modeHasBookingTools(mode)) {
    blocks.push(
      'Запис / послуга:',
      '- Факти послуг — search_services. get_client_crm_history — якщо є телефон/привʼязка.',
      '- get_available_slots — лише коли свіжих «Запропонованих вікон» немає або змінили послугу/дату/майстра.',
      '- Якщо клієнт підтвердив конкретну годину з запропонованих вікон і є імʼя+телефон — book_appointment. Перенесення → reschedule_appointment; скасування → cancel_appointment / remove_appointment_service. Не другий book як move.',
    );
  }

  if (modeHasLeadgenTools(mode)) {
    blocks.push(
      'Лід / кваліфікація:',
      '- classify_intent за потреби. submit_brief — лише коли бриф уже зібраний у чаті.',
    );
  }

  if (mode === 'general') {
    blocks.push(
      'Режим general: обери сценарій за наміром клієнта (товар vs запис vs бриф). Не змішуй collect_order і book_appointment в одній відповіді без потреби.',
    );
  }

  return blocks.join('\n');
}

export function buildManagerForcedTurnUserMessage(params: {
  action: ManagerForcedClaudeAction;
  unansweredClientText: string;
  paymentRequisites: string;
  agentMode?: AgentMode;
  knownClient?: ManagerForcedTurnKnownClient | null;
  hasFreshSlotOffer?: boolean;
}): string {
  const { action, unansweredClientText, paymentRequisites } = params;
  const latest = unansweredClientText.trim()
    ? unansweredClientText.trim()
    : '[Немає нового тексту від клієнта — орієнтуйся на історію чату, блоки сесії та вкладення (фото / платіжка / Stories).]';

  const requisitesBlock = paymentRequisites.trim()
    ? `\nРеквізити тенанта (надсилай клієнту ЛИШЕ якщо просить карту/оплату, не вигадуй інші):\n---\n${paymentRequisites.trim()}\n---`
    : '\nРеквізити в налаштуваннях не заповнені — не вигадуй IBAN/карту.';

  if (action === 'analyze_reply') {
    const mode = params.agentMode ?? 'general';
    const facts = formatManagerForcedKnownFacts({
      agentMode: mode,
      knownClient: params.knownClient,
      hasFreshSlotOffer: params.hasFreshSlotOffer,
    });
    const playbook = analyzeReplyScenarioPlaybook(mode);
    return `[Платформа] Менеджер натиснув «Відповісти по суті» в адмінці. Це ПРИМУСОВА відповідь клієнту — навіть якщо розмова в handoff.
Мета: одна змістовна відповідь по суті + дозаповнити стан платформи з історії цього дня, блоків сесії та фото.

${facts}

${playbook}

ЗАБОРОНЕНО: request_handoff, «менеджер відпише пізніше», повторне привітання.
Не викликай collect_order / create_local_order — для оформлення товару є окрема кнопка «Оформити замовлення».${requisitesBlock}

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
