import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import pino from 'pino';
import { config } from '../config.js';
import { Semaphore } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import type { AgentChannel } from '../generated/prisma/enums.js';

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
}

export interface ClaudeCallContext {
  channel: AgentChannel;
  conversationId?: string;
  clientId?: string;
}

// ---------------------------------------------------------------------------
// Constants / singleton state
// ---------------------------------------------------------------------------

const log = pino({ name: 'claude' });

const semaphore = new Semaphore(config.CLAUDE_MAX_CONCURRENCY);

const FALLBACK_BUSY: ClaudeResponse = {
  text: 'Дякуємо за повідомлення! Менеджер відпише трохи пізніше.',
  fallback: 'busy',
};

const FALLBACK_TIMEOUT: ClaudeResponse = {
  text: 'Одну хвилинку, менеджер відпише трохи пізніше.',
  fallback: 'timeout',
};

const MAX_PENDING = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the plain-text prompt that is piped to Claude's stdin. */
function buildPrompt(req: ClaudeRequest): string {
  const parts: string[] = [];

  parts.push(`<system>\n${req.systemPrompt}\n</system>`);

  for (const msg of req.conversationHistory) {
    const prefix = msg.role === 'user' ? 'Human' : 'Assistant';
    parts.push(`${prefix}: ${msg.content}`);
  }

  parts.push(`Human: ${req.userMessage}`);

  return parts.join('\n\n');
}

/** Build the CLI argument list. */
function buildArgs(req: ClaudeRequest): string[] {
  const args: string[] = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', config.CLAUDE_MODEL,
  ];

  if (req.images && req.images.length > 0) {
    for (const img of req.images) {
      args.push('--image', img);
    }
  }

  // TODO: pass tools via MCP or --tool flag when supported
  // if (req.tools && req.tools.length > 0) { ... }

  return args;
}

/**
 * Parse the stream-json output from the Claude CLI.
 *
 * Each line is a JSON object. We look for the final result message
 * that contains the assistant's text response.
 *
 * Known line shapes:
 *   {"type":"assistant","content":[{"type":"text","text":"..."}]}
 *   {"type":"result","result":"...","duration_ms":...}
 */
function parseResponse(raw: string): ClaudeResponse {
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  // Walk lines in reverse to find the last meaningful content
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);

      // result-type line (Claude CLI >= 2024)
      if (obj.type === 'result' && typeof obj.result === 'string') {
        return { text: obj.result };
      }

      // assistant message with content array
      if (obj.type === 'assistant' && Array.isArray(obj.content)) {
        const textParts: string[] = [];
        const toolCalls: { name: string; args: Record<string, unknown> }[] = [];

        for (const block of obj.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text);
          }
          if (block.type === 'tool_use') {
            toolCalls.push({
              name: block.name as string,
              args: (block.input ?? {}) as Record<string, unknown>,
            });
          }
        }

        if (textParts.length > 0 || toolCalls.length > 0) {
          return {
            text: textParts.join('\n'),
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          };
        }
      }

      // content_block_delta streaming events - accumulate text
      // (handled by looking at the final assistant message above,
      //  but as a safety net we also check for a plain text field)
      if (typeof obj.text === 'string' && obj.text.length > 0 && !obj.type) {
        return { text: obj.text };
      }
    } catch {
      // Not valid JSON - skip
    }
  }

  // If nothing parsed, return whatever raw text we got (trimmed)
  const trimmed = raw.trim();
  if (trimmed.length > 0) {
    return { text: trimmed };
  }

  return { text: '' };
}

/**
 * Path to the Claude CLI binary used by the runtime spawn.
 *
 * Anthropic's official install script places it here. The healthcheck
 * endpoint probes this exact path so diagnostics match runtime behaviour.
 */
export function getClaudeBinaryPath(): string {
  return resolvePath(homedir(), '.local', 'bin', 'claude');
}

