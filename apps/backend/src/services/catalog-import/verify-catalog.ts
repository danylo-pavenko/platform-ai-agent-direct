/**
 * Claude verify for catalog import drafts — sample + stats only, never rewrite prices.
 */

import pino from 'pino';
import { askClaude } from '../claude.js';
import type { CatalogImportDraft, CatalogVerifyResult } from './types.js';

const log = pino({ name: 'catalog-import-verify' });

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no json object');
  return JSON.parse(candidate.slice(start, end + 1));
}

export async function verifyCatalogImportDraft(
  draft: CatalogImportDraft,
): Promise<CatalogVerifyResult> {
  const payload = {
    source: draft.source,
    stats: draft.stats,
    sampleRows: draft.sampleRows.slice(0, 20),
  };

  const systemPrompt = [
    'Ти перевіряєш імпорт товарного каталогу з CSV (Shop-Express / Engine).',
    'Парсер уже зробив мапінг; ти НЕ змінюєш ціни і НЕ вигадуєш товари.',
    'Перевір: чи схожі rawPrice→mappedPrice (кома як десятковий роздільник),',
    'чи Name/SKU/модифікація виглядають розумно, чи available→qty/archived логічні.',
    'Відповідай ЛИШЕ JSON:',
    '{"ok":boolean,"confidence":0-1,"issues":[{"severity":"critical"|"warning","message":"..."}],"summaryUk":"..."}',
    'ok=false лише якщо є critical проблеми (напр. усі ціни 0, порожні назви, повний збій мапінгу).',
  ].join('\n');

  try {
    const response = await askClaude(
      {
        systemPrompt,
        conversationHistory: [],
        userMessage: `Перевір імпорт:\n${JSON.stringify(payload, null, 2)}`,
      },
      { channel: 'insights', timeoutMs: 90_000 },
    );

    if (response.fallback) {
      return {
        ok: true,
        confidence: 0.4,
        issues: [
          {
            severity: 'warning',
            message:
              'Claude verify недоступний — імпорт можна підтвердити вручну після перегляду preview',
          },
        ],
        summaryUk: 'Автоперевірка пропущена (Claude fallback). Перегляньте preview.',
      };
    }

    const parsed = extractJsonObject(response.text) as {
      ok?: boolean;
      confidence?: number;
      issues?: Array<{ severity?: string; message?: string }>;
      summaryUk?: string;
    };

    const issues = (parsed.issues ?? [])
      .filter((i) => typeof i?.message === 'string' && i.message.trim())
      .map((i) => ({
        severity: i.severity === 'critical' ? ('critical' as const) : ('warning' as const),
        message: String(i.message).trim().slice(0, 400),
      }));

    const hasCritical = issues.some((i) => i.severity === 'critical');
    const ok = parsed.ok !== false && !hasCritical;

    return {
      ok,
      confidence:
        typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
          ? Math.min(1, Math.max(0, parsed.confidence))
          : ok
            ? 0.7
            : 0.3,
      issues,
      summaryUk:
        (typeof parsed.summaryUk === 'string' && parsed.summaryUk.trim()) ||
        (ok ? 'Мапінг виглядає коректним.' : 'Знайдено критичні проблеми мапінгу.'),
    };
  } catch (err) {
    log.warn({ err }, 'catalog verify failed');
    return {
      ok: true,
      confidence: 0.4,
      issues: [
        {
          severity: 'warning',
          message: 'Не вдалося розібрати відповідь Claude — перегляньте preview вручну',
        },
      ],
      summaryUk: 'Автоперевірка з помилкою парсингу відповіді. Перегляньте preview.',
    };
  }
}
