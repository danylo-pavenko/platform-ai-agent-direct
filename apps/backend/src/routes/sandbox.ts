import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import pino from 'pino';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { askClaude } from '../services/claude.js';
import { gateCustomerFacingReply } from '../lib/assistant-output.js';
import { getAgentConfig,
  normalizeClaudeReplyModel,
} from '../lib/agent-config.js';
import { buildAgentTools } from '../lib/tool-definitions.js';
import { getActiveCrmFieldMappings } from '../lib/crm-field-mappings.js';
import { isCrmWriteEnabled } from '../lib/crm-write.js';
import { stripMarkdownForInstagram } from '../lib/instagram-text.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { formatBotFailureDetail } from '../lib/agent-fallback.js';
import { formatBranchesForPrompt, getDefaultBranch } from '../services/branches.js';
import { resolveBookingBranchCrmId } from '../services/booking-branch.js';
import { createTurnClaudeSessions } from '../lib/turn-claude-sessions.js';
import {
  buildSandboxCopyBundle,
  type SandboxFailure,
} from '../services/sandbox-copy-bundle.js';
import {
  buildRuntimePrompt,
  getActivePrompt,
  getWorkingHours,
  isWithinWorkingHours,
  loadCatalogSnippetForMode,
} from '../services/prompt-builder.js';
import {
  buildReturningPersonaHistory,
  executeSandboxToolCall,
  MAX_TOOL_ROUNDS,
  pickSandboxToolCall,
  previewToolResult,
  stageLabelForTool,
  type SandboxToolDebugEntry,
} from '../services/sandbox-tools.js';

const log = pino({ name: 'sandbox' });

const chatBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      }),
    )
    .min(1),
  systemPromptId: z.string().optional(),
  promptOverride: z.string().optional(),
  persona: z.enum(['new', 'returning']).optional().default('new'),
});

interface SaveCaseBody {
  name: string;
  messages: string[];
}

type ClaudeRoundDebug = {
  round: number;
  fallback?: 'busy' | 'timeout' | null;
  errorDetail?: string | null;
  toolCall?: string | null;
  textPreview?: string;
};

const MAX_CASES = 15;

async function buildSandboxMeta() {
  const agentCfg = await getAgentConfig();
  const defaultBranch = await getDefaultBranch();
  const branchCrmId = await resolveBookingBranchCrmId(defaultBranch?.crmExternalId);
  const { beautypro } = await getIntegrationConfig();
  const locationLabel =
    defaultBranch?.displayName ||
    (beautypro.defaultLocationId
      ? `BeautyPro location ${beautypro.defaultLocationId.slice(0, 8)}…`
      : null);

  return {
    agentMode: agentCfg.mode,
    locationLabel,
    branchCrmId,
    fidelity: {
      reads: 'live' as const,
      writes: 'dry-run' as const,
    },
    warnings: branchCrmId
      ? ([] as string[])
      : ([
          'Немає CRM локації для слотів. Налаштуй філію або BeautyPro default location.',
        ] as string[]),
  };
}

function previewText(text: string, max = 280): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