/** Spawn the Claude CLI and return a promise with collected output. */
function spawnClaude(
  prompt: string,
  args: string[],
  timeoutMs: number,
): Promise<ClaudeResponse> {
  return new Promise<ClaudeResponse>((resolve) => {
    let child: ChildProcess;

    try {
      child = spawn(getClaudeBinaryPath(), args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'Failed to spawn claude CLI');
      resolve({ ...FALLBACK_TIMEOUT, errorDetail: `spawn failed: ${message}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (response: ClaudeResponse) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    // Timeout handling
    const timer = setTimeout(() => {
      if (!settled) {
        log.warn({ timeoutMs }, 'Claude CLI timed out - killing process');
        child.kill('SIGKILL');
        settle({ ...FALLBACK_TIMEOUT, errorDetail: `timed out after ${timeoutMs}ms` });
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'Claude CLI process error');
      settle({ ...FALLBACK_TIMEOUT, errorDetail: `process error: ${message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (code !== 0 && !settled) {
        const stderrPreview = stderr.slice(0, 500);
        log.error({ code, stderr: stderrPreview }, 'Claude CLI exited with non-zero code');
        settle({
          ...FALLBACK_TIMEOUT,
          errorDetail: `exit ${code}${stderrPreview ? `: ${stderrPreview}` : ''}`,
        });
        return;
      }

      const response = parseResponse(stdout);
      settle(response);
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
 */
export async function askClaude(
  req: ClaudeRequest,
  context?: ClaudeCallContext,
): Promise<ClaudeResponse> {
  const prompt = buildPrompt(req);
  const args = buildArgs(req);
  const startMs = Date.now();

  /**
   * Emit a dedicated warn-level log whenever the user actually receives a
   * canned "менеджер відпише" reply instead of a real model answer. Separate
   * from the site-specific error logs in spawnClaude so ops can grep a single
   * `event=agent_fallback` across all failure modes.
   */
  const logFallback = (response: ClaudeResponse, durationMs: number) => {
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
        inputChars: prompt.length,
        userMessagePreview: req.userMessage.slice(0, 200),
      },
      'Agent fallback — user received canned manager-handoff reply',
    );
  };

  const record = (response: ClaudeResponse, errorMessage: string | null = null) => {
    if (!context) return;
    recordInvocation({
      channel: context.channel,
      conversationId: context.conversationId,
      clientId: context.clientId,
      durationMs: Date.now() - startMs,
      success: !response.fallback,
      fallbackReason: response.fallback ?? null,
      errorMessage: errorMessage ?? response.errorDetail ?? null,
      inputChars: prompt.length,
      outputChars: response.text.length,
    });
  };

  // Back-pressure: reject early if too many requests are already queued
  if (semaphore.pending > MAX_PENDING) {
    log.warn(
      { pending: semaphore.pending, active: semaphore.active },
      'Claude queue overloaded - returning fallback',
    );
    const busy: ClaudeResponse = {
      ...FALLBACK_BUSY,
      errorDetail: `queue overloaded (pending=${semaphore.pending}, active=${semaphore.active})`,
    };
    logFallback(busy, Date.now() - startMs);
    record(busy);
    return busy;
  }

  let release: (() => void) | undefined;

  try {
    release = await semaphore.acquire();

    const response = await spawnClaude(prompt, args, config.CLAUDE_TIMEOUT_MS);

    const durationMs = Date.now() - startMs;
    log.info(
      {
        durationMs,
        inputChars: prompt.length,
        outputChars: response.text.length,
        toolCalls: response.toolCalls?.length ?? 0,
        fallback: response.fallback ?? null,
        channel: context?.channel ?? null,
      },
      'Claude invocation complete',
    );

    logFallback(response, durationMs);
    record(response);
    return response;
  } catch (err) {
    log.error({ err }, 'Unexpected error in askClaude');
    const message = err instanceof Error ? err.message : String(err);
    const fallback: ClaudeResponse = {
      ...FALLBACK_TIMEOUT,
      errorDetail: `askClaude unexpected error: ${message}`,
    };
    logFallback(fallback, Date.now() - startMs);
    record(fallback, message);
    return fallback;
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
