/**
 * Detects and parses bot order-confirmation messages (Ukrainian sales flow).
 * Used as a safety net when Claude writes the summary but omits collect_order.
 */

export interface ParsedOrderSummary {
  items: Array<{ name: string; variant?: string; price: number; qty: number }>;
  customer_name: string;
  phone: string;
  city: string;
  np_branch: string;
  payment_method: string;
  note?: string;
}

const FIELD_LINE_RE =
  /^(?:Товар|Отримувач|ПІБ|Телефон|Доставка|Оплата)\s*:\s*(.+)$/gim;

const CONFIRMATION_HINT_RE =
  /підтверджую\s+замовлення|підсумок\s+замовлення|оформлю\s+замовлення/i;

function parsePriceFromProductLine(line: string): number {
  const m = line.match(/(\d[\d\s]*)\s*(?:₴|грн)/i);
  if (!m) return 0;
  return Number(m[1].replace(/\s/g, '')) || 0;
}

function splitProductLine(line: string): { name: string; variant?: string } {
  const dashIdx = line.lastIndexOf(' - ');
  const productPart = dashIdx >= 0 ? line.slice(0, dashIdx).trim() : line.trim();
  const commaIdx = productPart.indexOf(',');
  if (commaIdx >= 0) {
    return {
      name: productPart.slice(0, commaIdx).trim(),
      variant: productPart.slice(commaIdx + 1).trim() || undefined,
    };
  }
  return { name: productPart };
}

function parseDelivery(line: string): { city: string; np_branch: string } {
  const branchMatch = line.match(/відділення\s*№?\s*(\d+)/i);
  const npBranch = branchMatch?.[1] ?? line.trim();

  let city = line.trim();
  const cityMatch = line.match(/(?:НП|Нова\s*Пошта)\s+([^,]+)/i);
  if (cityMatch) {
    city = cityMatch[1].trim();
  } else {
    const beforeBranch = line.split(/,?\s*відділення/i)[0]?.trim();
    if (beforeBranch) city = beforeBranch.replace(/^НП\s+/i, '').trim();
  }

  return { city, np_branch: npBranch };
}

function fieldValue(text: string, label: string): string | undefined {
  const re = new RegExp(`^${label}\\s*:\\s*(.+)$`, 'im');
  const m = text.match(re);
  return m?.[1]?.trim() || undefined;
}

/** True when the bot message looks like a finalized order summary for the client. */
export function isOrderConfirmationMessage(text: string): boolean {
  if (!text.trim()) return false;

  const hasConfirmationHint = CONFIRMATION_HINT_RE.test(text);
  const hasProduct = /^Товар\s*:/im.test(text);
  const hasPhone = /^Телефон\s*:/im.test(text);
  const hasDelivery = /^Доставка\s*:/im.test(text);
  const hasPayment = /^Оплата\s*:/im.test(text);
  const hasRecipient = /^(?:Отримувач|ПІБ)\s*:/im.test(text);

  const fieldCount = [hasProduct, hasPhone, hasDelivery, hasPayment, hasRecipient].filter(
    Boolean,
  ).length;

  return (hasConfirmationHint && fieldCount >= 4) || fieldCount >= 5;
}

/** Parse structured order args from a bot confirmation message. */
export function parseOrderSummaryFromText(text: string): ParsedOrderSummary | null {
  if (!isOrderConfirmationMessage(text)) return null;

  const productLine = fieldValue(text, 'Товар');
  const customerName = fieldValue(text, 'Отримувач') ?? fieldValue(text, 'ПІБ');
  const phone = fieldValue(text, 'Телефон');
  const deliveryLine = fieldValue(text, 'Доставка');
  const paymentLine = fieldValue(text, 'Оплата');

  if (!productLine || !customerName || !phone || !deliveryLine || !paymentLine) {
    return null;
  }

  const { name, variant } = splitProductLine(productLine);
  const price = parsePriceFromProductLine(productLine);
  const { city, np_branch } = parseDelivery(deliveryLine);

  if (!name || !city || !np_branch) return null;

  return {
    items: [{ name, variant, price, qty: 1 }],
    customer_name: customerName,
    phone,
    city,
    np_branch,
    payment_method: paymentLine,
  };
}

/** Exposed for tests — counts labelled field lines in a message. */
export function countOrderFieldLines(text: string): number {
  return [...text.matchAll(FIELD_LINE_RE)].length;
}
