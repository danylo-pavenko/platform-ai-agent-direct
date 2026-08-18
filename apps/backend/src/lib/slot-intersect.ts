import type { CrmSlot } from '../services/crm/types.js';

export type SlotDayMap = Record<string, CrmSlot[]>;

export type SlotLookupResult = {
  slots: SlotDayMap;
  masters: Array<{ id: string; name: string }>;
};

/** Keep start times present in every result (parallel masters at the same clock time). */
export function intersectSlotLookupResults(results: SlotLookupResult[]): SlotLookupResult {
  if (results.length === 0) return { slots: {}, masters: [] };
  if (results.length === 1) return results[0]!;

  const masterMap = new Map<string, string>();
  for (const result of results) {
    for (const master of result.masters) {
      if (!masterMap.has(master.id)) masterMap.set(master.id, master.name);
    }
  }

  const days = new Set<string>();
  for (const result of results) {
    for (const day of Object.keys(result.slots)) days.add(day);
  }

  const slots: SlotDayMap = {};
  for (const day of [...days].sort()) {
    const timeSets = results.map(
      (result) => new Set((result.slots[day] ?? []).map((slot) => slot.time)),
    );
    const first = timeSets[0];
    if (!first || first.size === 0) continue;
    const times = [...first]
      .filter((time) => timeSets.every((set) => set.has(time)))
      .sort();
    if (times.length === 0) continue;
    slots[day] = times.map((time) => {
      const masterIds: string[] = [];
      const seen = new Set<string>();
      for (const result of results) {
        const hit = (result.slots[day] ?? []).find((slot) => slot.time === time);
        for (const id of hit?.masterIds ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          masterIds.push(id);
        }
      }
      return { date: day, time, masterIds };
    });
  }

  return {
    slots,
    masters: [...masterMap.entries()].map(([id, name]) => ({ id, name })),
  };
}
