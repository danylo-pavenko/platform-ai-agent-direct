import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import pino from 'pino';
import { config } from '../config.js';
import { formatAgentToolsPrompt } from '../lib/agent-tools-prompt.js';
import { buildClaudeVisionStdin } from '../lib/claude-vision.js';
import { parseToolCallsFromText, stripToolCallBlocks } from '../lib/parse-tool-calls.js';
import { sanitizeCustomerFacingReply } from '../lib/assistant-output.js';
import { isUnusableClaudeResultText } from '../lib/claude-result-usable.js';
import { parseClaudeStreamJson } from '../lib/claude-stream-parse.js';
import {
  classifyClaudeLiveProbe,
  isClaudeAuthFailure,
  isClaudeRateLimitSignal,
  type ClaudeAuthHealth,
} from '../lib/claude-auth-probe.js';
import {
  evaluateClaudeSpawn,
  isClaudeBackgroundSpawnBlocked,
  isClaudeQuotaCircuitOpen,
  noteClaudeRateLimit,
  purposeFromAgentChannel,
  type ClaudeSpawnPurpose,
} from '../lib/claude-quota-gate.js';
import { getClaudeBinaryPath } from '../lib/claude-binary.js';
import { resolveClaudeSpawnCwd } from '../lib/claude-spawn-cwd.js';
import { Semaphore } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import {
  CUSTOMER_FALLBACK_BUSY,
  CUSTOMER_FALLBACK_TIMEOUT,
} from '../lib/agent-fallback.js';
import { getAgentConfig, normalizeClaudeModel, type ClaudeModelId } from '../lib/agent-config.js';
import type { AgentChannel } from '../generated/prisma/enums.js';
import { loadClaudeUsageSnapshot } from './claude-usage-monitor.js';
import { recordClaudeRateLimit, releaseExpiredClaudeQuotaIfNeeded } from './claude-quota.js';

