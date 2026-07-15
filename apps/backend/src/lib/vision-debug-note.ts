/**
 * Admin-only debug note after a vision turn (system message in chat).
 * Never sent to Instagram — only shown in tenant admin ConversationDetail.
 */

export interface CatalogDebugMatch {
  query: string;
  matchCount: number;
  /** Formatted block from searchActiveProductsForContext (may be truncated). */
  contextBlock: string;
  source: 'search_catalog' | 'shared_post' | 'diagnostic';
}

export interface VisionDebugNoteInput {
  imageCount: number;
  /** Short human reading of what Claude/vision inferred (no internal IDs). */
  interpretation?: string | null;
  catalog?: CatalogDebugMatch | null;
  /** Paths skipped (video / oversized) — count only. */
  skippedNonImageCount?: number;
}

const MAX_INTERPRETATION = 320;
const MAX_CATALOG_LINES = 6;

/** Pull a short admin-facing interpretation from Claude's first reply. */
export function extractVisionInterpretation(text: string | null | undefined): string | null {
  if (!text?.trim()) return null;
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_INTERPRETATION
    ? `${cleaned.slice(0, MAX_INTERPRETATION)}…`
    : cleaned;
}

function truncateCatalogBlock(block: string): string {
  const lines = block
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // Never surface raw product_id / offer_id in admin note (noisy).
    .filter((l) => !/product_id|offer_id|purchased_price/i.test(l));
  const kept = lines.slice(0, MAX_CATALOG_LINES);
  const suffix = lines.length > MAX_CATALOG_LINES ? '\n…' : '';
  return `${kept.join('\n')}${suffix}`;
}

/**
 * Format a multiline system message for the admin chat transcript.
 */
export function formatVisionDebugNote(input: VisionDebugNoteInput): string {
  const lines: string[] = ['🔍 Аналіз зображення'];

  lines.push(
    `• Vision: опрацьовано ${input.imageCount} зображен${input.imageCount === 1 ? 'ня' : 'ь'}`,
  );

  if (input.skippedNonImageCount && input.skippedNonImageCount > 0) {
    lines.push(
      `• Пропущено вкладень (відео / розмір): ${input.skippedNonImageCount}`,
    );
  }

  const interpretation = input.interpretation?.trim();
  if (interpretation) {
    lines.push(`• Інтерпретація: ${interpretation}`);
  } else {
    lines.push('• Інтерпретація: модель не залишила текстового висновку до search_catalog');
  }

  const catalog = input.catalog;
  if (!catalog) {
    lines.push('• Каталог/CRM: пошук не виконували (немає запиту або режим без каталогу)');
  } else if (catalog.matchCount > 0) {
    const sourceLabel =
      catalog.source === 'search_catalog'
        ? 'search_catalog'
        : catalog.source === 'shared_post'
          ? 'shared post'
          : 'діагностичний пошук';
    lines.push(
      `• Каталог/CRM (${sourceLabel}, запит «${catalog.query}»): знайдено ${catalog.matchCount}`,
    );
    const truncated = truncateCatalogBlock(catalog.contextBlock);
    if (truncated) {
      lines.push(truncated);
    }
  } else {
    lines.push(`• Каталог/CRM (запит «${catalog.query}»): збігів немає`);
  }

  return lines.join('\n');
}
