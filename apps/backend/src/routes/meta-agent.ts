import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { askClaude } from '../services/claude.js';
import { config } from '../config.js';
import {
  buildClaudeAuthPromptBlock,
  type ClaudeAuthStatus,
} from '../services/claude-auth.js';
import { buildPlatformCapabilitiesBlock } from '../lib/platform-capabilities-prompt.js';
import { getCachedMetaAgentExtras } from '../lib/meta-agent-extras-cache.js';
import { buildMetaPromptContext } from '../services/prompt-sections.js';
import {
  applyDiffToContent,
  applyDiffsSequentially,
  parseMetaAgentResponse,
  type SuggestedDiff,
} from '../lib/meta-agent-diff.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatBody {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  currentPromptContent?: string;
  conversationContext?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** When true, inject full prompt (skip section localization). */
  useFullPrompt?: boolean;
}

interface ApplyBody {
  before: string;
  after: string;
  summary: string;
  activate?: boolean;
  basePromptId?: string;
}

interface ApplyBatchBody {
  diffs: Array<{ before: string; after: string; summary?: string }>;
  summary?: string;
  activate?: boolean;
  basePromptId?: string;
}

export type { SuggestedDiff };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildMetaAgentSystemPrompt(
  currentPromptContent: string,
  conversationContext?: Array<{ role: 'user' | 'assistant'; content: string }>,
  catalogSnippet?: string,
  claudeAuth?: ClaudeAuthStatus,
  telegramBotsBlock?: string,
  options?: {
    userMessage?: string;
    useFullPrompt?: boolean;
    sessionSummary?: string;
  },
): string {
  const userMessage = options?.userMessage?.trim() ?? '';
  const metaCtx =
    options?.useFullPrompt || !userMessage
      ? {
          promptBlock: currentPromptContent,
          usedFullPrompt: true,
          selectedSectionIds: [] as string[],
          sectionCount: 0,
        }
      : buildMetaPromptContext(currentPromptContent, userMessage);

  let contextBlock = '';
  if (conversationContext && conversationContext.length > 0) {
    const formatted = conversationContext
      .map((m) => `${m.role === 'user' ? 'Клієнт' : 'Агент'}: ${m.content}`)
      .join('\n\n');
    contextBlock = `\n\n<active_conversation>
Поточний діалог (контекст для змін промпту):
${formatted}
</active_conversation>

Врахуй цей діалог при пропозиції змін — він показує, як агент зараз відповідає. Пропонуй зміни, які виправлять або покращать саме таку поведінку.`;
  }

  let catalogBlock = '';
  if (catalogSnippet?.trim()) {
    catalogBlock = `\n\n<catalog_snapshot>
Орієнтовний знімок каталогу (для контексту при редагуванні промпту — не джерело цін для клієнта):
${catalogSnippet.trim()}
</catalog_snapshot>`;
  }

  const claudeAuthBlock = claudeAuth ? buildClaudeAuthPromptBlock(claudeAuth) : '';
  const telegramBlock = telegramBotsBlock?.trim()
    ? `\n\n${telegramBotsBlock.trim()}`
    : '';
  const capabilitiesBlock = `\n\n${buildPlatformCapabilitiesBlock()}`;

  const summaryBlock = options?.sessionSummary?.trim()
    ? `\n\n<session_summary>
Підсумок попередніх рішень у цій сесії навчання (не повторюй уже зробленого без потреби):
${options.sessionSummary.trim()}
</session_summary>`
    : '';

  const promptWrapper = metaCtx.usedFullPrompt
    ? `<current_prompt>
${metaCtx.promptBlock}
</current_prompt>`
    : metaCtx.promptBlock;

  return `Ти - редактор системних промптів для AI-агента Instagram DM магазину/салону ${config.BRAND_NAME}.

Контекст:
- Поточний активний (або чернетковий) системний промпт — у блоці нижче (повний або TOC + вибрані секції).
- Адміністратор каже, як змінити поведінку бота.
- Блок <platform_capabilities> — що платформа РЕАЛЬНО вміє (режими, tools, CRM). Орієнтуйся на нього: не пропонуй інструменти чи CRM-дії, яких немає.
- Блок <telegram_bots> — маршрутизація сповіщень менеджерам (без токенів).

Твоя задача:
1. Зрозумій, що саме адмін хоче змінити.
2. Знайди місце в промпті, куди це логічно вписується.
3. Інтегруй зміну, зберігаючи структуру, tone of voice і обмеження безпеки.
4. НЕ видаляй правила безпеки, ескалації, заборонені дії.
5. НЕ додавай нічого, про що адмін не просив (окрім режиму аудиту, якщо адмін його явно просить).
6. Якщо адмін просить «підключити CRM / запис / каталог» — описуй поведінку через ІСНУЮЧІ tools з <platform_capabilities>.

ФОРМАТ ВІДПОВІДІ (обов'язково):
Спочатку коротке пояснення українською (1–4 речення), потім JSON у fenced-блоці:

\`\`\`json
{
  "reply": "<те саме коротке пояснення>",
  "diffs": [
    {
      "sectionId": "<id секції якщо відомий, або порожньо>",
      "before": "<ТОЧНИЙ фрагмент з промпту — copy-paste>",
      "after": "<повний новий варіант цього фрагменту>",
      "summary": "<1 рядок>"
    }
  ]
}
\`\`\`

Правила diffs:
- У "before" завжди ТОЧНИЙ текст з наданого промпту/секцій (copy-paste), навіть якщо змінюєш частину блоку.
- У "after" — повний замінений варіант (не тільки нове речення).
- Якщо додаєш нове правило без аналогу — "before": "".
- НЕ виводь весь промпт — тільки змінені фрагменти.
- Кілька незалежних змін — кілька елементів у diffs.
- Якщо зміна не потрібна — diffs: [] і поясни в reply.
- Якщо запит суперечить безпеці або вимагає неіснуючого tool — відмов, diffs: [].

${promptWrapper}${summaryBlock}${contextBlock}${catalogBlock}${claudeAuthBlock}${telegramBlock}${capabilitiesBlock}`;
}