export { getClaudeBinaryPath, resolveClaudeSpawnCwd };

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeRequest {
  systemPrompt: string;
  conversationHistory: { role: 'user' | 'assistant'; content: string }[];
  userMessage: string;
  images?: string[];
  tools?: ToolDefinition[];
  /**
   * When set, spawn with `claude -p --resume <id>` and send only the new
   * user message (tool result). Session already holds system + prior turns.
   */
  resumeSessionId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ClaudeResponse {
  text: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  /**
   * Set when we returned a canned fallback instead of a real model reply.
   * `busy` = semaphore queue overloaded. `timeout` = spawn error, process
   * timeout, or non-zero exit code. Absent when the response is genuine.
   */
  fallback?: 'busy' | 'timeout';
  /**
   * Human-readable detail about why the fallback was produced (e.g. "spawn
   * failed: ENOENT", "timed out after 60000ms", "exit 1: <stderr>"). Internal
   * field used for logging — callers should not surface this to end users.
   */
  errorDetail?: string;
  /** Claude Code session id from stream-json — pass as `resumeSessionId` on the next round. */
  sessionId?: string;
  /** True when this invocation used `--resume` with a slim prompt (no cold retry). */
  resumed?: boolean;
  /** Approx stdin size for this spawn (chars). */
  inputChars?: number;
}

export interface ClaudeCallContext {
  channel: AgentChannel;
  conversationId?: string;
  clientId?: string;
  /** Per-call override (e.g. voice turns after STT). */
  timeoutMs?: number;
  /** Claude Code CLI `--model` (haiku router / sonnet|opus reply). Falls back to agent_config. */
  model?: string;
  /** Override quota-gate purpose (e.g. follow_up vs customer_dm). */
  spawnPurpose?: ClaudeSpawnPurpose;
}

// ---------------------------------------------------------------------------
// Constants / singleton state
// ---------------------------------------------------------------------------

const log = pino({ name: 'claude' });

const semaphore = new Semaphore(config.CLAUDE_MAX_CONCURRENCY);
/** Dedicated pool for meta-agent so teach turns do not queue behind IG/TG. */
const metaSemaphore = new Semaphore(config.CLAUDE_META_MAX_CONCURRENCY);

function semaphoreFor(context?: ClaudeCallContext): Semaphore {
  return context?.channel === 'meta_agent' ? metaSemaphore : semaphore;
}

// Admin channels talk to a human operator inside the admin UI, not to a
// customer in IG/TG. A "менеджер відпише" reply there is misleading — the
// admin *is* the manager. We keep the customer-friendly fallback for IG/TG
// and show a technical error in admin channels instead.
const ADMIN_CHANNELS = new Set<AgentChannel>([
  'meta_agent',
  'sandbox',
  'supervisor',
  'insights',
]);

const ADMIN_FALLBACK_BUSY =
  'Агент зараз перевантажений (забагато одночасних запитів). Спробуйте за хвилину.';
const ADMIN_FALLBACK_TIMEOUT =
  'Агент не встиг відповісти за відведений час. Спробуйте скоротити запит або повторити ще раз.';

function fallbackFor(
  reason: 'busy' | 'timeout',
  context?: ClaudeCallContext,
  errorDetail?: string,
): ClaudeResponse {
  const isAdmin = context ? ADMIN_CHANNELS.has(context.channel) : false;
  const text =
    reason === 'busy'
      ? isAdmin
        ? ADMIN_FALLBACK_BUSY
        : CUSTOMER_FALLBACK_BUSY
      : isAdmin
        ? ADMIN_FALLBACK_TIMEOUT
        : CUSTOMER_FALLBACK_TIMEOUT;
  return { text, fallback: reason, ...(errorDetail ? { errorDetail } : {}) };
}

function timeoutFor(context?: ClaudeCallContext): number {
  if (context?.timeoutMs != null) {
    return context.timeoutMs;
  }
  if (context && ADMIN_CHANNELS.has(context.channel)) {
    return config.CLAUDE_ADMIN_TIMEOUT_MS;
  }
  return config.CLAUDE_TIMEOUT_MS;
}

const MAX_PENDING = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the plain-text prompt that is piped to Claude's stdin. */
function buildPrompt(req: ClaudeRequest, opts?: { resume?: boolean }): string {
  // Resume rounds: session transcript already has system + history + tools.
  // Re-sending them doubles tokens and can confuse the model.
  if (opts?.resume) {
    return `Human: ${req.userMessage}`;
  }

  const parts: string[] = [];

  parts.push(`<system>\n${req.systemPrompt}\n</system>`);

  for (const msg of req.conversationHistory) {
    const prefix = msg.role === 'user' ? 'Human' : 'Assistant';
    parts.push(`${prefix}: ${msg.content}`);
  }

  parts.push(`Human: ${req.userMessage}`);

  if (req.tools && req.tools.length > 0) {
    parts.push(formatAgentToolsPrompt(req.tools));
  }

  return parts.join('\n\n');
}

export interface BuildClaudeCliArgsOptions {
  useStreamJsonInput?: boolean;
  model?: string;
  resumeSessionId?: string;
}

/** Build the CLI argument list (prompt / images go via stdin). */
function buildArgs(opts: BuildClaudeCliArgsOptions = {}): string[] {
  const model = normalizeClaudeModel(opts.model ?? config.CLAUDE_MODEL);
  const args: string[] = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
  ];

  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }

  // Claude Code has no `--image` flag. Vision uses Anthropic image content
  // blocks on stdin with `--input-format stream-json`.
  if (opts.useStreamJsonInput) {
    args.push('--input-format', 'stream-json');
  }

  return args;
}

/** Exported for unit tests. */
export function buildClaudeCliArgsForTest(
  useStreamJsonInput = false,
  model?: string,
  resumeSessionId?: string,
): string[] {
  return buildArgs({
    useStreamJsonInput,
    model: model ?? config.CLAUDE_MODEL,
    resumeSessionId,
  });
}

/** Exported for unit tests. */
export function buildClaudePromptForTest(
  req: ClaudeRequest,
  opts?: { resume?: boolean },
): string {
  return buildPrompt(req, opts);
}

async function resolveClaudeModel(context?: ClaudeCallContext): Promise<ClaudeModelId> {
  if (context?.model) return normalizeClaudeModel(context.model);
  const cfg = await getAgentConfig();
  return cfg.claudeModel;
}

/** Merge native stream-json tool_use blocks with `<tool_call>` text protocol. */
function finalizeResponse(response: ClaudeResponse): ClaudeResponse {
  const fromText = parseToolCallsFromText(response.text);
  const strippedTools = stripToolCallBlocks(response.text);
  const text = sanitizeCustomerFacingReply(strippedTools);
  if (text !== strippedTools.trim()) {
    log.info(
      {
        beforeChars: strippedTools.length,
        afterChars: text.length,
      },
      'Sanitized customer-facing Claude reply (artifacts / meta-reasoning)',
    );
  }
  const merged = [...(response.toolCalls ?? []), ...fromText];

  return {
    ...response,
    text,
    ...(merged.length > 0 ? { toolCalls: merged } : {}),
  };
}

