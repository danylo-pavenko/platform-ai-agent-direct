import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { askClaude, askClaudeStream } from '../services/claude.js';
import { config } from '../config.js';
import {
  appendTeachAssistantMessage,
  appendTeachUserMessage,
  buildClaudeHistoryFromMessages,
  getOrCreateActiveTeachSession,
  startNewTeachSession,
} from '../services/meta-agent-teach.js';
import { buildMetaAgentSystemPrompt, parseMetaAgentResponse } from './meta-agent.js';
import { getCachedMetaAgentExtras } from '../lib/meta-agent-extras-cache.js';

interface TeachChatBody {
  message: string;
  conversationContext?: Array<{ role: 'user' | 'assistant'; content: string }>;
  conversationId?: string;
  useFullPrompt?: boolean;
}

const MAX_CONVERSATION_CONTEXT = 40;

async function loadConversationContext(
  conversationId: string | undefined,
  explicit?: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }> | undefined> {
  if (Array.isArray(explicit) && explicit.length > 0) {
    return explicit.slice(-MAX_CONVERSATION_CONTEXT);
  }
  if (!conversationId || typeof conversationId !== 'string') return undefined;

  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: MAX_CONVERSATION_CONTEXT,
    select: { sender: true, text: true },
  });
  messages.reverse();

  const mapped: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    const text = (m.text ?? '').trim();
    if (!text) continue;
    if (m.sender === 'client') {
      mapped.push({ role: 'user', content: text });
    } else if (m.sender === 'bot' || m.sender === 'manager') {
      mapped.push({ role: 'assistant', content: text });
    }
  }
  return mapped.length > 0 ? mapped : undefined;
}

