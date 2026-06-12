/** Sum line items stored as Prisma Json (qty × price). */
export function computeOrderTotal(items: unknown): number {
  if (!Array.isArray(items)) return 0;

  return items.reduce((sum, raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return sum;
    const o = raw as Record<string, unknown>;
    const price = typeof o.price === 'number' ? o.price : 0;
    const qty = typeof o.qty === 'number' ? o.qty : 1;
    return sum + price * qty;
  }, 0);
}
