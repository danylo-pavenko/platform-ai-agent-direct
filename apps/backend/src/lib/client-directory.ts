/** Search filter for the admin clients directory. */

export function buildClientSearchWhere(raw: string): Record<string, unknown> | undefined {
  const q = raw.trim();
  if (!q) return undefined;

  const or: Record<string, unknown>[] = [
    { displayName: { contains: q, mode: 'insensitive' } },
    { igFullName: { contains: q, mode: 'insensitive' } },
    { igUsername: { contains: q.replace(/^@/, ''), mode: 'insensitive' } },
    { phone: { contains: q, mode: 'insensitive' } },
    { email: { contains: q, mode: 'insensitive' } },
    { orders: { some: { id: { contains: q, mode: 'insensitive' } } } },
  ];

  const digits = q.replace(/\D/g, '');
  if (digits.length >= 6) {
    const tail = digits.slice(-9);
    or.push({ phone: { contains: tail } });
    if (digits.startsWith('380') && digits.length >= 12) {
      or.push({ phone: { contains: `0${digits.slice(3, 12)}` } });
    } else if (digits.startsWith('0') && digits.length >= 10) {
      or.push({ phone: { contains: digits.slice(0, 10) } });
      or.push({ phone: { contains: `380${digits.slice(1, 10)}` } });
    }
  }

  return { OR: or };
}