/** @deprecated Use parseMetaAgentResponse — kept for callers expecting legacy array. */
export function parseAllDiffs(text: string): SuggestedDiff[] {
  return parseMetaAgentResponse(text).diffs;
}

export { parseMetaAgentResponse };

async function createPromptVersion(params: {
  newContent: string;
  activePrompt: { id: string; version: number; content: string };
  summary: string;
  shouldActivate: boolean;
  actorUsername: string;
  authorUserId: string;
}) {
  const { newContent, activePrompt, summary, shouldActivate, actorUsername, authorUserId } =
    params;

  if (newContent.trim() === activePrompt.content.trim()) {
    return { identical: true as const };
  }

  const maxVersion = await prisma.systemPrompt.aggregate({
    _max: { version: true },
  });
  const nextVersion = (maxVersion._max.version ?? 0) + 1;

  const newPrompt = await prisma.$transaction(async (tx) => {
    if (shouldActivate) {
      await tx.systemPrompt.updateMany({
        data: { isActive: false },
      });
    }

    const created = await tx.systemPrompt.create({
      data: {
        version: nextVersion,
        content: newContent,
        author: 'meta_agent',
        authorUserId,
        changeSummary: summary,
        isActive: shouldActivate,
      },
    });

    await tx.auditLog.create({
      data: {
        actor: actorUsername,
        action: shouldActivate
          ? 'prompt_activated_via_meta_agent'
          : 'prompt_draft_via_meta_agent',
        entityType: 'system_prompt',
        entityId: created.id,
        payload: {
          summary,
          version: created.version,
          basedOn: activePrompt.id,
          basedOnVersion: activePrompt.version,
        },
      },
    });

    return created;
  });

  return { identical: false as const, prompt: newPrompt };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export async function metaAgentRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ChatBody }>(
    '/chat',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { message, history, currentPromptContent, conversationContext, useFullPrompt } =
        request.body ?? {};

      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return reply.code(400).send({ error: 'Message is required' });
      }

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

      const extras = await getCachedMetaAgentExtras();
      const metaAgentPrompt = buildMetaAgentSystemPrompt(
        promptContent,
        Array.isArray(conversationContext) ? conversationContext : undefined,
        extras.catalogSnippet,
        extras.claudeAuth,
        extras.telegramBotsBlock,
        { userMessage: message.trim(), useFullPrompt: useFullPrompt === true },
      );

      const response = await askClaude(
        {
          systemPrompt: metaAgentPrompt,
          conversationHistory: history ?? [],
          userMessage: message.trim(),
        },
        { channel: 'meta_agent', timeoutMs: config.CLAUDE_TEACH_TIMEOUT_MS },
      );

      app.log.info(
        { responseLength: response.text.length, fallback: response.fallback ?? null },
        'Meta-agent chat response received',
      );

      const parsed = parseMetaAgentResponse(response.text);
      const suggestedDiffs = parsed.diffs;

      if (suggestedDiffs.length > 0) {
        return {
          reply: parsed.reply || response.text,
          suggestedDiff: suggestedDiffs[suggestedDiffs.length - 1],
          suggestedDiffs,
          fallback: response.fallback ?? null,
          parseFormat: parsed.format,
        };
      }

      return {
        reply: parsed.reply || response.text,
        fallback: response.fallback ?? null,
        parseFormat: parsed.format,
      };
    },
  );

  app.post<{ Body: ApplyBody }>(
    '/apply',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { before, after, summary, activate, basePromptId } = request.body ?? {};

      if (!after || typeof after !== 'string' || after.trim().length === 0) {
        return reply.code(400).send({ error: 'New prompt content (after) is required' });
      }

      const effectiveSummary =
        summary && typeof summary === 'string' && summary.trim()
          ? summary.trim()
          : 'Зміна через мета-агент (без опису)';

      const shouldActivate = activate === true;

      const activePrompt = await prisma.systemPrompt.findFirst({
        where: { isActive: true },
      });

      if (!activePrompt) {
        return reply.code(400).send({ error: 'No active prompt found' });
      }

      if (basePromptId && typeof basePromptId === 'string' && basePromptId !== activePrompt.id) {
        return reply.code(409).send({
          error:
            'Активний промпт змінився з моменту генерації діфа. Оновіть сторінку та повторіть запит.',
          currentActiveId: activePrompt.id,
          currentActiveVersion: activePrompt.version,
        });
      }

      const applied = applyDiffToContent(activePrompt.content, {
        before: typeof before === 'string' ? before : '',
        after,
        summary: effectiveSummary,
      });

      if (!applied.ok) {
        return reply.code(422).send({ error: applied.error });
      }

      const result = await createPromptVersion({
        newContent: applied.content,
        activePrompt,
        summary: effectiveSummary,
        shouldActivate,
        actorUsername: request.user.username,
        authorUserId: request.user.id,
      });

      if (result.identical) {
        return reply.code(400).send({
          error: 'Зміни відсутні — новий контент ідентичний до активного промпту.',
        });
      }

      app.log.info(
        {
          promptId: result.prompt.id,
          version: result.prompt.version,
          activated: shouldActivate,
        },
        shouldActivate
          ? 'Meta-agent applied prompt change (activated)'
          : 'Meta-agent created draft prompt',
      );

      return reply.code(201).send(result.prompt);
    },
  );

  /** Apply multiple diffs atomically on one working copy → one new version. */
  app.post<{ Body: ApplyBatchBody }>(
    '/apply-batch',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { diffs, summary, activate, basePromptId } = request.body ?? {};

      if (!Array.isArray(diffs) || diffs.length === 0) {
        return reply.code(400).send({ error: 'diffs array is required' });
      }

      const normalized = diffs.map((d, i) => ({
        before: typeof d.before === 'string' ? d.before : '',
        after: typeof d.after === 'string' ? d.after : '',
        summary:
          typeof d.summary === 'string' && d.summary.trim()
            ? d.summary.trim()
            : `Зміна ${i + 1}`,
      }));

      if (normalized.some((d) => !d.after.trim())) {
        return reply.code(400).send({ error: 'Each diff requires non-empty after' });
      }

      const shouldActivate = activate === true;
      const activePrompt = await prisma.systemPrompt.findFirst({
        where: { isActive: true },
      });

      if (!activePrompt) {
        return reply.code(400).send({ error: 'No active prompt found' });
      }

      if (basePromptId && typeof basePromptId === 'string' && basePromptId !== activePrompt.id) {
        return reply.code(409).send({
          error:
            'Активний промпт змінився з моменту генерації діфа. Оновіть сторінку та повторіть запит.',
          currentActiveId: activePrompt.id,
          currentActiveVersion: activePrompt.version,
        });
      }

      const batch = applyDiffsSequentially(activePrompt.content, normalized);
      if (!batch.ok) {
        return reply.code(422).send({
          error: batch.error,
          failedIndex: batch.failedIndex,
        });
      }

      const effectiveSummary =
        typeof summary === 'string' && summary.trim()
          ? summary.trim()
          : normalized.map((d) => d.summary).join('; ').slice(0, 500);

      const result = await createPromptVersion({
        newContent: batch.content,
        activePrompt,
        summary: effectiveSummary,
        shouldActivate,
        actorUsername: request.user.username,
        authorUserId: request.user.id,
      });

      if (result.identical) {
        return reply.code(400).send({
          error: 'Зміни відсутні — новий контент ідентичний до активного промпту.',
        });
      }

      app.log.info(
        {
          promptId: result.prompt.id,
          version: result.prompt.version,
          activated: shouldActivate,
          diffCount: normalized.length,
        },
        'Meta-agent apply-batch completed',
      );

      return reply.code(201).send({
        ...result.prompt,
        appliedCount: normalized.length,
      });
    },
  );
}
