/**
 * Nova Poshta API v2 integration.
 *
 * Supports domestic Ukraine delivery cost calculation.
 * International deliveries are not automated - agent escalates to manager.
 *
 * API reference: https://developers.novaposhta.ua/
 */

import pino from 'pino';
import { config } from '../config.js';
import { sanitizeIntegrationSecret } from '../lib/integration-secrets.js';
import { prisma } from '../lib/prisma.js';

const log = pino({ name: 'nova-poshta' });

const NP_API_URL = 'https://api.novaposhta.ua/v2.0/json/';

// Default: ship from Kyiv if sender city is not configured
const DEFAULT_SENDER_CITY_REF = '8d5a980d-391c-11dd-90d9-001a92567626'; // Kyiv

export interface DeliveryQuote {
  cost: number;
  currency: 'UAH';
  recipientCityName: string;
  serviceType: string;
}

// ---------------------------------------------------------------------------
// API key resolution (DB first, .env fallback)
// ---------------------------------------------------------------------------

async function resolveApiKey(): Promise<string> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: 'integration_novaposhta' } });
    const data = row?.value as Record<string, unknown> | null;
    if (data?.apiKey && typeof data.apiKey === 'string' && data.apiKey.trim()) {
      return data.apiKey.trim();
    }
  } catch {
    // fall through
  }
  return config.NOVA_POSHTA_API_KEY;
}

async function resolveSenderCityRef(): Promise<string> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: 'integration_novaposhta' } });
    const data = row?.value as Record<string, unknown> | null;
    if (data?.senderCityRef && typeof data.senderCityRef === 'string' && data.senderCityRef.trim()) {
      return data.senderCityRef.trim();
    }
  } catch {
    // fall through
  }
  return DEFAULT_SENDER_CITY_REF;
}

// ---------------------------------------------------------------------------
// Low-level API helpers
// ---------------------------------------------------------------------------

interface NpResponse<T = unknown> {
  success: boolean;
  data: T[];
  errors: string[];
  warnings: string[];
}

async function npCall<T>(apiKey: string, modelName: string, calledMethod: string, props: Record<string, unknown>): Promise<NpResponse<T>> {
  const body = JSON.stringify({ apiKey, modelName, calledMethod, methodProperties: props });

  const res = await fetch(NP_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    throw new Error(`Nova Poshta HTTP ${res.status}`);
  }

  return res.json() as Promise<NpResponse<T>>;
}

interface CityResult {
  Ref: string;
  Description: string;
  DescriptionRu: string;
}

/**
 * Returns the Ref UUID for the first matching city.
 * The Description field is the Ukrainian city name.
 */
async function findCityRef(apiKey: string, cityName: string): Promise<{ ref: string; name: string } | null> {
  const resp = await npCall<CityResult>(apiKey, 'Address', 'getCities', {
    FindByString: cityName,
    Limit: '3',
  });

  if (!resp.success || resp.data.length === 0) {
    log.warn({ cityName, errors: resp.errors }, 'City not found in Nova Poshta');
    return null;
  }

  const city = resp.data[0];
  return { ref: city.Ref, name: city.Description };
}

interface PriceResult {
  Cost: number;
  CostRedelivery?: number;
}