/**
 * Parse Claude Code stream-json stdout. See `parseClaudeStreamJson` —
 * never returns raw NDJSON on rate-limit / API error envelopes.
 */
function parseResponse(raw: string): ClaudeResponse {
  const parsed = parseClaudeStreamJson(raw);
  return {
    text: parsed.text,
    ...(parsed.toolCalls?.length ? { toolCalls: parsed.toolCalls } : {}),
    ...(parsed.errorDetail ? { errorDetail: parsed.errorDetail } : {}),
    ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
  };
}

export type ClaudeStreamDeltaHandler = (delta: string) => void;

interface SpawnClaudeOptions {
  timeoutMs: number;
  context?: ClaudeCallContext;
  /** Fired when assistant text grows (incremental stream-json). */
  onDelta?: ClaudeStreamDeltaHandler;
  /** Abort in-flight CLI (e.g. client disconnected). */
  signal?: AbortSignal;
  /** Quota-gate purpose — defaults from context.channel. */
  purpose?: ClaudeSpawnPurpose;
}

function extractAssistantTextFromStreamLine(line: string): string | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type === 'assistant') {
      // Skip synthetic rate-limit / API error stubs (nested or flat).
      if (
        obj.is_api_error_message === true ||
        obj.error === 'rate_limit' ||
        obj.error === 'authentication_failed'
      ) {
        return null;
      }
      const blocks = Array.isArray(obj.content)
        ? (obj.content as Array<Record<string, unknown>>)
        : obj.message &&
            typeof obj.message === 'object' &&
            Array.isArray((obj.message as Record<string, unknown>).content)
          ? ((obj.message as Record<string, unknown>).content as Array<Record<string, unknown>>)
          : null;
      if (!blocks) return null;
      const parts: string[] = [];
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
      const joined = parts.join('\n');
      if (!joined || isUnusableClaudeResultText(joined)) return null;
      return joined;
    }
    if (obj.type === 'content_block_delta' && obj.delta && typeof obj.delta === 'object') {
      const delta = obj.delta as Record<string, unknown>;
      if (typeof delta.text === 'string') return delta.text;
    }
    if (obj.type === 'result' && typeof obj.result === 'string') {
      if (obj.is_error === true || isUnusableClaudeResultText(obj.result)) return null;
      return obj.result;
    }
  } catch {
    /* ignore partial JSON */
  }
  return null;
}

