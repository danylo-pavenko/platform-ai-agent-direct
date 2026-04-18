import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { askClaude } from '../services/claude.js';
import {
  buildRuntimePrompt,
  getActivePrompt,
  getWorkingHours,
  isWithinWorkingHours,
  loadCatalogSnippet,
} from '../services/prompt-builder.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatBody {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPromptId?: string;
  promptOverride?: string;
}

interface SaveCaseBody {
  name: string;
  messages: string[]; // Only client messages (strings)
}

const MAX_CASES = 15;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export async function sandboxRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /chat — Send message to AI agent (sandbox, isolated) ──────
  app.post<{ Body: ChatBody }>(
    '/chat',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { messages, systemPromptId, promptOverride } = request.body ?? {};

      if (!Array.isArray(messages) || messages.length === 0) {
        return reply.code(400).send({ error: 'Messages array is required' });
      }

      const lastMessage = messages[messages.length - 1];
      if (!lastMessage || lastMessage.role !== 'user') {
        return reply.code(400).send({ error: 'Last message must be from user' });
      }

      // 1. Get system prompt content
      let promptContent: string;
      if (promptOverride) {
        promptContent = promptOverride;
      } else if (systemPromptId) {
        const prompt = await prisma.systemPrompt.findUnique({
          where: { id: systemPromptId },
          select: { content: true },
        });
        promptContent = prompt?.content ?? await getActivePrompt();
      } else {
        promptContent = await getActivePrompt();
      }

      // 2. Build runtime prompt with real context
      const now = new Date();
      const workingHours = await getWorkingHours();
      const catalogSnippet = await loadCatalogSnippet();
      const isOutOfHours = !isWithinWorkingHours(now, workingHours);

      const systemPrompt = buildRuntimePrompt({
        activePromptContent: promptContent,
        catalogSnippet,
        currentTime: now,
        workingHours,
        conversationState: 'bot',
        clientIgUserId: 'sandbox_test',
        conversationIdShort: 'sandbox',
        isOutOfHours,
      });

      // 3. Prepare history (all messages except last)
      const history = messages.slice(0, -1).map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

      // 4. Call Claude
      const response = await askClaude({
        systemPrompt,
        conversationHistory: history,
        userMessage: lastMessage.content,
      });

      return { reply: response.text };
    },
  );

  // ── GET /cases — List saved test cases ─────────────────────────────
  app.get(
    '/cases',
    { onRequest: [app.authenticate] },
    async () => {
      const cases = await prisma.sandboxCase.findMany({
        orderBy: { updatedAt: 'desc' },
      });
      return cases;
    },
  );

  // ── POST /cases — Save a test case ─────────────────────────────────
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

      // Check limit
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

  // ── PUT /cases/:id — Update a test case ────────────────────────────
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

      const updated = await prisma.sandboxCase.update({
        where: { id },
        data: {
          ...(name ? { name: name.trim() } : {}),
          ...(messages ? { messages: messages as any } : {}),
        },
      });

      return updated;
    },
  );

  // ── DELETE /cases/:id — Delete a test case ─────────────────────────
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

  // ── GET /prompts — List all prompts for sandbox selector ───────────
  app.get(
    '/prompts',
    { onRequest: [app.authenticate] },
    async () => {
      const prompts = await prisma.systemPrompt.findMany({
        select: { id: true, version: true, changeSummary: true, isActive: true, createdAt: true },
        orderBy: { version: 'desc' },
      });
      return prompts;
    },
  );
}
