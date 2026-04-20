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