export async function sandboxRoutes(app: FastifyInstance): Promise<void> {
  app.get('/meta', { onRequest: [app.authenticate] }, async () => buildSandboxMeta());

  app.post(
    '/chat',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const parsed = chatBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Messages array is required' });
      }
      const { messages, systemPromptId, promptOverride, persona } = parsed.data;

      const lastMessage = messages[messages.length - 1];
      if (!lastMessage || lastMessage.role !== 'user') {
        return reply.code(400).send({ error: 'Last message must be from user' });
      }

      const startedAt = Date.now();
      let failure: SandboxFailure | null = null;
      const toolDebug: SandboxToolDebugEntry[] = [];
      const stages: string[] = [];
      const claudeRounds: ClaudeRoundDebug[] = [];

      try {
        let promptContent: string;
        let promptVersion: number | null = null;
        if (promptOverride) {
          promptContent = promptOverride;
        } else if (systemPromptId) {
          const prompt = await prisma.systemPrompt.findUnique({
            where: { id: systemPromptId },
            select: { content: true, version: true },
          });
          promptContent = prompt?.content ?? (await getActivePrompt());
          promptVersion = prompt?.version ?? null;
        } else {
          const active = await prisma.systemPrompt.findFirst({
            where: { isActive: true },
            select: { content: true, version: true },
          });
          promptContent = active?.content ?? (await getActivePrompt());
          promptVersion = active?.version ?? null;
        }

        const now = new Date();
        const workingHours = await getWorkingHours();
        const agentCfg = await getAgentConfig();
        const catalogSnippet = await loadCatalogSnippetForMode(agentCfg.mode);
        const isOutOfHours = !isWithinWorkingHours(now, workingHours);
        const branchesList = await formatBranchesForPrompt();
        const activeBranchCount = await prisma.branch.count({ where: { isActive: true } });
        const defaultBranch = await getDefaultBranch();
        const meta = await buildSandboxMeta();

        const crmWritesEnabled = await isCrmWriteEnabled();
        const crmMappings = crmWritesEnabled ? await getActiveCrmFieldMappings() : null;

        const clientProfile =
          persona === 'returning'
            ? {
                igUsername: 'sandbox_returning',
                igFullName: 'Тестова клієнтка',
                phone: '380501112233',
                crmVisitHistory: buildReturningPersonaHistory(),
              }
            : {
                igUsername: 'sandbox_test',
              };

        const systemPrompt = buildRuntimePrompt({
          activePromptContent: promptContent,
          catalogSnippet,
          currentTime: now,
          workingHours,
          conversationState: 'bot',
          clientIgUserId: persona === 'returning' ? 'sandbox_returning' : 'sandbox_test',
          clientProfile,
          conversationIdShort: 'sandbox',
          isOutOfHours,
          agentMode: agentCfg.mode,
          outOfHoursStrategy: agentCfg.outOfHoursStrategy,
          managerSlaHoursBusiness: agentCfg.managerSlaHoursBusiness,
          branchesList,
          customFieldHints: crmMappings?.buyer.map((m) => ({
            localKey: m.localKey,
            label: m.label,
            promptHint: m.promptHint,
          })),
          selectedBranch: defaultBranch
            ? {
                slug: defaultBranch.slug,
                displayName: defaultBranch.displayName,
                address: defaultBranch.address,
                crmExternalId: defaultBranch.crmExternalId,
              }
            : undefined,
        });

        const tools = buildAgentTools(agentCfg.mode, {
          buyerScopeMappings: crmMappings?.buyer ?? [],
          leadScopeMappings: crmMappings?.lead ?? [],
          hasBranches: activeBranchCount > 0,
        });

        const history = messages.slice(0, -1).map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

        let userMessage = lastMessage.content;
        let conversationHistory = [...history];
        let finalText = '';
        const sessions = createTurnClaudeSessions();
        const replyModel = normalizeClaudeReplyModel(agentCfg.claudeModel);
        const onSandboxDisconnect = () => sessions.abortInflight();
        request.raw.on('close', onSandboxDisconnect);

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const resumeSessionId = sessions.resumeId();
          const sandboxCtx = {
            channel: 'sandbox' as const,
            model: replyModel,
            timeoutMs: config.CLAUDE_TEACH_TIMEOUT_MS,
            signal: sessions.signal,
          };

          const response = await askClaude(
            {
              systemPrompt,
              conversationHistory,
              userMessage,
              tools,
              ...(resumeSessionId ? { resumeSessionId } : {}),
            },
            sandboxCtx,
          );

          if (response.fallback) {
            sessions.noteFallback();
          } else {
            sessions.noteSuccess(response.sessionId);
          }

          finalText = response.text;
          const toolCall = pickSandboxToolCall(response.toolCalls ?? []);

          claudeRounds.push({
            round,
            fallback: response.fallback ?? null,
            errorDetail: response.errorDetail ?? null,
            toolCall: toolCall?.name ?? null,
            textPreview: previewText(response.text || ''),
          });

          if (response.fallback) {
            failure = {
              code: response.fallback,
              reasonUk: formatBotFailureDetail({
                code: response.fallback,
                errorDetail: response.errorDetail,
                clientMessage: lastMessage.content,
              }),
              errorDetail: response.errorDetail ?? null,
            };
            break;
          }

          if (!toolCall) break;

          stages.push(stageLabelForTool(toolCall.name));
          const reusedLookup = response.lookupResults?.find((r) => r.name === toolCall.name);
          const executed = reusedLookup
            ? { content: reusedLookup.result }
            : await executeSandboxToolCall(toolCall);
          toolDebug.push({
            name: toolCall.name,
            args: toolCall.args,
            resultPreview: previewToolResult(executed.content),
            dryRun: executed.dryRun,
          });

          conversationHistory = [
            ...conversationHistory,
            { role: 'user' as const, content: userMessage },
            {
              role: 'assistant' as const,
              content: response.text || `[tool: ${toolCall.name}]`,
            },
          ];
          userMessage = executed.content;
        }

        const gated = gateCustomerFacingReply(finalText);
        const clientReply = stripMarkdownForInstagram(gated.text);

        if (!failure && gated.rejected) {
          failure = {
            code: 'output_validation',
            reasonUk: formatBotFailureDetail({
              code: 'output_validation',
              errorDetail: gated.reason,
              clientMessage: lastMessage.content,
              agentText: finalText,
              gateReason: gated.reason,
            }),
            errorDetail: gated.reason,
          };
        }

        if (!failure && !clientReply.trim()) {
          failure = {
            code: 'empty',
            reasonUk: 'Агент повернув порожню відповідь після обробки.',
            errorDetail: 'empty_reply',
          };
        }

        const toolErrors = toolDebug
          .filter((t) => /ПОМИЛКА/i.test(t.resultPreview))
          .map((t) => `${t.name}: ${t.resultPreview.slice(0, 200)}`);

        const debug = {
          agentMode: agentCfg.mode,
          promptVersion,
          persona,
          locationLabel: meta.locationLabel,
          branchCrmId: meta.branchCrmId,
          fidelity: meta.fidelity,
          warnings: [...meta.warnings, ...toolErrors],
          stages,
          tools: toolDebug,
          claudeRounds,
          durationMs: Date.now() - startedAt,
          gateReason: gated.reason,
        };

        const ok = failure == null;
        const copyBundle = buildSandboxCopyBundle({
          ok,
          failure,
          reply: clientReply,
          lastUserMessage: lastMessage.content,
          debug,
        });

        return {
          ok,
          reply: clientReply,
          failure,
          debug: {
            ...debug,
            copyBundle,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err }, 'sandbox chat failed');
        failure = {
          code: 'exception',
          reasonUk: `Внутрішня помилка пісочниці: ${message}`,
          errorDetail: message,
        };
        const debug = {
          tools: toolDebug,
          stages,
          claudeRounds,
          durationMs: Date.now() - startedAt,
          exception: message,
        };
        const copyBundle = buildSandboxCopyBundle({
          ok: false,
          failure,
          reply: '',
          lastUserMessage: lastMessage.content,
          debug,
        });
        return reply.code(200).send({
          ok: false,
          reply: failure.reasonUk,
          failure,
          error: failure.reasonUk,
          debug: {
            ...debug,
            copyBundle,
          },
        });
      }
    },
  );

  app.get('/cases', { onRequest: [app.authenticate] }, async () => {
    return prisma.sandboxCase.findMany({ orderBy: { updatedAt: 'desc' } });
  });

  app.post<{ Body: SaveCaseBody }>(
    '/cases',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { name, messages } = request.body ?? {};

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return reply.code(400).send({ error: 'Name is required' });
      }

      if (!Array.isArray(messages) || messages.length === 0) {
        return reply.code(400).send({ error: 'At least one message is required' });
      }

      const count = await prisma.sandboxCase.count();
      if (count >= MAX_CASES) {
        return reply.code(400).send({
          error: `Максимум ${MAX_CASES} збережених кейсів. Видаліть старі перед додаванням нових.`,
        });
      }

      const created = await prisma.sandboxCase.create({
        data: {
          name: name.trim(),
          messages: messages as any,
        },
      });

      return reply.code(201).send(created);
    },
  );

  app.put<{ Params: { id: string }; Body: SaveCaseBody }>(
    '/cases/:id',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params;
      const { name, messages } = request.body ?? {};

      const existing = await prisma.sandboxCase.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Case not found' });
      }

      return prisma.sandboxCase.update({
        where: { id },
        data: {
          ...(name ? { name: name.trim() } : {}),
          ...(messages ? { messages: messages as any } : {}),
        },
      });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/cases/:id',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params;
      const existing = await prisma.sandboxCase.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Case not found' });
      }
      await prisma.sandboxCase.delete({ where: { id } });
      return { ok: true };
    },
  );

  app.get('/prompts', { onRequest: [app.authenticate] }, async () => {
    return prisma.systemPrompt.findMany({
      select: {
        id: true,
        version: true,
        changeSummary: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { version: 'desc' },
    });
  });
}
