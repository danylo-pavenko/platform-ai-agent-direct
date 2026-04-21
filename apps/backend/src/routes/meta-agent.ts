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
  // Optional working copy the caller is editing (Sandbox override, PromptsView
  // draft). When provided, the meta-agent reasons about THIS text instead of
  // the DB-active prompt. Falls back to active when omitted/empty.
  currentPromptContent?: string;
}

interface ApplyBody {
  before: string;
  after: string;
  summary: string;
  // When true, the new version becomes active immediately (deactivating all
  // others). When false/omitted, it's created as a draft (isActive: false) —
  // user must explicitly activate via /prompts/:id/activate. Safe default.
  activate?: boolean;
  // Optimistic concurrency token: the id of the active prompt the user saw
  // when the diff was generated. If someone else activated a new version in
  // the meantime, we return 409 so the UI can refresh and the user can retry
  // against the up-to-date prompt.
  basePromptId?: string;
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
  return `Ти - редактор системних промптів для AI Sales Agent магазину ${config.BRAND_NAME}.

Контекст:
- Поточний активний системний промпт агента наведений нижче в блоці <current_prompt>.
- Адміністратор магазину дає тобі інструкцію в чаті - як змінити поведінку бота.

Твоя задача:
1. Зрозуми, що саме адмін хоче змінити.
2. Знайди місце в промпті, куди це логічно вписується.
3. Інтегруй зміну, зберігаючи загальну структуру, tone of voice і всі існуючі обмеження.
4. НЕ видаляй існуючі правила безпеки, ескалації, заборонені дії.
5. НЕ додавай нічого, про що адмін не просив.

Відповідай ТІЛЬКИ у форматі нижче. Якщо потрібно кілька змін - повтори блок ПОЯСНЕННЯ + ЗМІНА для кожної окремо:

ПОЯСНЕННЯ 1: <1-2 речення, що саме змінюється і чому>

ЗМІНА 1:
--- БУЛО ---
<ТОЧНИЙ фрагмент з промпту - скопіюй дослівно>
--- СТАЛО ---
<новий варіант цього фрагменту цілком>

ПОЯСНЕННЯ 2: <якщо є друга зміна>

ЗМІНА 2:
--- БУЛО ---
<ТОЧНИЙ фрагмент>
--- СТАЛО ---
<новий варіант>

ВАЖЛИВО:
- У "БУЛО" завжди копіюй ТОЧНИЙ текст з промпту (copy-paste), навіть якщо змінюєш частину блоку.
- У "СТАЛО" - повний замінений варіант (не тільки нове, а весь блок цілком).
- Якщо додаєш нове правило без аналогу - "БУЛО" залиш порожнім, "СТАЛО" - новий блок.
- НЕ виводь весь промпт - тільки змінені фрагменти.
- Кожен ЗМІНА-блок повинен бути незалежний: застосування одного не повинно ламати інший.

Якщо зміна не потрібна (промпт вже покриває) - скажи це і поясни де.
Якщо запит суперечить правилам безпеки - відмов і поясни.

<current_prompt>
${currentPromptContent}
</current_prompt>`;
}

/**
 * Parse the meta-agent response to extract the LAST suggested diff.
 *
 * When the meta-agent returns multiple ЗМІНА blocks, we take the LAST one -
 * it corresponds to what the UI shows in the diff panel (the final change).
 *
 * Expected format (one or more blocks):
 *   ПОЯСНЕННЯ [N]: ...
 *   ЗМІНА [N]:
 *   --- БУЛО ---
 *   ...old text...
 *   --- СТАЛО ---
 *   ...new text...
 *
 * We are lenient with whitespace and optional numbering.
 */
function parseDiff(text: string): SuggestedDiff | null {
  // Find all occurrences of --- БУЛО --- to identify how many diff blocks exist
  const buloMarker = '--- БУЛО ---';
  const staloMarker = '--- СТАЛО ---';

  // Collect all (buloIdx, staloIdx) pairs
  const pairs: Array<{ buloIdx: number; staloIdx: number }> = [];
  let searchFrom = 0;

  while (true) {
    const buloIdx = text.indexOf(buloMarker, searchFrom);
    if (buloIdx === -1) break;
    const staloIdx = text.indexOf(staloMarker, buloIdx);
    if (staloIdx === -1) break;
    pairs.push({ buloIdx, staloIdx });
    searchFrom = staloIdx + staloMarker.length;
  }

  if (pairs.length === 0) return null;

  // Use the LAST diff block (matches what is visible in the diff panel)
  const { buloIdx, staloIdx } = pairs[pairs.length - 1];

  // "before" = text between end of --- БУЛО --- and --- СТАЛО ---
  const afterBuloMarker = buloIdx + buloMarker.length;
  const before = text.slice(afterBuloMarker, staloIdx).trim();

  // "after" = text from end of --- СТАЛО --- until the next --- БУЛО ---
  // (stop before the next diff block to avoid polluting the content)
  const afterStaloMarker = staloIdx + staloMarker.length;
  const nextBuloIdx = text.indexOf(buloMarker, afterStaloMarker);
  const after = (nextBuloIdx !== -1
    ? text.slice(afterStaloMarker, nextBuloIdx)
    : text.slice(afterStaloMarker)
  ).trim();

  if (!before && !after) return null;

  // Extract the summary from the ПОЯСНЕННЯ line closest before this diff block.
  // Handles both "ПОЯСНЕННЯ:" and "ПОЯСНЕННЯ 2:" / "ПОЯСНЕННЯ N:" variants.
  const textBeforeDiff = text.slice(0, buloIdx);
  const summaryMatch = textBeforeDiff.match(/ПОЯСНЕННЯ(?:\s*\d+)?:\s*(.+?)(?:\n|$)/gi);
  let summary = '';
  if (summaryMatch && summaryMatch.length > 0) {
    // Take the last matching ПОЯСНЕННЯ (closest to this diff block)
    const lastMatch = summaryMatch[summaryMatch.length - 1];
    const m = lastMatch.match(/ПОЯСНЕННЯ(?:\s*\d+)?:\s*(.+)/i);
    if (m) summary = m[1].trim();
  }

  return { before, after, summary };
}

