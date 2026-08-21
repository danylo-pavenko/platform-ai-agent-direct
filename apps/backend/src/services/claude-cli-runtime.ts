/**
 * Headless Claude Code CLI runtime (`claude -p --output-format stream-json`).
 * Used by `CLAUDE_RUNTIME=cli` (hotfix rollback) and by auth probes regardless
 * of the customer-path runtime flag. Default customer replies use Agent SDK.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import pino from 'pino';
import { config } from '../config.js';
import { formatAgentToolsPrompt } from '../lib/agent-tools-prompt.js';
import { buildClaudeVisionStdin } from '../lib/claude-vision.js';
import { isUnusableClaudeResultText } from '../lib/claude-result-usable.js';
import { parseClaudeStreamJson } from '../lib/claude-stream-parse.js';
import { isClaudeRateLimitSignal } from '../lib/claude-auth-probe.js';
import {
  evaluateClaudeSpawn,
  noteClaudeRateLimit,
  purposeFromAgentChannel,
  shouldArmClaudeQuotaCircuit,
  type ClaudeSpawnPurpose,
} from '../lib/claude-quota-gate.js';
import { getClaudeBinaryPath } from '../lib/claude-binary.js';
import { resolveClaudeSpawnCwd } from '../lib/claude-spawn-cwd.js';
import { normalizeClaudeModel } from '../lib/agent-config.js';
import {
  claudeCliSpawnOptions,
  killClaudeProcessGroup,
  scheduleClaudePidAliveLog,
} from '../lib/claude-process-kill.js';
import {
  CLAUDE_WARMUP_REQUEST,
  claudeFallbackResponse,
  type ClaudeCallContext,
  type ClaudeRequest,
  type ClaudeResponse,
  type ClaudeRuntime,
  type ClaudeRuntimeInvokeOptions,
  type ClaudeStreamDeltaHandler,
} from '../lib/claude-runtime.js';
import { finalizeClaudeResponse } from '../lib/claude-finalize-response.js';
import { recordClaudeRateLimit } from './claude-quota.js';

const log = pino({ name: 'claude-cli-runtime' });

export interface BuildClaudeCliArgsOptions {
  useStreamJsonInput?: boolean;
  model?: string;
  resumeSessionId?: string;
}

/** Build the plain-text prompt that is piped to Claude's stdin. */
export function buildClaudePrompt(
  req: ClaudeRequest,
  opts?: { resume?: boolean; embedSystem?: boolean; nativeLookupTools?: boolean; nativeAllTools?: boolean },
): string {
  if (opts?.resume) {
    return `Human: ${req.userMessage}`;
  }

  const parts: string[] = [];
  if (opts?.embedSystem !== false) {
    parts.push(`<system>\n${req.systemPrompt}\n</system>`);
  }

  for (const msg of req.conversationHistory) {
    const prefix = msg.role === 'user' ? 'Human' : 'Assistant';
    parts.push(`${prefix}: ${msg.content}`);
  }

  parts.push(`Human: ${req.userMessage}`);

  if (req.tools && req.tools.length > 0) {
    const toolsForPrompt =
      opts?.nativeLookupTools || opts?.nativeAllTools
        ? req.tools.filter(
            (t) =>
              t.name !== 'get_client_crm_history' ||
              Boolean(req.lookupContext?.crmHistoryAllowed && req.lookupContext.clientId),
          )
        : req.tools;
    parts.push(
      formatAgentToolsPrompt(toolsForPrompt, {
        nativeLookup: opts?.nativeLookupTools,
        nativeAll: opts?.nativeAllTools,
      }),
    );
  }

  return parts.join('\n\n');
}

/** Build the CLI argument list (prompt / images go via stdin). */
export function buildClaudeCliArgs(opts: BuildClaudeCliArgsOptions = {}): string[] {
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

  if (opts.useStreamJsonInput) {
    args.push('--input-format', 'stream-json');
  }

  return args;
}

/** Exported for unit tests (stable names used by existing test files). */
export function buildClaudeCliArgsForTest(
  useStreamJsonInput = false,
  model?: string,
  resumeSessionId?: string,
): string[] {
  return buildClaudeCliArgs({
    useStreamJsonInput,
    model: model ?? config.CLAUDE_MODEL,
    resumeSessionId,
  });
}

export function buildClaudePromptForTest(
  req: ClaudeRequest,
  opts?: { resume?: boolean; embedSystem?: boolean },
): string {
  return buildClaudePrompt(req, opts);
}

function parseResponse(raw: string): ClaudeResponse {
  const parsed = parseClaudeStreamJson(raw);
  return {
    text: parsed.text,
    ...(parsed.toolCalls?.length ? { toolCalls: parsed.toolCalls } : {}),
    ...(parsed.errorDetail ? { errorDetail: parsed.errorDetail } : {}),
    ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
  };
}

