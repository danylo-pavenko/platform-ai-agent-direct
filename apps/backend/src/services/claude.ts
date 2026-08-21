import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pino from 'pino';
import { config } from '../config.js';
import {
  classifyClaudeLiveProbe,
  isClaudeAuthFailure,
  isClaudeRateLimitSignal,
  type ClaudeAuthHealth,
} from '../lib/claude-auth-probe.js';
import {
  evaluateClaudeSpawn,
  isClaudeBackgroundSpawnBlocked,
  purposeFromAgentChannel,
  type ClaudeSpawnPurpose,
} from '../lib/claude-quota-gate.js';
import { getClaudeBinaryPath } from '../lib/claude-binary.js';
import { resolveClaudeSpawnCwd } from '../lib/claude-spawn-cwd.js';
import { Semaphore } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import { getAgentConfig, normalizeClaudeModel, type ClaudeModelId } from '../lib/agent-config.js';
import type { AgentChannel } from '../generated/prisma/enums.js';
import { loadClaudeUsageSnapshot } from './claude-usage-monitor.js';
import { recordClaudeRateLimit, releaseExpiredClaudeQuotaIfNeeded } from './claude-quota.js';
import {
  CLAUDE_WARMUP_REQUEST,
  claudeConcurrencyLane,
  claudeFallbackResponse,
  claudeTimeoutMs,
  parseClaudeRuntimeKind,
  type ClaudeCallContext,
  type ClaudeRequest,
  type ClaudeResponse,
  type ClaudeRuntime,
  type ClaudeRuntimeInvokeOptions,
} from '../lib/claude-runtime.js';
import { finalizeClaudeResponse } from '../lib/claude-finalize-response.js';
import { createClaudeRuntime } from './claude-runtime-factory.js';
import {
  buildClaudePrompt,
  spawnClaude,
} from './claude-cli-runtime.js';

export { getClaudeBinaryPath, resolveClaudeSpawnCwd };
export type {
  ClaudeCallContext,
  ClaudeRequest,
  ClaudeResponse,
  ClaudeRuntime,
  ClaudeRuntimeKind,
  ToolDefinition,
} from '../lib/claude-runtime.js';
export {
  buildClaudeCliArgsForTest,
  buildClaudePromptForTest,
} from './claude-cli-runtime.js';

const execFileAsync = promisify(execFile);
const log = pino({ name: 'claude' });

const semaphore = new Semaphore(config.CLAUDE_MAX_CONCURRENCY);
const metaSemaphore = new Semaphore(config.CLAUDE_META_MAX_CONCURRENCY);

function semaphoreFor(context?: ClaudeCallContext): Semaphore {
  return claudeConcurrencyLane(context?.channel) === 'meta' ? metaSemaphore : semaphore;
}

function fallbackFor(
  reason: 'busy' | 'timeout',
  context?: ClaudeCallContext,
  errorDetail?: string,
): ClaudeResponse {
  return claudeFallbackResponse(reason, context, errorDetail);
}

function timeoutFor(context?: ClaudeCallContext): number {
  return claudeTimeoutMs(context, {
    adminMs: config.CLAUDE_ADMIN_TIMEOUT_MS,
    customerMs: config.CLAUDE_TIMEOUT_MS,
  });
}

const MAX_PENDING = 10;

async function resolveClaudeModel(context?: ClaudeCallContext): Promise<ClaudeModelId> {
  if (context?.model) return normalizeClaudeModel(context.model);
  const cfg = await getAgentConfig();
  return cfg.claudeModel;
}

/** Test seam — inject a mock runtime without changing `CLAUDE_RUNTIME`. */
let runtimeOverride: ClaudeRuntime | undefined;

export function setClaudeRuntimeForTest(runtime: ClaudeRuntime | undefined): void {
  runtimeOverride = runtime;
}

function getClaudeRuntime(): ClaudeRuntime {
  if (runtimeOverride) return runtimeOverride;
  return createClaudeRuntime(parseClaudeRuntimeKind(config.CLAUDE_RUNTIME));
}