/** Spawn the Claude CLI and return a promise with collected output. */
function spawnClaude(
  prompt: string,
  args: string[],
  timeoutMsOrOpts: number | SpawnClaudeOptions,
  context?: ClaudeCallContext,
): Promise<ClaudeResponse> {
  const opts: SpawnClaudeOptions =
    typeof timeoutMsOrOpts === 'number'
      ? { timeoutMs: timeoutMsOrOpts, context }
      : timeoutMsOrOpts;
  const timeoutMs = opts.timeoutMs;
  const callContext = opts.context ?? context;
  const purpose =
    opts.purpose ??
    callContext?.spawnPurpose ??
    purposeFromAgentChannel(callContext?.channel ?? null);

  const gate = evaluateClaudeSpawn(purpose, {
    softPercent: config.CLAUDE_QUOTA_SOFT_PERCENT,
  });
  if (!gate.allowed) {
    log.warn(
      { purpose, reason: gate.reason, channel: callContext?.channel ?? null },
      'Claude spawn blocked by quota gate',
    );
    // Do not recordClaudeRateLimit(gate.reason) — hard_block_/soft_budget are not 429 events.
    return Promise.resolve(
      fallbackFor('timeout', callContext, `quota_gate: ${gate.reason}`),
    );
  }

  return new Promise<ClaudeResponse>((resolve) => {
    let child: ChildProcess;

    try {
      const cwd = resolveClaudeSpawnCwd();
      log.info(
        {
          cwd,
          channel: callContext?.channel ?? null,
          purpose,
          argsPreview: args.filter((a) => a !== '-p').slice(0, 8),
        },
        'Spawning Claude CLI',
      );
      child = spawn(getClaudeBinaryPath(), args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        cwd,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'Failed to spawn claude CLI');
      resolve(fallbackFor('timeout', callContext, `spawn failed: ${message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let lineBuf = '';
    let emittedText = '';

    const settle = (response: ClaudeResponse) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    const onAbort = () => {
      if (settled) return;
      log.info({ channel: callContext?.channel ?? null }, 'Claude CLI aborted by signal');
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      settle(fallbackFor('timeout', callContext, 'aborted by client'));
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Timeout handling
    const timer = setTimeout(() => {
      if (!settled) {
        log.warn({ timeoutMs, channel: callContext?.channel ?? null }, 'Claude CLI timed out - killing process');
        child.kill('SIGKILL');
        settle(fallbackFor('timeout', callContext, `timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const handleStreamLine = (line: string) => {
      if (!opts.onDelta || !line.trim()) return;
      const text = extractAssistantTextFromStreamLine(line);
      if (text == null) return;

      // content_block_delta: append; assistant/result: treat as cumulative snapshot
      let nextFull = text;
      if (line.includes('"content_block_delta"')) {
        nextFull = emittedText + text;
      } else if (text.startsWith(emittedText)) {
        nextFull = text;
      } else if (emittedText && text.length > emittedText.length) {
        nextFull = text;
      } else if (!emittedText) {
        nextFull = text;
      } else {
        // Non-monotonic — emit as fresh append only if clearly new
        if (text.length > 0 && !emittedText.includes(text)) {
          nextFull = emittedText + text;
        } else {
          return;
        }
      }

      if (nextFull.length > emittedText.length) {
        const delta = nextFull.slice(emittedText.length);
        emittedText = nextFull;
        opts.onDelta(delta);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      const str = chunk.toString();
      stdout += str;
      if (!opts.onDelta) return;
      lineBuf += str;
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        handleStreamLine(line);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'Claude CLI process error');
      settle(fallbackFor('timeout', callContext, `process error: ${message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);

      if (lineBuf.trim() && opts.onDelta) {
        handleStreamLine(lineBuf);
        lineBuf = '';
      }

      if (settled) return;

      const parsed = finalizeResponse(parseResponse(stdout));
      const usable =
        (parsed.text.trim().length > 0 && !isUnusableClaudeResultText(parsed.text)) ||
        (parsed.toolCalls?.length ?? 0) > 0;

      // Claude Code may exit 0 with subtype=success even on 429 rate limits.
      // Never settle empty / unusable / raw stream dumps as a customer reply.
      if (!usable) {
        const stderrPreview = stderr.slice(0, 500);
        const detail =
          parsed.errorDetail ??
          `unusable reply (exit ${code})${stderrPreview ? `: ${stderrPreview}` : ''}`;
        if (isClaudeRateLimitSignal(detail) || isClaudeRateLimitSignal(stdout)) {
          noteClaudeRateLimit(parsed.errorDetail ?? detail);
          void recordClaudeRateLimit(parsed.errorDetail ?? detail);
        }
        log.error(
          {
            code,
            stderr: stderrPreview,
            cwd: resolveClaudeSpawnCwd(),
            channel: callContext?.channel ?? null,
            stdoutChars: stdout.length,
            errorDetail: parsed.errorDetail ?? null,
          },
          code !== 0
            ? 'Claude CLI exited with non-zero code'
            : 'Claude CLI returned unusable stdout (rate limit / auth / empty)',
        );
        settle(fallbackFor('timeout', callContext, detail));
        return;
      }

      if (code !== 0 && usable) {
        log.warn(
          {
            code,
            channel: callContext?.channel ?? null,
            stdoutChars: stdout.length,
            textChars: parsed.text.length,
            toolCalls: parsed.toolCalls?.length ?? 0,
          },
          'Claude CLI non-zero exit but usable reply — accepting',
        );
      }

      settle(parsed);
    });

    // Write prompt to stdin and close
    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget: persist one analytics row per invocation. Any failure is
 * swallowed — analytics must never block or crash the bot response path.
 */
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

/**
 * Send a request to Claude via the headless CLI.
 *
 * - Respects concurrency limits via the shared semaphore.
 * - Returns a fallback message on overload, timeout, or error (never throws).
 * - If `context` is provided, one row is recorded in `agent_invocations`
 *   with measured latency and success/fallback state (fire-and-forget).
 * - Tool follow-ups may pass `resumeSessionId` to reuse the Claude Code
 *   session (`--resume`) with a slim prompt; on resume failure we retry once
 *   with a full cold prompt.
 */
export async function askClaude(
  req: ClaudeRequest,
  context?: ClaudeCallContext,
): Promise<ClaudeResponse> {
  const startMs = Date.now();
  const model = await resolveClaudeModel(context);

  /**
   * Emit a dedicated warn-level log whenever the user actually receives a
   * canned "менеджер відпише" reply instead of a real model answer. Separate
   * from the site-specific error logs in spawnClaude so ops can grep a single
   * `event=agent_fallback` across all failure modes.
   */
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

  // Drop stale session_exhausted:100 after Anthropic reset window elapsed.
  await releaseExpiredClaudeQuotaIfNeeded();

  // Circuit breaker: after live 429 / session limit, skip CLI until window resets.
  const askPurpose =
    context?.spawnPurpose ?? purposeFromAgentChannel(context?.channel ?? null);
  const askGate = evaluateClaudeSpawn(askPurpose, {
    softPercent: config.CLAUDE_QUOTA_SOFT_PERCENT,
  });
  // Soft budget still allows customer_dm / admin; hard block denies all.
  if (!askGate.allowed && askGate.hardBlock) {
    const circuit = fallbackFor(
      'timeout',
      context,
      `quota_circuit_open: ${askGate.reason}`,
    );
    log.warn(
      { channel: context?.channel ?? null, reason: askGate.reason },
      'Claude quota hard block — returning timeout fallback without spawn',
    );
    logFallback(circuit, Date.now() - startMs, 0);
    record(circuit, 0);
    return { ...circuit, resumed: false, inputChars: 0 };
  }

  // Back-pressure: reject early if too many requests are already queued
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

  const spawnOnce = async (resumeSessionId: string | undefined) => {
    const resume = Boolean(resumeSessionId);
    const prompt = buildPrompt(req, { resume });
    // Vision only on cold starts — resume rounds are tool-result text.
    const images = resume ? undefined : req.images;
    const vision = await buildClaudeVisionStdin(prompt, images);
    const args = buildArgs({
      useStreamJsonInput: vision.useStreamJsonInput,
      model,
      resumeSessionId,
    });

    if (images && images.length > 0) {
      log.info(
        {
          requested: images.length,
          attached: vision.attachedImages.length,
          skipped: vision.skippedPaths.length,
          streamJsonInput: vision.useStreamJsonInput,
          channel: context?.channel ?? null,
        },
        'Claude vision stdin prepared',
      );
    }

    if (resume) {
      log.info(
        {
          resumeSessionId,
          inputChars: prompt.length,
          channel: context?.channel ?? null,
        },
        'Claude CLI --resume follow-up (slim prompt)',
      );
    }

    const response = await spawnClaude(vision.stdin, args, {
      timeoutMs: timeoutFor(context),
      context,
      purpose: askPurpose,
    });
    return { response, promptChars: prompt.length, visionAttached: vision.attachedImages.length };
  };

  try {
    release = await gate.acquire();

    let { response, promptChars, visionAttached } = await spawnOnce(req.resumeSessionId);
    let usedResume = Boolean(req.resumeSessionId) && !response.fallback;

    // Cold retry after --resume helps for dead sessions — but NOT for 429/quota.
    // A second Opus/Sonnet spawn only burns more of the same exhausted window.
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
        },
        'Claude --resume failed — retrying with full cold prompt',
      );
      ({ response, promptChars, visionAttached } = await spawnOnce(undefined));
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
        visionAttached,
        model,
        sessionId: response.sessionId ?? null,
        resumed: usedResume,
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
 * Like askClaude, but emits incremental text deltas from CLI stream-json.
 * Used by meta-agent teach SSE. AbortSignal kills the child process.
 */
export async function askClaudeStream(
  req: ClaudeRequest,
  onEvent: (event: ClaudeStreamEvent) => void,
  context?: ClaudeCallContext,
  signal?: AbortSignal,
): Promise<ClaudeResponse> {
  const startMs = Date.now();
  const model = await resolveClaudeModel(context);
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
      { channel: context?.channel ?? null, reason: streamGate.reason },
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

  const spawnOnce = async (resumeSessionId: string | undefined) => {
    const resume = Boolean(resumeSessionId);
    const prompt = buildPrompt(req, { resume });
    const images = resume ? undefined : req.images;
    const vision = await buildClaudeVisionStdin(prompt, images);
    const args = buildArgs({
      useStreamJsonInput: vision.useStreamJsonInput,
      model,
      resumeSessionId,
    });
    const response = await spawnClaude(vision.stdin, args, {
      timeoutMs: timeoutFor(context),
      context,
      purpose: streamPurpose,
      signal,
      onDelta: (text) => {
        if (text) onEvent({ type: 'delta', text });
      },
    });
    return { response, promptChars: prompt.length };
  };

  let release: (() => void) | undefined;
  try {
    release = await gate.acquire();
    if (signal?.aborted) {
      const aborted = fallbackFor('timeout', context, 'aborted by client');
      emitDone(aborted);
      return aborted;
    }

    let { response, promptChars } = await spawnOnce(req.resumeSessionId);
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
        },
        'Claude stream --resume failed — retrying with full cold prompt',
      );
      ({ response, promptChars } = await spawnOnce(undefined));
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
// Health check
// ---------------------------------------------------------------------------

export interface ClaudeHealth {
  ok: boolean;
  path: string;
  version: string | null;
  error: string | null;
}

/**
 * Verify the Claude CLI is reachable and responds to `--version`.
 * Used by the supervisor `/claude-health` endpoint so super-admin can see
 * whether the tenant's Claude auth + binary are actually usable, rather
 * than relying on the silent fallback in spawnClaude.
 */
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

/**
 * Verify Claude CLI session is authenticated (`claude auth status`).
 * Checks JSON `loggedIn` when present; does not validate live API tokens.
 */
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

/**
 * Live API probe — `auth status` can report loggedIn while tokens return 401.
 * Uses a minimal haiku ping (same path as runtime askClaude).
 *
 * Rate-limit (429) means credentials are valid — do not treat as session expired.
 * Concurrent polls (login wizard) share one in-flight probe.
 */
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
    // Rate-limit / soft budget: OAuth is fine; do not burn another haiku ping.
    return { ok: true, error: null };
  }

  authLiveProbeInFlight = (async () => {
    const prompt = buildPrompt({
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

/**
 * Minimal Claude invocation to measure real end-to-end agent latency.
 * Uses the customer-facing timeout (CLAUDE_TIMEOUT_MS, default 120s).
 */
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

/**
 * One light CLI spawn after PM2/API start (haiku + ping).
 * Does not go through the customer semaphore — fire-and-forget from server.ts.
 * Warmup failure must never block the API; it only logs.
 */
export async function warmUpClaudeCli(): Promise<AgentLatencyProbe> {
  const timeoutMs = config.CLAUDE_TIMEOUT_MS;
  const snap = await loadClaudeUsageSnapshot().catch(() => null);
  const blocked = isClaudeBackgroundSpawnBlocked(snap);
  if (blocked.blocked) {
    log.info(
      { reason: blocked.reason, timeoutMs },
      'Claude CLI warmup skipped — quota circuit / exhausted usage',
    );
    return {
      ok: false,
      latencyMs: 0,
      error: `skipped: ${blocked.reason}`,
      fallback: 'timeout',
    };
  }
  log.info({ timeoutMs, model: 'haiku' }, 'Claude CLI warmup starting');
  const result = await runLatencyProbe({ timeoutMs, model: 'haiku', purpose: 'warmup' });
  if (result.ok) {
    log.info({ latencyMs: result.latencyMs }, 'Claude CLI warmup OK');
  } else {
    if (result.error && isClaudeRateLimitSignal(result.error)) {
      noteClaudeRateLimit(result.error);
      void recordClaudeRateLimit(result.error);
    }
    log.warn(
      { latencyMs: result.latencyMs, error: result.error, fallback: result.fallback ?? null },
      'Claude CLI warmup failed (API stays up; first DM may still be cold)',
    );
  }
  return result;
}

async function runLatencyProbe(opts: {
  timeoutMs: number;
  model: string;
  purpose?: ClaudeSpawnPurpose;
}): Promise<AgentLatencyProbe> {
  const startMs = Date.now();
  const prompt = buildPrompt({
    systemPrompt: AGENT_LATENCY_PROBE_SYSTEM,
    conversationHistory: [],
    userMessage: AGENT_LATENCY_PROBE_USER,
  });
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', opts.model,
  ];

  const response = await spawnClaude(prompt, args, {
    timeoutMs: opts.timeoutMs,
    purpose: opts.purpose ?? 'latency_probe',
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