async function fetchDocumentPrice(
  apiKey: string,
  citySenderRef: string,
  cityRecipientRef: string,
  weightKg: number,
  declaredValue: number,
): Promise<number | null> {
  const resp = await npCall<PriceResult>(apiKey, 'InternetDocument', 'getDocumentPrice', {
    CitySender: citySenderRef,
    CityRecipient: cityRecipientRef,
    ServiceType: 'WarehouseWarehouse',
    Weight: String(weightKg),
    Cost: String(declaredValue),
    CargoType: 'Cargo',
    SeatsAmount: '1',
  });

  if (!resp.success || resp.data.length === 0) {
    log.warn({ errors: resp.errors }, 'Failed to get document price from Nova Poshta');
    return null;
  }

  return resp.data[0].Cost ?? null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get delivery cost estimate for Ukraine domestic shipping.
 *
 * @param recipientCity  City name in Ukrainian (e.g. "Харків", "Одеса")
 * @param weightKg       Package weight, defaults to 0.5 kg
 * @param declaredValue  Declared value in UAH, defaults to 500
 */
export async function getDeliveryCost(
  recipientCity: string,
  weightKg = 0.5,
  declaredValue = 500,
): Promise<DeliveryQuote | { error: string }> {
  const apiKey = await resolveApiKey();

  if (!apiKey) {
    return { error: 'Nova Poshta API key is not configured' };
  }

  const senderCityRef = await resolveSenderCityRef();

  let cityResult: { ref: string; name: string } | null = null;
  try {
    cityResult = await findCityRef(apiKey, recipientCity);
  } catch (err) {
    log.error({ err, recipientCity }, 'Error searching city in NP API');
    return { error: 'Помилка пошуку міста в базі Нової Пошти' };
  }

  if (!cityResult) {
    return { error: `Місто "${recipientCity}" не знайдено в базі Нової Пошти. Уточни назву.` };
  }

  let cost: number | null = null;
  try {
    cost = await fetchDocumentPrice(apiKey, senderCityRef, cityResult.ref, weightKg, declaredValue);
  } catch (err) {
    log.error({ err }, 'Error fetching delivery price from NP API');
    return { error: 'Не вдалося отримати тариф. Спробуйте пізніше.' };
  }

  if (cost === null) {
    return { error: 'Нова Пошта не повернула тариф для цього маршруту' };
  }

  return {
    cost,
    currency: 'UAH',
    recipientCityName: cityResult.name,
    serviceType: 'Склад-Склад',
  };
}

/**
 * Search city ref by name and return it (used when admin configures sender city).
 */
export async function resolveCityRef(cityName: string): Promise<{ ref: string; name: string } | null> {
  const apiKey = await resolveApiKey();
  if (!apiKey) return null;
  return findCityRef(apiKey, cityName);
}

export interface NpTrackingStatus {
  number: string;
  status: string;
  statusCode: string | null;
  scheduledDeliveryDate: string | null;
  cityRecipient: string | null;
  warehouseRecipient: string | null;
}

interface NpTrackingRow {
  Number?: string;
  Status?: string;
  StatusCode?: string | number;
  ScheduledDeliveryDate?: string;
  CityRecipient?: string;
  WarehouseRecipient?: string;
}

/**
 * Live Nova Poshta document status. Missing API key is a soft skip
 * (`error: not_configured`) so CRM shipment answers still stand.
 */
export async function trackNovaPoshtaDocument(
  documentNumber: string,
  phone?: string,
): Promise<NpTrackingStatus | { error: string }> {
  const number = documentNumber.replace(/\D/g, '');
  if (!/^\d{11,14}$/.test(number)) {
    return { error: 'invalid_ttn' };
  }
  const apiKey = await resolveApiKey();
  if (!apiKey) return { error: 'not_configured' };

  const doc: Record<string, string> = { DocumentNumber: number };
  const phoneDigits = phone?.replace(/\D/g, '') ?? '';
  if (phoneDigits.length >= 10) doc.Phone = phoneDigits;

  try {
    const resp = await npCall<NpTrackingRow>(apiKey, 'TrackingDocument', 'getStatusDocuments', {
      Documents: [doc],
    });
    const row = resp.success ? resp.data[0] : undefined;
    const status = row?.Status?.trim();
    if (!status) {
      log.warn({ errors: resp.errors, number }, 'Nova Poshta tracking returned no status');
      return { error: 'not_found' };
    }
    return {
      number: row?.Number?.trim() || number,
      status,
      statusCode: row?.StatusCode != null ? String(row.StatusCode) : null,
      scheduledDeliveryDate: row?.ScheduledDeliveryDate?.trim() || null,
      cityRecipient: row?.CityRecipient?.trim() || null,
      warehouseRecipient: row?.WarehouseRecipient?.trim() || null,
    };
  } catch (err) {
    log.error({ err, number }, 'Nova Poshta tracking failed');
    return { error: 'unavailable' };
  }
}

export interface NovaPoshtaConnectionTestResult {
  ok: boolean;
  status: 'ok' | 'error';
  message: string;
  durationMs?: number;
}

function scrubApiKey(detail: string, apiKey: string): string {
  if (!apiKey) return detail;
  return detail.split(apiKey).join('***');
}

/**
 * Owner-facing probe. Masked or empty override uses the saved key.
 * Does not log the key. Common.getCargoTypes is a cheap authenticated call.
 */
export async function testNovaPoshtaConnection(overrides?: {
  apiKey?: string;
}): Promise<NovaPoshtaConnectionTestResult> {
  const fromOverride = sanitizeIntegrationSecret(overrides?.apiKey);
  const apiKey = fromOverride || (await resolveApiKey());
  if (!apiKey) {
    return {
      ok: false,
      status: 'error',
      message:
        'Потрібен API Key Нової Пошти. Вставте ключ у поле або збережіть його в цьому розділі.',
    };
  }

  const t0 = Date.now();
  try {
    const resp = await npCall<{ Description?: string }>(apiKey, 'Common', 'getCargoTypes', {});
    const durationMs = Date.now() - t0;
    if (!resp.success) {
      const detail = scrubApiKey((resp.errors ?? []).join('; '), apiKey).slice(0, 240);
      const rejected = /key|ключ|auth/i.test(detail);
      return {
        ok: false,
        status: 'error',
        message: rejected
          ? 'Нова Пошта відхилила API Key. Перевірте ключ у кабінеті НП → Налаштування → API.'
          : `Нова Пошта: ${detail || 'запит не вдався'}`,
        durationMs,
      };
    }
    return {
      ok: true,
      status: 'ok',
      message: 'Підключено до Нової Пошти. Ключ прийнято: можна рахувати доставку і шукати ТТН.',
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - t0;
    log.error({ err }, 'Nova Poshta connection test failed');
    const raw = err instanceof Error ? err.message : 'запит не вдався';
    return {
      ok: false,
      status: 'error',
      message: `Нова Пошта недоступна: ${scrubApiKey(raw, apiKey).slice(0, 200)}`,
      durationMs,
    };
  }
}

export interface NpSenderDocument {
  number: string;
  status: string;
  cityRecipient: string | null;
  warehouseRecipient: string | null;
  recipientName: string | null;
  estimatedDeliveryDate: string | null;
}

export type NpPhoneSearch =
  | { status: 'not_configured' }
  | { status: 'unavailable' }
  | { status: 'no_phone_on_documents' }
  | { status: 'none' }
  | { status: 'found'; documents: NpSenderDocument[] };

const DOC_PHONE_KEYS = [
  'RecipientContactPhone',
  'RecipientsPhone',
  'RecipientPhone',
  'PhoneRecipient',
];

function readNpString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function isPublicNpLabel(value: string | null): string | null {
  if (!value) return null;
  if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(value)) return null;
  return value;
}

function formatNpDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('day')}.${pick('month')}.${pick('year')}`;
}

function mapSenderDocument(row: Record<string, unknown>, number: string): NpSenderDocument {
  const stateName = readNpString(row, ['StateName', 'Status']);
  const stateCode = readNpString(row, ['State', 'StateId']);
  return {
    number,
    status: stateName || (stateCode ? `стан ${stateCode}` : 'статус без назви'),
    cityRecipient: isPublicNpLabel(readNpString(row, ['CityRecipientDescription'])),
    warehouseRecipient: isPublicNpLabel(
      readNpString(row, ['RecipientAddressDescription', 'WarehouseRecipientDescription']),
    ),
    recipientName: isPublicNpLabel(
      readNpString(row, ['RecipientContactPerson', 'RecipientFullName']),
    ),
    estimatedDeliveryDate: readNpString(row, ['EstimatedDeliveryDate', 'ScheduledDeliveryDate']),
  };
}

/**
 * Sender cabinet documents whose recipient phone matches this client.
 * getDocumentList has no phone filter, so we scan a short recent window
 * and drop every row that is not this phone. If the payload has no phone
 * field at all, return no_phone_on_documents instead of guessing.
 */
export async function findNovaPoshtaDocumentsByPhone(
  phone: string,
  opts?: { days?: number; timeZone?: string },
): Promise<NpPhoneSearch> {
  const tail = phone.replace(/\D/g, '').slice(-9);
  if (tail.length < 9) return { status: 'none' };
  const apiKey = await resolveApiKey();
  if (!apiKey) return { status: 'not_configured' };

  const timeZone = opts?.timeZone?.trim() || 'Europe/Kyiv';
  const days = opts?.days ?? 45;
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const matches: NpSenderDocument[] = [];
  let sawAny = false;
  let sawPhoneField = false;

  try {
    for (let page = 1; page <= 3 && matches.length < 5; page++) {
      const resp = await npCall<Record<string, unknown>>(apiKey, 'InternetDocument', 'getDocumentList', {
        DateTimeFrom: formatNpDate(from, timeZone),
        DateTimeTo: formatNpDate(now, timeZone),
        Page: String(page),
        GetFullList: '0',
      });
      if (!resp.success) {
        log.warn({ errors: resp.errors, page }, 'Nova Poshta document list rejected');
        if (page === 1 && matches.length === 0) return { status: 'unavailable' };
        break;
      }
      const rows = resp.data ?? [];
      if (rows.length === 0) break;
      sawAny = true;
      for (const row of rows) {
        const rowPhone = readNpString(row, DOC_PHONE_KEYS);
        if (rowPhone) sawPhoneField = true;
        if (!rowPhone || rowPhone.replace(/\D/g, '').slice(-9) !== tail) continue;
        const number = (readNpString(row, ['IntDocNumber', 'Number']) ?? '').replace(/\D/g, '');
        if (!/^\d{10,14}$/.test(number)) continue;
        if (matches.some((doc) => doc.number === number)) continue;
        matches.push(mapSenderDocument(row, number));
        if (matches.length >= 5) break;
      }
      if (rows.length < 100) break;
    }
  } catch (err) {
    log.error({ err }, 'Nova Poshta document list failed');
    return { status: 'unavailable' };
  }

  if (matches.length === 0) {
    if (sawAny && !sawPhoneField) return { status: 'no_phone_on_documents' };
    return { status: 'none' };
  }

  for (const doc of matches.slice(0, 3)) {
    const tracked = await trackNovaPoshtaDocument(doc.number, phone);
    if ('error' in tracked) continue;
    doc.status = tracked.status;
    if (tracked.cityRecipient) doc.cityRecipient = tracked.cityRecipient;
    if (tracked.warehouseRecipient) doc.warehouseRecipient = tracked.warehouseRecipient;
    if (tracked.scheduledDeliveryDate) doc.estimatedDeliveryDate = tracked.scheduledDeliveryDate;
  }

  return { status: 'found', documents: matches };
}