function recordInvocation(row: {
  channel: AgentChannel;
  conversationId?: string;
  clientId?: string;
  durationMs: number;
  success: boolean;
  fallbackReason: string | null;
  errorMessage: string | null;
  inputChars: number;
  outputChars: number;
}): void {
  prisma.agentInvocation
    .create({
      data: {
        channel: row.channel,
        conversationId: row.conversationId,
        clientId: row.clientId,
        durationMs: row.durationMs,
        success: row.success,
        fallbackReason: row.fallbackReason,
        errorMessage: row.errorMessage,
        inputChars: row.inputChars,
        outputChars: row.outputChars,
      },
    })
    .catch((err: unknown) => {
      log.warn({ err }, 'Failed to record agent invocation (non-fatal)');
    });
}

function invokeOptions(
  context: ClaudeCallContext | undefined,
  model: string,
  purpose: ClaudeSpawnPurpose,
  extra?: Pick<ClaudeRuntimeInvokeOptions, 'onDelta' | 'signal' | 'armQuotaCircuit'>,
): ClaudeRuntimeInvokeOptions {
  return {
    timeoutMs: timeoutFor(context),
    model,
    context,
    purpose,
    signal: extra?.signal ?? context?.signal,
    onDelta: extra?.onDelta,
    armQuotaCircuit: extra?.armQuotaCircuit,
  };
}

/**
 * Send a request to Claude via the configured runtime (SDK default;
 * `CLAUDE_RUNTIME=cli` hotfix still uses `claude -p`).
 *
 * - Respects concurrency limits via the shared semaphore.
 * - Returns a fallback message on overload, timeout, or error (never throws).
 * - If `context` is provided, one row is recorded in `agent_invocations`.
 * - Tool follow-ups may pass `resumeSessionId`; on resume failure we retry once
 *   with a full cold prompt (unless the failure is a rate/session limit).
 */
