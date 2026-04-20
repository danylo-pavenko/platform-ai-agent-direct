import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { askClaude } from '../services/claude.js';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatBody {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

interface ApplyBody {
  before: string;
  after: string;
  summary: string;
}

interface SuggestedDiff {
  before: string;
  after: string;
  summary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMetaAgentSystemPrompt(currentPromptContent: string): string {
  return `Ти — редактор системних промптів для AI Sales Agent магазину ${config.BRAND_NAME}.

Контекст:
- Поточний активний системний промпт агента наведений нижче в блоці <current_prompt>.
- Адміністратор магазину дає тобі інструкцію в чаті — як змінити поведінку бота.

Твоя задача:
1. Зрозуми, що саме адмін хоче змінити.
2. Знайди місце в промпті, куди це логічно вписується.
3. Інтегруй зміну, зберігаючи загальну структуру, tone of voice і всі існуючі обмеження.
4. НЕ видаляй існуючі правила безпеки, ескалації, заборонені дії.
5. НЕ додавай нічого, про що адмін не просив.

Відповідай ТІЛЬКИ у форматі:

ПОЯСНЕННЯ: <1-2 речення, що саме ти змінив і чому саме там>

ЗМІНА:
--- БУЛО ---
<ТОЧНИЙ фрагмент з промпту, який змінюється — скопіюй дослівно>
--- СТАЛО ---
<новий варіант цього ж фрагменту з доданими/зміненими частинами>

ВАЖЛИВО про формат:
- У "БУЛО" завжди вказуй ТОЧНИЙ існуючий текст з промпту (copy-paste), навіть якщо змінюєш лише частину.
- У "СТАЛО" — повний замінений варіант цього фрагменту (не тільки додане, а весь блок цілком).
- Якщо додаєш абсолютно нове правило без аналогу в промпті — "БУЛО" залиш порожнім, а "СТАЛО" — лише новий блок.
- НЕ виводь весь промпт цілком — тільки змінений фрагмент.

Якщо зміна не потрібна (промпт вже покриває запит) — скажи це і поясни де.
Якщо запит суперечить правилам безпеки (наприклад "давай знижку 50%") — відмов і поясни.

<current_prompt>
${currentPromptContent}
</current_prompt>`;
}

/**
 * Parse the meta-agent response to extract a suggested diff.
 *
 * Expected format:
 *   ПОЯСНЕННЯ: ...
 *   ЗМІНА:
 *   --- БУЛО ---
 *   ...old text...
 *   --- СТАЛО ---
 *   ...new text...
 *
 * We are lenient with whitespace and optional trailing markers.
 */
function parseDiff(text: string): SuggestedDiff | null {
  // Extract summary from ПОЯСНЕННЯ line
  const summaryMatch = text.match(/ПОЯСНЕННЯ:\s*(.+?)(?:\n|$)/);
  const summary = summaryMatch ? summaryMatch[1].trim() : '';

  // Look for БУЛО / СТАЛО markers (lenient with surrounding whitespace/dashes)
  const buloIdx = text.indexOf('--- БУЛО ---');
  const staloIdx = text.indexOf('--- СТАЛО ---');

  if (buloIdx === -1 || staloIdx === -1 || staloIdx <= buloIdx) {
    return null;
  }

  // "before" is everything between the end of "--- БУЛО ---" and "--- СТАЛО ---"
  const afterBuloMarker = buloIdx + '--- БУЛО ---'.length;
  const before = text.slice(afterBuloMarker, staloIdx).trim();

  // "after" is everything after "--- СТАЛО ---" until end of text
  // (or until another section marker if one exists)
  const afterStaloMarker = staloIdx + '--- СТАЛО ---'.length;
  const after = text.slice(afterStaloMarker).trim();

  if (!before && !after) {
    return null;
  }

  return { before, after, summary };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export async function metaAgentRoutes(app: FastifyInstance): Promise<void> {
  // POST /chat — Converse with the meta-agent about prompt changes
  app.post<{ Body: ChatBody }>(
    '/chat',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { message, history } = request.body ?? {};

      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return reply.code(400).send({ error: 'Message is required' });
      }

      // 1. Fetch the current active system prompt
      const activePrompt = await prisma.systemPrompt.findFirst({
        where: { isActive: true },
      });

      if (!activePrompt) {
        return reply.code(400).send({ error: 'No active prompt found' });
      }

      // 2. Build meta-agent system prompt
      const metaAgentPrompt = buildMetaAgentSystemPrompt(activePrompt.content);

      // 3. Call Claude
      const response = await askClaude({
        systemPrompt: metaAgentPrompt,
        conversationHistory: history ?? [],
        userMessage: message.trim(),
      });

      app.log.info(
        { responseLength: response.text.length },
        'Meta-agent chat response received',
      );

      // 4. Parse diff from response
      const suggestedDiff = parseDiff(response.text);

      if (suggestedDiff) {
        return {
          reply: response.text,
          suggestedDiff,
        };
      }

      return { reply: response.text };
    },
  );

  // POST /apply — Apply a suggested prompt change
  app.post<{ Body: ApplyBody }>(
    '/apply',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { before, after, summary } = request.body ?? {};

      if (!after || typeof after !== 'string' || after.trim().length === 0) {
        return reply.code(400).send({ error: 'New prompt content (after) is required' });
      }

      if (!summary || typeof summary !== 'string' || summary.trim().length === 0) {
        return reply.code(400).send({ error: 'Change summary is required' });
      }

      // 1. Fetch current active prompt
      const activePrompt = await prisma.systemPrompt.findFirst({
        where: { isActive: true },
      });

      if (!activePrompt) {
        return reply.code(400).send({ error: 'No active prompt found' });
      }

      // 2. Apply the diff to the full prompt content.
      //
      // Three cases:
      //   a) `before` is provided and found → targeted replacement (most common)
      //   b) `before` is provided but NOT found → 422 error (fragment drifted)
      //   c) `before` is empty → meta-agent is ADDING new content; append to existing
      //
      // We never save just `after` as the full prompt — that would lose existing content.
      let newContent: string;
      if (before && typeof before === 'string' && before.trim()) {
        if (activePrompt.content.includes(before.trim())) {
          // Case a: replace the exact fragment
          newContent = activePrompt.content.replace(before.trim(), after.trim());
        } else {
          app.log.warn(
            { beforeLength: before.length },
            'Meta-agent apply: "before" fragment not found in active prompt — aborting to prevent data loss',
          );
          return reply.code(422).send({
            error: 'Фрагмент "БУЛО" не знайдено в поточному промпті. Можливо промпт змінився. Спробуйте ще раз.',
          });
        }
      } else {
        // Case c: no "before" → append new content to the end of the existing prompt
        app.log.info(
          { afterLength: after.length },
          'Meta-agent apply: no "before" fragment — appending new content to existing prompt',
        );
        newContent = activePrompt.content.trimEnd() + '\n\n' + after.trim();
      }

      // 3. Get max version
      const maxVersion = await prisma.systemPrompt.aggregate({
        _max: { version: true },
      });
      const nextVersion = (maxVersion._max.version ?? 0) + 1;

      // 4. Transaction: deactivate all, create new, audit log
      const newPrompt = await prisma.$transaction(async (tx) => {
        // Deactivate all existing prompts
        await tx.systemPrompt.updateMany({
          data: { isActive: false },
        });

        // Create new prompt version with the full updated content
        const created = await tx.systemPrompt.create({
          data: {
            version: nextVersion,
            content: newContent,
            author: 'meta_agent',
            authorUserId: request.user.id,
            changeSummary: summary.trim(),
            isActive: true,
          },
        });

        // Create audit log
        await tx.auditLog.create({
          data: {
            actor: request.user.username,
            action: 'prompt_activated_via_meta_agent',
            entityType: 'system_prompt',
            entityId: created.id,
            payload: {
              summary: summary.trim(),
              version: created.version,
            },
          },
        });

        return created;
      });

      app.log.info(
        { promptId: newPrompt.id, version: newPrompt.version },
        'Meta-agent applied prompt change',
      );

      return reply.code(201).send(newPrompt);
    },
  );
}
