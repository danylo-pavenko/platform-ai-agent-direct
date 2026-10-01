/**
 * Customer-facing shipment / TTN lookup.
 * CRM HTTP stays in the adapter (`lookupShipments`). This module loads the
 * current client, checks the order belongs to them, and formats a tool result.
 */

import pino from 'pino';
import { providerDisplayName, type CrmProviderName } from '../lib/crm-providers.js';
import { resolveCrmProvider } from '../lib/crm-routing.js';
import { prisma } from '../lib/prisma.js';
import { getCrmAdapter } from './crm/index.js';
import type { CrmShipment } from './crm/types.js';
import { trackNovaPoshtaDocument, type NpTrackingStatus } from './nova-poshta.js';

const log = pino({ name: 'shipment-lookup' });

const SHIPMENT_QUESTION_RE =
  /ттн|\btth\b|тth|накладн|трек(?:інг|-?\s*номер)?|відправ|посилк|нова\s*пошт/i;

export const SHIPMENT_LOOKUP_NUDGE =
  '[platform] Клієнт питає про відправку або ТТН. Заборонено request_handoff і заборонено казати «зʼєдную з менеджером» / «уточню дату», поки не викличеш lookup_order_shipment. Якщо в чаті є номер накладної — передай ttn. Якщо номера немає — виклич tool без аргументів (платформа візьме телефон профілю і локальні замовлення). Після результату відповідай лише фактами з tool. Не вигадуй статус «на виробництві», дату відправки чи номер ТТН.';

export function normalizeTrackingCode(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 10 && digits.length <= 20) return digits;
  return null;
}

export function textMentionsShipment(text: string): boolean {
  return SHIPMENT_QUESTION_RE.test(text);
}

