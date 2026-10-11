/**
 * When a second book_appointment lands on the same date and clock time.
 * BeautyPro / CleverBOX merge service lines into one visit.
 * Altegio is one staff member per record, so a different master is a new visit.
 */

export function bookingVisitsCanMerge(
  provider: string | null | undefined,
  existing: Array<{ masterId?: string | null }>,
  incoming: Array<{ masterId?: string | null }>,
): boolean {
  if (provider !== 'altegio') return true;
  const left = masterIds(existing);
  const right = masterIds(incoming);
  if (left.length === 0 || right.length === 0) return true;
  if (left.length > 1 || right.length > 1) return false;
  return left[0] === right[0];
}

function masterIds(lines: Array<{ masterId?: string | null }>): string[] {
  return [...new Set(lines.map((line) => line.masterId?.trim()).filter((id): id is string => Boolean(id)))];
}
