/**
 * Live service search for booking-mode agents (CleverBOX and future providers).
 */

import { resolveCrmProvider } from '../lib/crm-routing.js';
import { getCrmAdapter } from './crm/index.js';
import type { CrmServiceItem } from './crm/types.js';

function formatServiceLine(s: CrmServiceItem): string {
  const price = s.price > 0 ? `від ${s.price} ₴` : 'ціна за запитом';
  const cat = s.categoryName ? ` | ${s.categoryName}` : '';
  return `[service_id=${s.id}] ${s.name} | ${s.durationMin} хв | ${price}${cat}`;
}

export async function searchServicesForContext(
  query: string,
  limit = 8,
): Promise<{ contextBlock: string; matchCount: number }> {
  const provider = await resolveCrmProvider('services');
  const crm = getCrmAdapter(provider);

  if (!crm.searchServices) {
    return { contextBlock: '', matchCount: 0 };
  }

  const items = await crm.searchServices(query, limit);
  if (items.length === 0) {
    return { contextBlock: '', matchCount: 0 };
  }

  return {
    matchCount: items.length,
    contextBlock: items.map(formatServiceLine).join('\n'),
  };
}

export async function getAvailableSlotsForContext(args: {
  date: string;
  branchCrmId: string;
  services: Array<{ id: string; durationMin: number }>;
  fullMonth?: boolean;
}): Promise<string> {
  const provider = await resolveCrmProvider('booking');
  const crm = getCrmAdapter(provider);

  if (!crm.getAvailableSlots) {
    return 'Слоти недоступні — CRM не підтримує онлайн-запис.';
  }

  const result = await crm.getAvailableSlots({
    date: args.date,
    branchId: args.branchCrmId,
    services: args.services,
    fullMonth: args.fullMonth,
  });

  const lines: string[] = [];
  const masterMap = new Map(result.masters.map((m) => [m.id, m.name]));

  for (const [day, slots] of Object.entries(result.slots)) {
    const daySlots = slots.slice(0, 12);
    if (daySlots.length === 0) continue;
    lines.push(`## ${day}`);
    for (const slot of daySlots) {
      const masterNames = slot.masterIds
        .map((id) => masterMap.get(id) ?? id)
        .slice(0, 4)
        .join(', ');
      lines.push(`- ${slot.time} | майстри: ${masterNames || '—'}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : 'Вільних слотів на обрану дату не знайдено.';
}