/**
 * Parse ALL diff blocks from the meta-agent response.
 * Returns an array (may be empty if no blocks found).
 * Each block has its own before/after/summary.
 */
function parseAllDiffs(text: string): SuggestedDiff[] {
  const buloMarker = '--- БУЛО ---';
  const staloMarker = '--- СТАЛО ---';
  const results: SuggestedDiff[] = [];

  // Find all БУЛО indices
  const buloPositions: number[] = [];
  let pos = 0;
  while (true) {
    const idx = text.indexOf(buloMarker, pos);
    if (idx === -1) break;
    buloPositions.push(idx);
    pos = idx + buloMarker.length;
  }

  for (let i = 0; i < buloPositions.length; i++) {
    const buloIdx = buloPositions[i];
    const staloIdx = text.indexOf(staloMarker, buloIdx);
    if (staloIdx === -1) break;

    const afterBuloMarker = buloIdx + buloMarker.length;
    const before = text.slice(afterBuloMarker, staloIdx).trim();

    const afterStaloMarker = staloIdx + staloMarker.length;
    // `after` ends at the next БУЛО block (or end of text)
    const nextBuloIdx = buloPositions[i + 1] ?? -1;
    // Also stop at the ПОЯСНЕННЯ marker before next block
    const textAfterStalo = nextBuloIdx !== -1
      ? text.slice(afterStaloMarker, nextBuloIdx)
      : text.slice(afterStaloMarker);
    // Strip trailing ЗМІНА headers
    const after = textAfterStalo.replace(/\s*ЗМІНА\s*\d*\s*:?\s*$/, '').trim();

    if (!before && !after) continue;

    // Extract summary from the ПОЯСНЕННЯ line just before this diff block
    const textBeforeBulo = text.slice(0, buloIdx);
    const allPoyas = textBeforeBulo.match(/ПОЯСНЕННЯ(?:\s*\d+)?:\s*(.+?)(?:\n|$)/gi);
    let summary = '';
    if (allPoyas && allPoyas.length > 0) {
      const lastPoyas = allPoyas[allPoyas.length - 1];
      const m = lastPoyas.match(/ПОЯСНЕННЯ(?:\s*\d+)?:\s*(.+)/i);
      if (m) summary = m[1].trim();
    }

    results.push({ before, after, summary });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export async function metaAgentRoutes(app: FastifyInstance): Promise<void> {
  // POST /chat - Converse with the meta-agent about prompt changes
  app.post<{ Body: ChatBody }>(
    '/chat',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { message, history, currentPromptContent } = request.body ?? {};

      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return reply.code(400).send({ error: 'Message is required' });
      }

      // 1. Resolve which prompt the agent should reason about.
      //    If the caller passed a working copy (Sandbox override / edit-dialog
      //    draft), use it verbatim. Otherwise fall back to the DB-active one.
      let promptContent: string;
      if (typeof currentPromptContent === 'string' && currentPromptContent.trim()) {
        promptContent = currentPromptContent;
      } else {
        const activePrompt = await prisma.systemPrompt.findFirst({
          where: { isActive: true },
        });
        if (!activePrompt) {
          return reply.code(400).send({ error: 'No active prompt found' });
        }
        promptContent = activePrompt.content;
      }

      // 2. Build meta-agent system prompt
      const metaAgentPrompt = buildMetaAgentSystemPrompt(promptContent);

      // 3. Call Claude
      const response = await askClaude(
        {
          systemPrompt: metaAgentPrompt,
          conversationHistory: history ?? [],
          userMessage: message.trim(),
        },
        { channel: 'meta_agent' },
      );

      app.log.info(
        { responseLength: response.text.length },
        'Meta-agent chat response received',
      );

      // 4. Parse all diffs from response
      const suggestedDiffs = parseAllDiffs(response.text);

      if (suggestedDiffs.length > 0) {
        return {
          reply: response.text,
          suggestedDiff: suggestedDiffs[suggestedDiffs.length - 1], // backward compat: last diff
          suggestedDiffs, // all diffs for multi-change UI
        };
      }

      return { reply: response.text };
    },
  );

  // POST /apply - Apply a suggested prompt change
  app.post<{ Body: ApplyBody }>(
    '/apply',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { before, after, summary, activate, basePromptId } = request.body ?? {};

      if (!after || typeof after !== 'string' || after.trim().length === 0) {
        return reply.code(400).send({ error: 'New prompt content (after) is required' });
      }

      // summary is optional - fall back to a generic description if not provided
      const effectiveSummary = (summary && typeof summary === 'string' && summary.trim())
        ? summary.trim()
        : 'Зміна через мета-агент (без опису)';

      const shouldActivate = activate === true;

      // 1. Fetch current active prompt
      const activePrompt = await prisma.systemPrompt.findFirst({
        where: { isActive: true },
      });

      if (!activePrompt) {
        return reply.code(400).send({ error: 'No active prompt found' });
      }

      // 1a. Optimistic concurrency: if the caller remembers which prompt id
      //     was active when they generated the diff, make sure nothing has
      //     been activated since. Prevents two admins racing through
      //     meta-agent and silently stepping on each other's changes.
      if (basePromptId && typeof basePromptId === 'string' && basePromptId !== activePrompt.id) {
        app.log.warn(
          { basePromptId, activeId: activePrompt.id, activeVersion: activePrompt.version },
          'Meta-agent apply: basePromptId is stale — active prompt changed since diff was generated',
        );
        return reply.code(409).send({
          error: 'Активний промпт змінився з моменту генерації діфа. Оновіть сторінку та повторіть запит.',
          currentActiveId: activePrompt.id,
          currentActiveVersion: activePrompt.version,
        });
      }

      // 2. Apply the diff to the full prompt content.
      //
      // Three cases:
      //   a) `before` is provided and found → targeted replacement (most common)
      //   b) `before` is provided but NOT found → 422 error (fragment drifted)
      //   c) `before` is empty → meta-agent is ADDING new content; append to existing
      //
      // We never save just `after` as the full prompt - that would lose existing content.
      let newContent: string;
      if (before && typeof before === 'string' && before.trim()) {
        if (activePrompt.content.includes(before.trim())) {
          // Case a: replace the exact fragment
          newContent = activePrompt.content.replace(before.trim(), after.trim());
        } else {
          app.log.warn(
            { beforeLength: before.length },
            'Meta-agent apply: "before" fragment not found in active prompt - aborting to prevent data loss',
          );
          return reply.code(422).send({
            error: 'Фрагмент "БУЛО" не знайдено в поточному промпті. Можливо промпт змінився. Спробуйте ще раз.',
          });
        }
      } else {
        // Case c: no "before" → append new content to the end of the existing prompt
        app.log.info(
          { afterLength: after.length },
          'Meta-agent apply: no "before" fragment - appending new content to existing prompt',
        );
        newContent = activePrompt.content.trimEnd() + '\n\n' + after.trim();
      }

      // 2a. No-op guard: if the apply didn't change anything (duplicate click,
      //     LLM suggested the same text back), don't pollute history with an
      //     identical version row.
      if (newContent.trim() === activePrompt.content.trim()) {
        app.log.warn(
          { activeId: activePrompt.id },
          'Meta-agent apply: resulting content identical to active — nothing to save',
        );
        return reply.code(400).send({
          error: 'Зміни відсутні — новий контент ідентичний до активного промпту.',
        });
      }

      // 3. Get max version
      const maxVersion = await prisma.systemPrompt.aggregate({
        _max: { version: true },
      });
      const nextVersion = (maxVersion._max.version ?? 0) + 1;

      // 4. Transaction: optionally deactivate, create new, audit log
      const newPrompt = await prisma.$transaction(async (tx) => {
        if (shouldActivate) {
          // Only touch isActive when the user explicitly asked for activation.
          // Drafts coexist with the current active version.
          await tx.systemPrompt.updateMany({
            data: { isActive: false },
          });
        }

        const created = await tx.systemPrompt.create({
          data: {
            version: nextVersion,
            content: newContent,
            author: 'meta_agent',
            authorUserId: request.user.id,
            changeSummary: effectiveSummary,
            isActive: shouldActivate,
          },
        });

        await tx.auditLog.create({
          data: {
            actor: request.user.username,
            action: shouldActivate
              ? 'prompt_activated_via_meta_agent'
              : 'prompt_draft_via_meta_agent',
            entityType: 'system_prompt',
            entityId: created.id,
            payload: {
              summary: effectiveSummary,
              version: created.version,
              basedOn: activePrompt.id,
              basedOnVersion: activePrompt.version,
            },
          },
        });

        return created;
      });

      app.log.info(
        { promptId: newPrompt.id, version: newPrompt.version, activated: shouldActivate },
        shouldActivate
          ? 'Meta-agent applied prompt change (activated)'
          : 'Meta-agent created draft prompt',
      );

      return reply.code(201).send(newPrompt);
    },
  );
}
