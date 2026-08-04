/**
 * Live service search for booking-mode agents (CleverBOX, BeautyPro, and future providers).
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

/** Format slot masters for the agent (ids for tools; names for client copy). */
export function formatSlotMastersLine(
  masterIds: string[],
  masterMap: Map<string, string>,
  limit = 4,
): string {
  return masterIds
    .slice(0, limit)
    .map((id) => {
      const name = masterMap.get(id) ?? id;
      return `[master_id=${id}] ${name}`;
    })
    .join(', ');
}

export async function getAvailableSlotsForContext(args: {
  date: string;
  branchCrmId: string;
  services: Array<{ id: string; durationMin: number }>;
  fullMonth?: boolean;
  masterId?: string;
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
    masterId: args.masterId,
  });

  const lines: string[] = [];
  const masterMap = new Map(result.masters.map((m) => [m.id, m.name]));

  for (const [day, slots] of Object.entries(result.slots)) {
    const daySlots = slots.slice(0, 12);
    if (daySlots.length === 0) continue;
    lines.push(`## ${day}`);
    for (const slot of daySlots) {
      const mastersLabel = formatSlotMastersLine(slot.masterIds, masterMap);
      lines.push(`- ${slot.time} | майстри: ${mastersLabel || '—'}`);
    }
  }

  if (lines.length === 0) {
    return args.masterId
      ? 'Вільних слотів для цього майстра на обрану дату не знайдено. Запропонуй інший день або іншого майстра (без master_id).'
      : 'Вільних слотів на обрану дату не знайдено.';
  }

  lines.push(
    '',
    'Для book_appointment використовуй master_id з цього списку. Клієнту показуй лише імʼя майстра, не id.',
  );
  return lines.join('\n');
}
