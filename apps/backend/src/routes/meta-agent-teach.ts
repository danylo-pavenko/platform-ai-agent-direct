import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { askClaude } from '../services/claude.js';
import { config } from '../config.js';
import {
  appendTeachAssistantMessage,
  appendTeachUserMessage,
  buildClaudeHistoryFromMessages,
  getOrCreateActiveTeachSession,
  startNewTeachSession,
  TEACH_SESSION_EXCHANGE_LIMIT,
} from '../services/meta-agent-teach.js';
import { buildMetaAgentSystemPrompt, parseAllDiffs } from './meta-agent.js';
import { loadCatalogSnippet } from '../services/prompt-builder.js';

interface TeachChatBody {
  message: string;
}

export async function metaAgentTeachRoutes(app: FastifyInstance): Promise<void> {
  // GET /session — active session with full transcript
  app.get(
    '/session',
    { onRequest: [app.authenticate] },
    async (request) => {
      const session = await getOrCreateActiveTeachSession(request.user.id);
      return { session };
    },
  );

  // POST /session/new — close current session and start a fresh one
  app.post(
    '/session/new',
    { onRequest: [app.authenticate] },
    async (request) => {
      const session = await startNewTeachSession(request.user.id);
      return { session };
    },
  );

  // POST /chat — persisted teach chat (Навчання агента tab only)
  app.post<{ Body: TeachChatBody }>(
    '/chat',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { message } = request.body ?? {};

      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return reply.code(400).send({ error: 'Message is required' });
      }

      const active = await getOrCreateActiveTeachSession(request.user.id);

      if (active.contextFull) {
        return reply.code(409).send({
          error: 'Контекст сесії заповнений. Почніть нову сесію, щоб продовжити.',
          code: 'CONTEXT_FULL',
          contextLimit: TEACH_SESSION_EXCHANGE_LIMIT,
          exchangeCount: active.exchangeCount,
        });
      }

      let priorMessages;
      let sessionAfterUser;
      let userMessageId: string;
      try {
        const result = await appendTeachUserMessage(
          active.id,
          request.user.id,
          message.trim(),
        );
        priorMessages = result.priorMessages;
        sessionAfterUser = result.session;
        userMessageId = result.userMessageId;
      } catch (e) {
        if (e instanceof Error && e.message === 'CONTEXT_FULL') {
          return reply.code(409).send({
            error: 'Контекст сесії заповнений. Почніть нову сесію, щоб продовжити.',
            code: 'CONTEXT_FULL',
            contextLimit: TEACH_SESSION_EXCHANGE_LIMIT,
            exchangeCount: active.exchangeCount,
          });
        }
        throw e;
      }

      const activePrompt = await prisma.systemPrompt.findFirst({
        where: { isActive: true },
      });
      if (!activePrompt) {
        return reply.code(400).send({ error: 'No active prompt found' });
      }

      const history = buildClaudeHistoryFromMessages(priorMessages);

      const catalogSnippet = await loadCatalogSnippet();
      const metaAgentPrompt = buildMetaAgentSystemPrompt(
        activePrompt.content,
        undefined,
        catalogSnippet,
      );

      let response;
      try {
        response = await askClaude(
          {
            systemPrompt: metaAgentPrompt,
            conversationHistory: history,
            userMessage: message.trim(),
          },
          { channel: 'meta_agent', timeoutMs: config.CLAUDE_TEACH_TIMEOUT_MS },
        );
      } catch (e) {
        await prisma.metaAgentTeachMessage.delete({ where: { id: userMessageId } });
        app.log.error({ err: e }, 'Meta-agent teach chat: Claude call failed');
        throw e;
      }

      const suggestedDiffs = parseAllDiffs(response.text);

      const session = await appendTeachAssistantMessage(
        sessionAfterUser.id,
        response.text,
        suggestedDiffs.length > 0 ? suggestedDiffs : undefined,
      );

      app.log.info(
        {
          sessionId: session.id,
          messageCount: session.messageCount,
          diffCount: suggestedDiffs.length,
        },
        'Meta-agent teach chat completed',
      );

      if (suggestedDiffs.length > 0) {
        return {
          session,
          reply: response.text,
          suggestedDiff: suggestedDiffs[suggestedDiffs.length - 1],
          suggestedDiffs,
        };
      }

      return { session, reply: response.text };
    },
  );
}
