import pino from 'pino';
import { config } from '../config.js';
import { askClaude } from './claude.js';

const log = pino({ name: 'meta-agent-test' });

const META_AGENT_TEST_SYSTEM = `Ти — тестовий зонд мета-агента ${config.BRAND_NAME}.
Відповідай українською одним коротким реченням, що мета-агент доступний.`;

const META_AGENT_TEST_USER =
  'Тест з Налаштувань. Підтвердь, що ти мета-агент (редактор промптів) і готовий відповідати адміну.';

export interface MetaAgentTestResult {
  ok: boolean;
  reply: string;
  durationMs: number;
  fallback: string | null;
  errorDetail: string | null;
  message: string;
}

/** Minimal Claude invocation on the meta_agent channel (Settings health check). */
export async function runMetaAgentTest(): Promise<MetaAgentTestResult> {
  const startedAt = Date.now();

  const response = await askClaude(
    {
      systemPrompt: META_AGENT_TEST_SYSTEM,
      conversationHistory: [],
      userMessage: META_AGENT_TEST_USER,
    },
    { channel: 'meta_agent', timeoutMs: config.CLAUDE_TEACH_TIMEOUT_MS },
  );

  const durationMs = Date.now() - startedAt;
  const reply = response.text.trim();

  if (response.fallback) {
    log.warn(
      { fallback: response.fallback, errorDetail: response.errorDetail, durationMs },
      'Meta-agent test returned fallback',
    );
    return {
      ok: false,
      reply,
      durationMs,
      fallback: response.fallback,
      errorDetail: response.errorDetail ?? null,
      message:
        response.fallback === 'busy'
          ? 'Мета-агент перевантажений — спробуйте за хвилину.'
          : (response.errorDetail ?? 'Мета-агент не встиг відповісти (таймаут Claude CLI).'),
    };
  }

  if (!reply) {
    return {
      ok: false,
      reply: '',
      durationMs,
      fallback: null,
      errorDetail: 'empty response',
      message: 'Мета-агент повернув порожню відповідь.',
    };
  }

  log.info({ durationMs, replyLength: reply.length }, 'Meta-agent test succeeded');
  return {
    ok: true,
    reply,
    durationMs,
    fallback: null,
    errorDetail: null,
    message: `Мета-агент відповів за ${Math.round(durationMs / 1000)} с.`,
  };
}
