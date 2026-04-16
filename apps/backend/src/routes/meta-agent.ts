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
<фрагмент, який змінюється>
--- СТАЛО ---
<новий фрагмент>

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
      const { after, summary } = request.body ?? {};

      if (!after || typeof after !== 'string' || after.trim().length === 0) {
        return reply.code(400).send({ error: 'New prompt content (after) is required' });
      }

      if (!summary || typeof summary !== 'string' || summary.trim().length === 0) {
        return reply.code(400).send({ error: 'Change summary is required' });
      }

      // 1. Verify there is a current active prompt
      const activePrompt = await prisma.systemPrompt.findFirst({
        where: { isActive: true },
      });

      if (!activePrompt) {
        return reply.code(400).send({ error: 'No active prompt found' });
      }

      // 2. Get max version
      const maxVersion = await prisma.systemPrompt.aggregate({
        _max: { version: true },
      });
      const nextVersion = (maxVersion._max.version ?? 0) + 1;

      // 3. Transaction: deactivate all, create new, audit log
      const newPrompt = await prisma.$transaction(async (tx) => {
        // Deactivate all existing prompts
        await tx.systemPrompt.updateMany({
          data: { isActive: false },
        });

        // Create new prompt version
        const created = await tx.systemPrompt.create({
          data: {
            version: nextVersion,
            content: after.trim(),
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