export async function askClaude(
  req: ClaudeRequest,
  context?: ClaudeCallContext,
): Promise<ClaudeResponse> {
  const startMs = Date.now();
  const model = await resolveClaudeModel(context);
  const runtime = getClaudeRuntime();

  const logFallback = (
    response: ClaudeResponse,
    durationMs: number,
    inputChars: number,
  ) => {
    if (!response.fallback) return;
    log.warn(
      {
        event: 'agent_fallback',
        fallbackReason: response.fallback,
        fallbackText: response.text,
        errorDetail: response.errorDetail ?? null,
        channel: context?.channel ?? null,
        conversationId: context?.conversationId ?? null,
        clientId: context?.clientId ?? null,
        durationMs,
        historyLength: req.conversationHistory.length,
        inputChars,
        resumeSessionId: req.resumeSessionId ?? null,
        runtime: runtime.kind,
        userMessagePreview: req.userMessage.slice(0, 200),
      },
      'Agent fallback — user received canned manager-handoff reply',
    );
  };

  const record = (
    response: ClaudeResponse,
    inputChars: number,
    errorMessage: string | null = null,
  ) => {
    if (!context) return;
    recordInvocation({
      channel: context.channel,
      conversationId: context.conversationId,
      clientId: context.clientId,
      durationMs: Date.now() - startMs,
      success: !response.fallback,
      fallbackReason: response.fallback ?? null,
      errorMessage: errorMessage ?? response.errorDetail ?? null,
      inputChars,
      outputChars: response.text.length,
    });
  };

  const gate = semaphoreFor(context);

  await releaseExpiredClaudeQuotaIfNeeded();

  const askPurpose =
    context?.spawnPurpose ?? purposeFromAgentChannel(context?.channel ?? null);
  const askGate = evaluateClaudeSpawn(askPurpose, {
    softPercent: config.CLAUDE_QUOTA_SOFT_PERCENT,
  });
  if (!askGate.allowed && askGate.hardBlock) {
    const circuit = fallbackFor(
      'timeout',
      context,
      `quota_circuit_open: ${askGate.reason}`,
    );
    log.warn(
      { channel: context?.channel ?? null, reason: askGate.reason, runtime: runtime.kind },
      'Claude quota hard block — returning timeout fallback without spawn',
    );
    logFallback(circuit, Date.now() - startMs, 0);
    record(circuit, 0);
    return { ...circuit, resumed: false, inputChars: 0 };
  }

  if (gate.pending > MAX_PENDING) {
    log.warn(
      { pending: gate.pending, active: gate.active, channel: context?.channel ?? null },
      'Claude queue overloaded - returning fallback',
    );
    const busy = fallbackFor(
      'busy',
      context,
      `queue overloaded (pending=${gate.pending}, active=${gate.active})`,
    );
    logFallback(busy, Date.now() - startMs, 0);
    record(busy, 0);
    return { ...busy, resumed: false, inputChars: 0 };
  }

  let release: (() => void) | undefined;

  const invokeOnce = async (resumeSessionId: string | undefined) => {
    const response = await runtime.complete(
      { ...req, resumeSessionId },
      invokeOptions(context, model, askPurpose),
    );
    return finalizeClaudeResponse(response);
  };

  try {
    release = await gate.acquire();

    let response = await invokeOnce(req.resumeSessionId);
    let usedResume = Boolean(req.resumeSessionId) && !response.fallback;

    if (
      req.resumeSessionId &&
      response.fallback &&
      !isClaudeRateLimitSignal(response.errorDetail ?? response.text)
    ) {
      log.warn(
        {
          resumeSessionId: req.resumeSessionId,
          errorDetail: response.errorDetail ?? null,
          channel: context?.channel ?? null,
          runtime: runtime.kind,
        },
        'Claude --resume failed — retrying with full cold prompt',
      );
      response = await invokeOnce(undefined);
      usedResume = false;
    } else if (
      req.resumeSessionId &&
      response.fallback &&
      isClaudeRateLimitSignal(response.errorDetail ?? response.text)
    ) {
      log.warn(
        {
          resumeSessionId: req.resumeSessionId,
          errorDetail: response.errorDetail ?? null,
          channel: context?.channel ?? null,
        },
        'Claude --resume hit rate/session limit — skipping cold retry',
      );
    }

    const promptChars = response.inputChars ?? 0;
    const durationMs = Date.now() - startMs;
    log.info(
      {
        durationMs,
        inputChars: promptChars,
        outputChars: response.text.length,
        toolCalls: response.toolCalls?.length ?? 0,
        fallback: response.fallback ?? null,
        channel: context?.channel ?? null,
        timeoutMs: timeoutFor(context),
        model,
        sessionId: response.sessionId ?? null,
        resumed: usedResume,
        runtime: runtime.kind,
      },
      'Claude invocation complete',
    );

    logFallback(response, durationMs, promptChars);
    record(response, promptChars);
    return {
      ...response,
      resumed: usedResume,
      inputChars: promptChars,
    };
  } catch (err) {
    log.error({ err }, 'Unexpected error in askClaude');
    const message = err instanceof Error ? err.message : String(err);
    const fallback = fallbackFor('timeout', context, `askClaude unexpected error: ${message}`);
    logFallback(fallback, Date.now() - startMs, 0);
    record(fallback, 0, message);
    return { ...fallback, resumed: false, inputChars: 0 };
  } finally {
    release?.();
  }
}

export type ClaudeStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; response: ClaudeResponse }
  | { type: 'error'; response: ClaudeResponse };

/**
 * Like askClaude, but emits incremental text deltas from the runtime stream.
 * Used by meta-agent teach SSE. AbortSignal cancels the in-flight invocation.
 */
