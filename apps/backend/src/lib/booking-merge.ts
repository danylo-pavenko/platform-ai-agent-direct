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
  const seen = new Set(
    merged.map((row) => row.name.trim().toLowerCase()).filter(Boolean),
  );

  for (const row of incoming) {
    const name = row.name.trim();
    const key = name.toLowerCase();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push({
      name: name || row.name,
      variant: row.variant,
      price: Number(row.price) || 0,
      qty: Number(row.qty) > 0 ? Number(row.qty) : 1,
    });
  }

  return merged.length > 0 ? merged : incoming;
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