interface SpawnClaudeOptions {
  timeoutMs: number;
  context?: ClaudeCallContext;
  onDelta?: ClaudeStreamDeltaHandler;
  signal?: AbortSignal;
  purpose?: ClaudeSpawnPurpose;
  armQuotaCircuit?: boolean;
}

function reapClaudeChild(child: ChildProcess, reason: string): void {
  const pid = child.pid;
  killClaudeProcessGroup(pid, {
    childKill: () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    },
  });
  if (pid && pid > 0) {
    scheduleClaudePidAliveLog(pid, {
      reason,
      logWarn: (payload, msg) => log.warn(payload, msg),
    });
  }
}

function extractAssistantTextFromStreamLine(line: string): string | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type === 'assistant') {
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
export function spawnClaude(
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
    return Promise.resolve(
      claudeFallbackResponse('timeout', callContext, `quota_gate: ${gate.reason}`),
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
      child = spawn(getClaudeBinaryPath(), args, claudeCliSpawnOptions(cwd));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'Failed to spawn claude CLI');
      resolve(claudeFallbackResponse('timeout', callContext, `spawn failed: ${message}`));
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
      reapClaudeChild(child, 'abort');
      settle(claudeFallbackResponse('timeout', callContext, 'aborted by client'));
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      if (!settled) {
        log.warn({ timeoutMs, channel: callContext?.channel ?? null }, 'Claude CLI timed out - killing process');
        reapClaudeChild(child, 'timeout');
        settle(claudeFallbackResponse('timeout', callContext, `timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const handleStreamLine = (line: string) => {
      if (!opts.onDelta || !line.trim()) return;
      const text = extractAssistantTextFromStreamLine(line);
      if (text == null) return;

      let nextFull = text;
      if (line.includes('"content_block_delta"')) {
        nextFull = emittedText + text;
      } else if (text.startsWith(emittedText)) {
        nextFull = text;
      } else if (emittedText && text.length > emittedText.length) {
        nextFull = text;
      } else if (!emittedText) {
        nextFull = text;
      } else if (text.length > 0 && !emittedText.includes(text)) {
        nextFull = emittedText + text;
      } else {
        return;
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
      settle(claudeFallbackResponse('timeout', callContext, `process error: ${message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);

      if (lineBuf.trim() && opts.onDelta) {
        handleStreamLine(lineBuf);
        lineBuf = '';
      }

      if (settled) return;

      const parsed = finalizeClaudeResponse(parseResponse(stdout));
      const usable =
        (parsed.text.trim().length > 0 && !isUnusableClaudeResultText(parsed.text)) ||
        (parsed.toolCalls?.length ?? 0) > 0;

      if (!usable) {
        const stderrPreview = stderr.slice(0, 500);
        const detail =
          parsed.errorDetail ??
          `unusable reply (exit ${code})${stderrPreview ? `: ${stderrPreview}` : ''}`;
        if (
          shouldArmClaudeQuotaCircuit(purpose, opts.armQuotaCircuit) &&
          (isClaudeRateLimitSignal(detail) || isClaudeRateLimitSignal(stdout))
        ) {
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
        settle(claudeFallbackResponse('timeout', callContext, detail));
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

    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

export function createCliClaudeRuntime(): ClaudeRuntime {
  const run = async (
    req: ClaudeRequest,
    opts: ClaudeRuntimeInvokeOptions,
  ): Promise<ClaudeResponse> => {
    const resume = Boolean(req.resumeSessionId);
    const prompt = buildClaudePrompt(req, { resume });
    const images = resume ? undefined : req.images;
    const vision = await buildClaudeVisionStdin(prompt, images);
    const args = buildClaudeCliArgs({
      useStreamJsonInput: vision.useStreamJsonInput,
      model: opts.model,
      resumeSessionId: req.resumeSessionId,
    });

    if (images && images.length > 0) {
      log.info(
        {
          requested: images.length,
          attached: vision.attachedImages.length,
          skipped: vision.skippedPaths.length,
          streamJsonInput: vision.useStreamJsonInput,
          channel: opts.context?.channel ?? null,
        },
        'Claude vision stdin prepared',
      );
    }

    if (resume) {
      log.info(
        {
          resumeSessionId: req.resumeSessionId,
          inputChars: prompt.length,
          channel: opts.context?.channel ?? null,
        },
        'Claude CLI --resume follow-up (slim prompt)',
      );
    }

    const response = await spawnClaude(vision.stdin, args, {
      timeoutMs: opts.timeoutMs,
      context: opts.context,
      purpose: opts.purpose,
      signal: opts.signal,
      onDelta: opts.onDelta,
      armQuotaCircuit: opts.armQuotaCircuit,
    });
    return { ...response, inputChars: prompt.length };
  };

  return {
    kind: 'cli',
    complete: run,
    stream: run,
    warmup: (opts) =>
      run(CLAUDE_WARMUP_REQUEST, {
        ...opts,
        purpose: 'warmup',
        armQuotaCircuit: false,
      }),
  };
}