export function turnMentionsShipment(
  currentText: string,
  history: Array<{ role: string; content: string }>,
): boolean {
  if (textMentionsShipment(currentText)) return true;
  const userTurns = history.filter((turn) => turn.role === 'user').slice(-8);
  return userTurns.some((turn) => textMentionsShipment(turn.content));
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

function phonesOverlap(left: string, right: string): boolean {
  const a = digitsOnly(left);
  const b = digitsOnly(right);
  if (a.length < 9 || b.length < 9) return false;
  return a === b || a.slice(-9) === b.slice(-9);
}

export function shipmentBelongsToClient(
  shipment: CrmShipment,
  identity: { phone?: string | null; buyerId?: string | null; orderIds: Set<string> },
): boolean {
  if (identity.orderIds.has(shipment.crmOrderId)) return true;
  if (identity.buyerId && shipment.buyerId && identity.buyerId === shipment.buyerId) return true;
  if (identity.phone) {
    return shipment.phones.some((phone) => phonesOverlap(identity.phone!, phone));
  }
  return false;
}

function buyerIdForProvider(
  provider: CrmProviderName,
  client: { crmBuyerId: string | null; crmProvider: string | null },
): string | undefined {
  const id = client.crmBuyerId?.trim();
  if (!id) return undefined;
  if (client.crmProvider && client.crmProvider !== provider) return undefined;
  if (provider === 'keycrm' && !/^\d+$/.test(id)) return undefined;
  return id;
}

function formatMoney(amount: number): string {
  const rounded = Math.round(amount);
  return Math.abs(amount - rounded) < 0.001 ? `${rounded} грн` : `${amount} грн`;
}

function formatWhen(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

function looksLikeNovaPoshta(shipment: CrmShipment): boolean {
  const carrier = (shipment.carrier ?? '').toLowerCase();
  if (/укрпошт|meest|justin/.test(carrier) && !/нова|nova/.test(carrier)) return false;
  const code = shipment.trackingCode ?? '';
  if (!/^\d{11,14}$/.test(code)) return false;
  if (carrier && !/нова|nova|нп/.test(carrier)) return false;
  return true;
}

function formatOwnedShipment(
  shipment: CrmShipment,
  index: number,
  timeZone: string,
  tracking: NpTrackingStatus | null,
): string {
  const lines: string[] = [];
  const status = shipment.statusName?.trim() || 'статус у CRM без назви';
  const closed = shipment.closed ? ' (закрите)' : '';
  lines.push(`${index}. Статус замовлення: ${status}${closed}`);
  if (shipment.items.length > 0) {
    const items = shipment.items
      .map((item) => (item.qty != null ? `${item.name} ×${item.qty}` : item.name))
      .join(', ');
    lines.push(`   Товари: ${items}`);
  }
  if (shipment.grandTotal != null) lines.push(`   Сума: ${formatMoney(shipment.grandTotal)}`);
  const place = [shipment.city, shipment.receivePoint].filter(Boolean).join(', ');
  if (place) lines.push(`   Доставка: ${place}`);
  if (shipment.recipientName) lines.push(`   Отримувач: ${shipment.recipientName}`);
  const created = formatWhen(shipment.createdAt, timeZone);
  if (created) lines.push(`   Створено: ${created}`);
  if (shipment.trackingCode) {
    const carrier = shipment.carrier?.trim() || 'перевізник';
    lines.push(`   ТТН (${carrier}): ${shipment.trackingCode}`);
    if (shipment.shippingStatus) lines.push(`   Статус доставки в CRM: ${shipment.shippingStatus}`);
    const shipped = formatWhen(shipment.shippedAt, timeZone);
    if (shipped) lines.push(`   Дата відправки в CRM: ${shipped}`);
    if (tracking) {
      const when = tracking.scheduledDeliveryDate
        ? `, орієнтовно ${tracking.scheduledDeliveryDate}`
        : '';
      lines.push(`   Статус Нової Пошти: ${tracking.status}${when}`);
    }
  } else {
    lines.push('   ТТН: ще немає — відправку в CRM не оформлено');
  }
  return lines.join('\n');
}

export interface FormatShipmentLookupInput {
  providerLabel: string;
  ttnQuery: string | null;
  owned: CrmShipment[];
  /** TTN exists in CRM but phones / buyer / local order do not match this client. */
  foreignTtn: boolean;
  /** Client pasted a TTN that is not on their orders; their other orders are listed. */
  ttnMissing?: boolean;
  unsupported: boolean;
  missingIdentity: boolean;
  crmError: boolean;
  timeZone: string;
  trackingByCode: Map<string, NpTrackingStatus>;
  /** Admin sandbox: show the CRM row even without a conversation client. */
  unverified?: boolean;
}

export function formatShipmentLookupResult(input: FormatShipmentLookupInput): string {
  const head = '[lookup_order_shipment]';
  if (input.unsupported) {
    return (
      `${head} РЕЗУЛЬТАТ: CRM ${input.providerLabel} не вміє шукати ТТН і статус відправки. ` +
      'Не вигадуй номер накладної. Якщо клієнту потрібен статус посилки — request_handoff.'
    );
  }
  if (input.crmError) {
    return (
      `${head} ПОМИЛКА: CRM тимчасово недоступна. Не вигадуй статус і ТТН. ` +
      'Коротко скажи, що перевірка не вдалась, і request_handoff.'
    );
  }
  if (input.missingIdentity && !input.ttnQuery) {
    return (
      `${head} РЕЗУЛЬТАТ: у профілі немає телефону і немає локального замовлення в CRM. ` +
      'Попроси телефон, яким оформлювали замовлення, або номер ТТН. Не вигадуй статус відправки.'
    );
  }
  if (input.foreignTtn && input.owned.length === 0) {
    return (
      `${head} РЕЗУЛЬТАТ: ТТН ${input.ttnQuery} є в ${input.providerLabel}, але не збігається з телефоном, ` +
      'привʼязкою чи локальним замовленням цього клієнта. Не називай чужі місто, товари, суму чи імʼя. ' +
      'Попроси телефон з замовлення. Якщо клієнт наполягає — request_handoff.'
    );
  }
  if (input.owned.length === 0) {
    const ttnBit = input.ttnQuery ? ` за ТТН ${input.ttnQuery}` : '';
    return (
      `${head} РЕЗУЛЬТАТ: у ${input.providerLabel} не знайдено замовлень цього клієнта${ttnBit}. ` +
      'Не вигадуй статус і номер ТТН. Якщо клієнт наполягає на точній даті — request_handoff.'
    );
  }

  const rows = input.owned.slice(0, 5).map((shipment, index) => {
    const tracking = shipment.trackingCode
      ? (input.trackingByCode.get(shipment.trackingCode) ?? null)
      : null;
    return formatOwnedShipment(shipment, index + 1, input.timeZone, tracking);
  });
  const scope = input.unverified
    ? `${input.providerLabel}, без перевірки що це клієнт цього чату`
    : `${input.providerLabel}, ${input.owned.length} замовлення цього клієнта`;
  const ttnNote = input.ttnMissing && input.ttnQuery
    ? `ТТН ${input.ttnQuery} у CRM не знайдено. Нижче інші замовлення цього клієнта.\n`
    : '';
  const foreignNote =
    input.foreignTtn && input.ttnQuery
      ? `\nТТН ${input.ttnQuery} належить іншому покупцю — її дані вище не показані.`
      : '';
  return (
    `${head} РЕЗУЛЬТАТ (${scope}):\n${ttnNote}${rows.join('\n')}${foreignNote}\n` +
    'Клієнту: статус замовлення, чи є ТТН, і статус Нової Пошти якщо він є. ' +
    'Не обіцяй дату відправки, якщо її немає в результаті. Не називай внутрішні id CRM.'
  );
}

export async function lookupOrderShipment(input: {
  clientId?: string | null;
  trackingCode?: string | null;
  timeZone?: string | null;
  /** Sandbox / admin: return CRM rows without a conversation client. */
  allowUnverified?: boolean;
}): Promise<string> {
  const timeZone = input.timeZone?.trim() || 'Europe/Kyiv';
  const ttnQuery = input.trackingCode ? normalizeTrackingCode(input.trackingCode) : null;
  if (input.trackingCode?.trim() && !ttnQuery) {
    return '[lookup_order_shipment] ПОМИЛКА: номер ТТН має містити 10–20 цифр. Попроси клієнта надіслати номер накладної ще раз.';
  }

  let provider: CrmProviderName;
  try {
    provider = await resolveCrmProvider('order');
  } catch (err) {
    log.error({ err }, 'resolveCrmProvider(order) failed');
    return formatShipmentLookupResult({
      providerLabel: 'CRM',
      ttnQuery,
      owned: [],
      foreignTtn: false,
      unsupported: false,
      missingIdentity: false,
      crmError: true,
      timeZone,
      trackingByCode: new Map(),
    });
  }

  const providerLabel = providerDisplayName(provider);
  const crm = getCrmAdapter(provider);
  if (!crm.capabilities.orders || !crm.lookupShipments) {
    return formatShipmentLookupResult({
      providerLabel,
      ttnQuery,
      owned: [],
      foreignTtn: false,
      unsupported: true,
      missingIdentity: false,
      crmError: false,
      timeZone,
      trackingByCode: new Map(),
    });
  }

  const client = input.clientId
    ? await prisma.client.findUnique({
        where: { id: input.clientId },
        select: { phone: true, crmBuyerId: true, crmProvider: true },
      })
    : null;
  const localOrders = input.clientId
    ? await prisma.order.findMany({
        where: {
          clientId: input.clientId,
          isArchived: false,
          keycrmOrderId: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { keycrmOrderId: true },
      })
    : [];
  const orderIds = localOrders
    .map((row) => row.keycrmOrderId?.trim() ?? '')
    .filter((id) => id.length > 0);
  const buyerId = client ? buyerIdForProvider(provider, client) : undefined;
  const phone = client?.phone?.trim() || undefined;
  const missingIdentity = !input.allowUnverified && !phone && !buyerId && orderIds.length === 0;

  if (missingIdentity && !ttnQuery) {
    return formatShipmentLookupResult({
      providerLabel,
      ttnQuery,
      owned: [],
      foreignTtn: false,
      unsupported: false,
      missingIdentity: true,
      crmError: false,
      timeZone,
      trackingByCode: new Map(),
    });
  }

  let rows: CrmShipment[];
  try {
    rows = await crm.lookupShipments({
      trackingCode: ttnQuery ?? undefined,
      buyerId,
      phone,
      orderIds,
      limit: 5,
    });
  } catch (err) {
    log.error({ err, provider }, 'lookupShipments failed');
    return formatShipmentLookupResult({
      providerLabel,
      ttnQuery,
      owned: [],
      foreignTtn: false,
      unsupported: false,
      missingIdentity: false,
      crmError: true,
      timeZone,
      trackingByCode: new Map(),
    });
  }

  const identity = {
    phone,
    buyerId,
    orderIds: new Set(orderIds),
  };
  const owned = rows.filter((row) => shipmentBelongsToClient(row, identity));
  const unverifiedRows =
    input.allowUnverified && owned.length === 0 && !phone && !buyerId && orderIds.length === 0
      ? rows
      : [];
  const visible = owned.length > 0 ? owned : unverifiedRows;
  const ttnHit = ttnQuery
    ? rows.some((row) => row.trackingCode?.replace(/\D/g, '') === ttnQuery)
    : false;
  const ownedTtn = ttnQuery
    ? visible.some((row) => row.trackingCode?.replace(/\D/g, '') === ttnQuery)
    : false;
  const foreignTtn = Boolean(ttnQuery) && ttnHit && !ownedTtn && !input.allowUnverified;
  const ttnMissing = Boolean(ttnQuery) && !ownedTtn && !foreignTtn && visible.length > 0;

  visible.sort((a, b) => {
    const at = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bt - at;
  });

  const trackingByCode = new Map<string, NpTrackingStatus>();
  const toTrack = visible.filter(looksLikeNovaPoshta).slice(0, 2);
  for (const shipment of toTrack) {
    const code = shipment.trackingCode;
    if (!code) continue;
    const tracked = await trackNovaPoshtaDocument(code, phone);
    if (!('error' in tracked)) trackingByCode.set(code, tracked);
  }

  return formatShipmentLookupResult({
    providerLabel,
    ttnQuery,
    owned: visible,
    foreignTtn,
    ttnMissing,
    unsupported: false,
    missingIdentity: false,
    crmError: false,
    timeZone,
    trackingByCode,
    unverified: unverifiedRows.length > 0,
  });
}
