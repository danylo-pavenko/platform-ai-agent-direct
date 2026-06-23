/** Calendar-month extension presets for tenant admin / bot access. */
export const ACCESS_EXTEND_MONTHS = [1, 3, 6, 12] as const;
export type AccessExtendMonths = (typeof ACCESS_EXTEND_MONTHS)[number];

export function addCalendarMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  d.setMonth(d.getMonth() + months);
  return d;
}

/**
 * Extend from the later of (now, current expiry) so early renewals stack.
 */
export function computeExtendedExpiry(
  currentExpiresAt: Date | null | undefined,
  months: number,
  now = new Date(),
): Date {
  const base =
    currentExpiresAt && currentExpiresAt.getTime() > now.getTime()
      ? currentExpiresAt
      : now;
  return addCalendarMonths(base, months);
}
