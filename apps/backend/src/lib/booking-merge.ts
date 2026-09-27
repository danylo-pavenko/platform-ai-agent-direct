/**
 * Merge multiple book_appointment calls into one local visit + one CRM record.
 */

import type { AppointmentServiceLine } from './appointment-services.js';
import type { OrderLineItem } from './order-normalize.js';

export function appointmentServiceKey(line: AppointmentServiceLine): string {
  const master = line.masterId?.trim() || '';
  return `${line.id}:${master}`;
}

export function mergeAppointmentServiceLines(
  existing: AppointmentServiceLine[],
  incoming: AppointmentServiceLine[],
): { merged: AppointmentServiceLine[]; added: AppointmentServiceLine[] } {
  const merged = existing.map((row) => ({ ...row }));
  const seen = new Set(merged.map(appointmentServiceKey));
  const added: AppointmentServiceLine[] = [];

  for (const row of incoming) {
    const key = appointmentServiceKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    const next = { ...row };
    merged.push(next);
    added.push(next);
  }

  return { merged, added };
}

export function mergeOrderLineItems(
  existing: OrderLineItem[],
  incoming: OrderLineItem[],
): OrderLineItem[] {
  const merged = existing.map((row) => ({ ...row }));
  const byName = new Map(
    merged
      .map((row, idx) => [row.name.trim().toLowerCase(), idx] as const)
      .filter(([name]) => Boolean(name)),
  );

  for (const row of incoming) {
    const key = row.name.trim().toLowerCase();
    if (!key) {
      merged.push({ ...row });
      continue;
    }
    const idx = byName.get(key);
    if (idx == null) {
      byName.set(key, merged.length);
      merged.push({ ...row });
      continue;
    }
    const prev = merged[idx]!;
    // Prefer a real price over a stale 0 from an earlier book without catalog fill.
    const price =
      row.price > 0 ? row.price : prev.price > 0 ? prev.price : 0;
    const qty = Math.max(prev.qty || 1, row.qty || 1);
    merged[idx] = {
      ...prev,
      ...row,
      price,
      qty,
      name: prev.name || row.name,
    };
  }
  return merged;
}

export function buildBookingOrderSummary(params: {
  serviceNames: string[];
  date: string;
  time: string;
}): string {
  const serviceNames =
    params.serviceNames.filter(Boolean).join(', ') || 'Запис';
  return `Запис: ${serviceNames} · ${params.date} ${params.time}`;
}
