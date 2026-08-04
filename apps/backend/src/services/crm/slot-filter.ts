import type { CrmSlot } from './types.js';

export type SlotMastersResult = {
  slots: Record<string, CrmSlot[]>;
  masters: Array<{ id: string; name: string }>;
};

/**
 * CRM-agnostic post-filter: keep only slots where `masterId` is available,
 * and narrow each slot's masterIds to that professional.
 * Adapters call this after fetching free time so providers without a native
 * employee filter still support preferred-master booking.
 */
export function filterSlotsByMasterId(
  result: SlotMastersResult,
  masterId: string | undefined,
): SlotMastersResult {
  const id = masterId?.trim();
  if (!id) return result;

  const slots: Record<string, CrmSlot[]> = {};
  for (const [day, daySlots] of Object.entries(result.slots)) {
    const filtered = daySlots
      .filter((slot) => slot.masterIds.includes(id))
      .map((slot) => ({
        ...slot,
        masterIds: [id],
      }));
    if (filtered.length > 0) {
      slots[day] = filtered;
    }
  }

  const master =
    result.masters.find((m) => m.id === id) ?? ({ id, name: id });

  return {
    slots,
    masters: Object.keys(slots).length > 0 ? [master] : [],
  };
}