export async function askClaudeStream(
  req: ClaudeRequest,
  onEvent: (event: ClaudeStreamEvent) => void,
  context?: ClaudeCallContext,
  signal?: AbortSignal,
): Promise<ClaudeResponse> {
  const startMs = Date.now();
  const model = await resolveClaudeModel(context);
  const runtime = getClaudeRuntime();
  const gate = semaphoreFor(context);

  const emitDone = (response: ClaudeResponse) => {
    onEvent({ type: response.fallback ? 'error' : 'done', response });
  };

  await releaseExpiredClaudeQuotaIfNeeded();

  const streamPurpose =
    context?.spawnPurpose ?? purposeFromAgentChannel(context?.channel ?? null);
  const streamGate = evaluateClaudeSpawn(streamPurpose, {
    softPercent: config.CLAUDE_QUOTA_SOFT_PERCENT,
  });
  if (!streamGate.allowed && streamGate.hardBlock) {
    const circuit = fallbackFor(
      'timeout',
      context,
      `quota_circuit_open: ${streamGate.reason}`,
    );
    log.warn(
      { channel: context?.channel ?? null, reason: streamGate.reason, runtime: runtime.kind },
      'Claude quota hard block — stream fallback without spawn',
    );
    emitDone(circuit);
    return { ...circuit, resumed: false, inputChars: 0 };
  }

  if (gate.pending > MAX_PENDING) {
    const busy = fallbackFor(
      'busy',
      context,
      `queue overloaded (pending=${gate.pending}, active=${gate.active})`,
    );
    emitDone(busy);
    return { ...busy, resumed: false, inputChars: 0 };
  }

  const invokeOnce = async (resumeSessionId: string | undefined) => {
    const response = await runtime.stream(
      { ...req, resumeSessionId },
      invokeOptions(context, model, streamPurpose, {
        signal,
        onDelta: (text) => {
          if (text) onEvent({ type: 'delta', text });
        },
      }),
    );
    return finalizeClaudeResponse(response);
  };

  let release: (() => void) | undefined;
  try {
    release = await gate.acquire();
    if (signal?.aborted) {
      const aborted = fallbackFor('timeout', context, 'aborted by client');
      emitDone(aborted);
      return aborted;
    }

    let response = await invokeOnce(req.resumeSessionId);
    if (
      req.resumeSessionId &&
      response.fallback &&
      !signal?.aborted &&
      !isClaudeRateLimitSignal(response.errorDetail ?? response.text)
    ) {
      log.warn(
        {
          resumeSessionId: req.resumeSessionId,
          errorDetail: response.errorDetail ?? null,
          channel: context?.channel ?? null,
          runtime: runtime.kind,
        },
        'Claude stream --resume failed — retrying with full cold prompt',
      );
      response = await invokeOnce(undefined);
    } else if (
      req.resumeSessionId &&
      response.fallback &&
      isClaudeRateLimitSignal(response.errorDetail ?? response.text)
    ) {
      log.warn(
        {
          resumeSessionId: req.resumeSessionId,
          errorDetail: response.errorDetail ?? null,
          channel: context?.channel ?? null,
        },
        'Claude stream --resume hit rate/session limit — skipping cold retry',
      );
    }

    const promptChars = response.inputChars ?? 0;
    const durationMs = Date.now() - startMs;
    log.info(
      {
        durationMs,
        inputChars: promptChars,
        outputChars: response.text.length,
        fallback: response.fallback ?? null,
        channel: context?.channel ?? null,
        streamed: true,
        sessionId: response.sessionId ?? null,
        resumed: Boolean(req.resumeSessionId) && !response.fallback,
        runtime: runtime.kind,
      },
      'Claude stream invocation complete',
    );

    if (context) {
      recordInvocation({
        channel: context.channel,
        conversationId: context.conversationId,
        clientId: context.clientId,
        durationMs,
        success: !response.fallback,
        fallbackReason: response.fallback ?? null,
        errorMessage: response.errorDetail ?? null,
        inputChars: promptChars,
        outputChars: response.text.length,
      });
    }

    emitDone(response);
    return {
      ...response,
      resumed: Boolean(req.resumeSessionId) && !response.fallback,
      inputChars: promptChars,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fallback = fallbackFor('timeout', context, `askClaudeStream unexpected error: ${message}`);
    emitDone(fallback);
    return { ...fallback, resumed: false, inputChars: 0 };
  } finally {
    release?.();
  }
}

// ---------------------------------------------------------------------------
// Health check (always CLI binary — independent of CLAUDE_RUNTIME)
// ---------------------------------------------------------------------------

export interface ClaudeHealth {
  ok: boolean;
  path: string;
  version: string | null;
  error: string | null;
}

export async function claudeHealthCheck(timeoutMs = 5000): Promise<ClaudeHealth> {
  const path = getClaudeBinaryPath();
  try {
    const { stdout } = await execFileAsync(path, ['--version'], {
      timeout: timeoutMs,
      env: { ...process.env },
    });
    return { ok: true, path, version: stdout.trim(), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, path, version: null, error: message };
  }
}

export type { ClaudeAuthHealth } from '../lib/claude-auth-probe.js';
export {
  classifyClaudeLiveProbe,
  isClaudeAuthFailure,
  isClaudeRateLimitSignal,
} from '../lib/claude-auth-probe.js';

export async function claudeAuthCheck(timeoutMs = 8000): Promise<ClaudeAuthHealth> {
  const path = getClaudeBinaryPath();
  try {
    const { stdout, stderr } = await execFileAsync(path, ['auth', 'status'], {
      timeout: timeoutMs,
      env: { ...process.env },
      maxBuffer: 64 * 1024,
    });
    const combined = `${stdout}\n${stderr}`;
    if (isClaudeAuthFailure(combined)) {
      return {
        ok: false,
        error: 'Claude не авторизовано — на сервері виконайте: claude auth login',
      };
    }

    const trimmed = stdout.trim();
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed) as { loggedIn?: boolean };
        if (obj.loggedIn === false) {
          return {
            ok: false,
            error: 'Claude не авторизовано — на сервері виконайте: claude auth login',
          };
        }
        if (obj.loggedIn === true) {
          return { ok: true, error: null };
        }
      } catch {
        /* fall through to text heuristics */
      }
    }

    return { ok: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

let authLiveProbeInFlight: Promise<ClaudeAuthHealth> | null = null;

export async function verifyClaudeAuthLive(timeoutMs = 12000): Promise<ClaudeAuthHealth> {
  if (authLiveProbeInFlight) return authLiveProbeInFlight;

  await releaseExpiredClaudeQuotaIfNeeded();

  const gate = evaluateClaudeSpawn('auth_probe', {
    softPercent: config.CLAUDE_QUOTA_SOFT_PERCENT,
  });
  if (!gate.allowed) {
    log.info(
      { reason: gate.reason },
      'Claude auth live probe skipped — quota gate (credentials assumed OK from auth status)',
    );
    return { ok: true, error: null };
  }

  authLiveProbeInFlight = (async () => {
    const prompt = buildClaudePrompt({
      systemPrompt: AGENT_LATENCY_PROBE_SYSTEM,
      conversationHistory: [],
      userMessage: AGENT_LATENCY_PROBE_USER,
    });
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'];
    const response = await spawnClaude(prompt, args, {
      timeoutMs,
      purpose: 'auth_probe',
    });
    if (isClaudeRateLimitSignal(response.errorDetail ?? response.text)) {
      void recordClaudeRateLimit(response.errorDetail ?? response.text);
    }
    return classifyClaudeLiveProbe({
      text: response.text,
      errorDetail: response.errorDetail,
      fallback: response.fallback,
    });
  })();

  const pending = authLiveProbeInFlight;
  try {
    return await pending;
  } finally {
    if (authLiveProbeInFlight === pending) authLiveProbeInFlight = null;
  }
}

export interface AgentLatencyProbe {
  ok: boolean;
  latencyMs: number;
  error: string | null;
  fallback?: 'busy' | 'timeout';
}

const AGENT_LATENCY_PROBE_SYSTEM =
  'You are a health-check probe. Reply with exactly one word: OK. No punctuation.';
const AGENT_LATENCY_PROBE_USER = 'ping';

export async function probeAgentLatency(
  maxLatencyMs = config.CLAUDE_TIMEOUT_MS,
): Promise<AgentLatencyProbe> {
  const snap = await loadClaudeUsageSnapshot().catch(() => null);
  const blocked = isClaudeBackgroundSpawnBlocked(snap);
  if (blocked.blocked) {
    return {
      ok: false,
      latencyMs: 0,
      error: `Пропущено — ліміт Claude вичерпано (${blocked.reason})`,
      fallback: 'timeout',
    };
  }
  return runLatencyProbe({
    timeoutMs: maxLatencyMs,
    model: config.CLAUDE_MODEL,
    purpose: 'latency_probe',
  });
}

export async function warmUpClaudeRuntime(): Promise<AgentLatencyProbe> {
  const timeoutMs = config.CLAUDE_TIMEOUT_MS;
  const snap = await loadClaudeUsageSnapshot().catch(() => null);
  const blocked = isClaudeBackgroundSpawnBlocked(snap);
  if (blocked.blocked) {
    log.info(
      { reason: blocked.reason, timeoutMs },
      'Claude warmup skipped — quota circuit / exhausted usage',
    );
    return {
      ok: false,
      latencyMs: 0,
      error: `skipped: ${blocked.reason}`,
      fallback: 'timeout',
    };
  }
  const runtime = getClaudeRuntime();
  log.info({ timeoutMs, model: 'haiku', runtime: runtime.kind }, 'Claude warmup starting');
  const result = await runLatencyProbe({ timeoutMs, model: 'haiku', purpose: 'warmup' });
  if (result.ok) {
    log.info({ latencyMs: result.latencyMs, runtime: runtime.kind }, 'Claude warmup OK');
  } else {
    log.warn(
      { latencyMs: result.latencyMs, error: result.error, fallback: result.fallback ?? null, runtime: runtime.kind },
      'Claude warmup failed (API stays up; first DM may still be cold)',
    );
  }
  return result;
}

/** @deprecated Use warmUpClaudeRuntime — kept for server.ts / older imports. */
export const warmUpClaudeCli = warmUpClaudeRuntime;

async function runLatencyProbe(opts: {
  timeoutMs: number;
  model: string;
  purpose?: ClaudeSpawnPurpose;
}): Promise<AgentLatencyProbe> {
  const startMs = Date.now();
  const runtime = getClaudeRuntime();
  const purpose = opts.purpose ?? 'latency_probe';
  const response =
    purpose === 'warmup'
      ? await runtime.warmup({
          timeoutMs: opts.timeoutMs,
          model: opts.model,
          purpose: 'warmup',
          armQuotaCircuit: false,
        })
      : await runtime.complete(CLAUDE_WARMUP_REQUEST, {
          timeoutMs: opts.timeoutMs,
          model: opts.model,
          purpose,
        });
  const latencyMs = Date.now() - startMs;

  if (response.fallback) {
    return {
      ok: false,
      latencyMs,
      error:
        response.fallback === 'busy'
          ? 'Агент перевантажений (черга запитів)'
          : (response.errorDetail ?? 'Агент не відповів у відведений час'),
      fallback: response.fallback,
    };
  }

  if (!response.text.trim()) {
    return {
      ok: false,
      latencyMs,
      error: 'Агент повернув порожню відповідь',
    };
  }

  if (latencyMs > opts.timeoutMs) {
    return {
      ok: false,
      latencyMs,
      error: `Відповідь зайняла ${latencyMs} мс (ліміт ${opts.timeoutMs} мс)`,
    };
  }

  return { ok: true, latencyMs, error: null };
}