function sseWrite(reply: { raw: NodeJS.WritableStream }, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function metaAgentTeachRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/session',
    { onRequest: [app.authenticate] },
    async (request) => {
      const session = await getOrCreateActiveTeachSession(request.user.id);
      return { session };
    },
  );

  app.post(
    '/session/new',
    { onRequest: [app.authenticate] },
    async (request) => {
      const session = await startNewTeachSession(request.user.id);
      return { session };
    },
  );

  // Non-stream teach chat (compat / simple clients)
  app.post<{ Body: TeachChatBody }>(
    '/chat',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { message, conversationContext, conversationId, useFullPrompt } = request.body ?? {};

      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return reply.code(400).send({ error: 'Message is required' });
      }

      const active = await getOrCreateActiveTeachSession(request.user.id);

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
        if (e instanceof Error && e.message === 'SESSION_NOT_FOUND') {
          return reply.code(404).send({ error: 'Session not found' });
        }
        throw e;
      }

      const activePrompt = await prisma.systemPrompt.findFirst({
        where: { isActive: true },
      });
      if (!activePrompt) {
        return reply.code(400).send({ error: 'No active prompt found' });
      }

      const history = buildClaudeHistoryFromMessages(
        priorMessages,
        sessionAfterUser.sessionSummary,
      );
      const convCtx = await loadConversationContext(conversationId, conversationContext);
      const extras = await getCachedMetaAgentExtras();
      const metaAgentPrompt = buildMetaAgentSystemPrompt(
        activePrompt.content,
        convCtx,
        extras.catalogSnippet,
        extras.claudeAuth,
        extras.telegramBotsBlock,
        {
          userMessage: message.trim(),
          useFullPrompt: useFullPrompt === true,
          sessionSummary: sessionAfterUser.sessionSummary ?? undefined,
        },
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

      const parsed = parseMetaAgentResponse(response.text);
      const suggestedDiffs = parsed.diffs;
      const replyText = parsed.reply || response.text;

      const session = await appendTeachAssistantMessage(
        sessionAfterUser.id,
        replyText,
        suggestedDiffs.length > 0 ? suggestedDiffs : undefined,
      );

      app.log.info(
        {
          sessionId: session.id,
          messageCount: session.messageCount,
          diffCount: suggestedDiffs.length,
          fallback: response.fallback ?? null,
        },
        'Meta-agent teach chat completed',
      );

      return {
        session,
        reply: replyText,
        ...(suggestedDiffs.length > 0
          ? {
              suggestedDiff: suggestedDiffs[suggestedDiffs.length - 1],
              suggestedDiffs,
            }
          : {}),
        fallback: response.fallback ?? null,
        parseFormat: parsed.format,
      };
    },
  );

  /**
   * SSE teach chat: stages + text deltas + final session/diffs.
   * Client: POST with Accept text/event-stream, Authorization Bearer.
   */
  app.post<{ Body: TeachChatBody }>(
    '/chat/stream',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { message, conversationContext, conversationId, useFullPrompt } = request.body ?? {};

      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return reply.code(400).send({ error: 'Message is required' });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let clientOpen = true;
      const ac = new AbortController();
      request.raw.on('close', () => {
        clientOpen = false;
        ac.abort();
      });

      const send = (event: string, data: unknown) => {
        if (!clientOpen) return;
        try {
          sseWrite(reply, event, data);
        } catch {
          clientOpen = false;
          ac.abort();
        }
      };

      try {
        send('stage', { stage: 'context', label: 'Готую контекст…' });

        const active = await getOrCreateActiveTeachSession(request.user.id);
        const result = await appendTeachUserMessage(
          active.id,
          request.user.id,
          message.trim(),
        );
        const { priorMessages, session: sessionAfterUser, userMessageId } = result;

        const activePrompt = await prisma.systemPrompt.findFirst({
          where: { isActive: true },
        });
        if (!activePrompt) {
          send('error', { error: 'No active prompt found' });
          reply.raw.end();
          return;
        }

        const history = buildClaudeHistoryFromMessages(
          priorMessages,
          sessionAfterUser.sessionSummary,
        );
        const convCtx = await loadConversationContext(conversationId, conversationContext);
        const extras = await getCachedMetaAgentExtras();
        const metaAgentPrompt = buildMetaAgentSystemPrompt(
          activePrompt.content,
          convCtx,
          extras.catalogSnippet,
          extras.claudeAuth,
          extras.telegramBotsBlock,
          {
            userMessage: message.trim(),
            useFullPrompt: useFullPrompt === true,
            sessionSummary: sessionAfterUser.sessionSummary ?? undefined,
          },
        );

        send('stage', { stage: 'generate', label: 'Генерую правки…' });

        let streamed = '';
        const response = await askClaudeStream(
          {
            systemPrompt: metaAgentPrompt,
            conversationHistory: history,
            userMessage: message.trim(),
          },
          (ev) => {
            if (ev.type === 'delta' && ev.text) {
              streamed += ev.text;
              send('delta', { text: ev.text });
            }
          },
          { channel: 'meta_agent', timeoutMs: config.CLAUDE_TEACH_TIMEOUT_MS },
          ac.signal,
        );

        if (ac.signal.aborted || !clientOpen) {
          // Client gone — still persist assistant text if we have something useful
          const text = (response.text || streamed).trim();
          if (text && !response.fallback) {
            const parsed = parseMetaAgentResponse(text);
            await appendTeachAssistantMessage(
              sessionAfterUser.id,
              parsed.reply || text,
              parsed.diffs.length > 0 ? parsed.diffs : undefined,
            );
          } else {
            await prisma.metaAgentTeachMessage.delete({ where: { id: userMessageId } }).catch(() => {});
          }
          try {
            reply.raw.end();
          } catch {
            /* ignore */
          }
          return;
        }

        if (response.fallback) {
          await prisma.metaAgentTeachMessage.delete({ where: { id: userMessageId } }).catch(() => {});
          send('error', {
            error: response.text,
            fallback: response.fallback,
            errorDetail: response.errorDetail ?? null,
          });
          reply.raw.end();
          return;
        }

        const finalText = response.text || streamed;
        const parsed = parseMetaAgentResponse(finalText);
        const suggestedDiffs = parsed.diffs;
        const replyText = parsed.reply || finalText;

        const session = await appendTeachAssistantMessage(
          sessionAfterUser.id,
          replyText,
          suggestedDiffs.length > 0 ? suggestedDiffs : undefined,
        );

        send('done', {
          session,
          reply: replyText,
          suggestedDiffs,
          suggestedDiff:
            suggestedDiffs.length > 0
              ? suggestedDiffs[suggestedDiffs.length - 1]
              : null,
          parseFormat: parsed.format,
          fallback: null,
        });
        reply.raw.end();
      } catch (err) {
        app.log.error({ err }, 'Meta-agent teach stream failed');
        send('error', {
          error: err instanceof Error ? err.message : 'Teach stream failed',
        });
        try {
          reply.raw.end();
        } catch {
          /* ignore */
        }
      }
    },
  );
}
