import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import type { Prisma } from '../generated/prisma/client.js';

const log = pino({ name: 'prompt-runtime' });

/** Settings key: monotonic counter bumped on every prompt activate. */
export const PROMPT_RUNTIME_GENERATION_KEY = 'prompt_runtime_generation';

export const FALLBACK_SYSTEM_PROMPT =
  'Ти — AI-асистент бізнесу в Instagram Direct. Відповідай коротко, спирайся на факти з системного промпту та живого каталогу/tools, не вигадуй ціни й умови.';

export type ActiveSystemPrompt = {
  id: string | null;
  version: number | null;
  content: string;
};

export type PromptRuntimeMeta = {
  id: string | null;
  version: number | null;
  generation: number;
};

type TxClient = Prisma.TransactionClient;

function parseGeneration(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'object' && value !== null && 'n' in value) {
    const n = (value as { n: unknown }).n;
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
      return Math.floor(n);
    }
  }
  return 0;
}

/**
 * Fetches the active system prompt row (id + version + content).
 * Falls back to a generic prompt if none is found.
 */
export async function getActiveSystemPrompt(): Promise<ActiveSystemPrompt> {
  try {
    const prompt = await prisma.systemPrompt.findFirst({
      where: { isActive: true },
      select: { id: true, version: true, content: true },
    });

    if (!prompt) {
      return { id: null, version: null, content: FALLBACK_SYSTEM_PROMPT };
    }

    return {
      id: prompt.id,
      version: prompt.version,
      content: prompt.content,
    };
  } catch (err) {
    log.error({ err }, 'Failed to fetch active system prompt');
    return { id: null, version: null, content: FALLBACK_SYSTEM_PROMPT };
  }
}

/** Content-only helper (backward compatible with older call sites). */
export async function getActivePromptContent(): Promise<string> {
  return (await getActiveSystemPrompt()).content;
}

export async function getPromptRuntimeGeneration(
  client: TxClient | typeof prisma = prisma,
): Promise<number> {
  try {
    const row = await client.setting.findUnique({
      where: { key: PROMPT_RUNTIME_GENERATION_KEY },
    });
    return parseGeneration(row?.value);
  } catch (err) {
    log.warn({ err }, 'Failed to read prompt runtime generation');
    return 0;
  }
}

/**
 * Bump the activation generation counter (call inside activate transaction).
 * Returns the new generation value.
 */
export async function bumpPromptRuntimeGeneration(
  client: TxClient | typeof prisma = prisma,
): Promise<number> {
  const current = await getPromptRuntimeGeneration(client);
  const next = current + 1;
  await client.setting.upsert({
    where: { key: PROMPT_RUNTIME_GENERATION_KEY },
    create: { key: PROMPT_RUNTIME_GENERATION_KEY, value: next },
    update: { value: next },
  });
  return next;
}

export async function getActivePromptFingerprint(): Promise<PromptRuntimeMeta> {
  const [prompt, generation] = await Promise.all([
    prisma.systemPrompt.findFirst({
      where: { isActive: true },
      select: { id: true, version: true },
    }),
    getPromptRuntimeGeneration(),
  ]);

  return {
    id: prompt?.id ?? null,
    version: prompt?.version ?? null,
    generation,
  };
}

export type RuntimePromptSession = {
  getMeta(): PromptRuntimeMeta;
  getPrompt(): string;
  /**
   * Re-check active prompt id + generation. If activate happened mid-turn,
   * rebuild the runtime system prompt string and return refreshed=true.
   */
  refreshIfStale(): Promise<{
    prompt: string;
    refreshed: boolean;
    meta: PromptRuntimeMeta;
  }>;
};

/**
 * Holds the assembled runtime prompt for one conversation turn and soft-refreshes
 * when Admin activates a different prompt while tool rounds are still running.
 */
export function createRuntimePromptSession(opts: {
  initial: ActiveSystemPrompt;
  generation: number;
  rebuild: (content: string) => string;
  /** Injectable for tests — defaults to DB fingerprint lookup. */
  fetchFingerprint?: () => Promise<PromptRuntimeMeta>;
  /** Injectable for tests — load full content when fingerprint changes. */
  fetchActive?: () => Promise<ActiveSystemPrompt>;
}): RuntimePromptSession {
  let meta: PromptRuntimeMeta = {
    id: opts.initial.id,
    version: opts.initial.version,
    generation: opts.generation,
  };
  let prompt = opts.rebuild(opts.initial.content);

  const fetchFingerprint = opts.fetchFingerprint ?? getActivePromptFingerprint;
  const fetchActive = opts.fetchActive ?? getActiveSystemPrompt;

  return {
    getMeta: () => meta,
    getPrompt: () => prompt,
    async refreshIfStale() {
      const fp = await fetchFingerprint();
      if (fp.id === meta.id && fp.generation === meta.generation) {
        return { prompt, refreshed: false, meta };
      }

      const active = await fetchActive();
      prompt = opts.rebuild(active.content);
      meta = {
        id: active.id,
        version: active.version,
        generation: fp.generation,
      };
      return { prompt, refreshed: true, meta };
    },
  };
}
