import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import pino from 'pino';
import { config } from '../config.js';
import { Semaphore } from '../lib/queue.js';

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
}

// ---------------------------------------------------------------------------
// Constants / singleton state
// ---------------------------------------------------------------------------

const log = pino({ name: 'claude' });

const semaphore = new Semaphore(config.CLAUDE_MAX_CONCURRENCY);

const FALLBACK_BUSY: ClaudeResponse = {
  text: 'Дякуємо за повідомлення! Менеджер відпише трохи пізніше.',
};

const FALLBACK_TIMEOUT: ClaudeResponse = {
  text: 'Одну хвилинку, менеджер відпише трохи пізніше.',
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
      log.error({ err }, 'Failed to spawn claude CLI');
      resolve(FALLBACK_TIMEOUT);
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
        settle(FALLBACK_TIMEOUT);
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
      log.error({ err }, 'Claude CLI process error');
      settle(FALLBACK_TIMEOUT);
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (code !== 0 && !settled) {
        log.error({ code, stderr: stderr.slice(0, 500) }, 'Claude CLI exited with non-zero code');
        settle(FALLBACK_TIMEOUT);
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
 * Send a request to Claude via the headless CLI.
 *
 * - Respects concurrency limits via the shared semaphore.
 * - Returns a fallback message on overload, timeout, or error (never throws).
 */
export async function askClaude(req: ClaudeRequest): Promise<ClaudeResponse> {
  // Back-pressure: reject early if too many requests are already queued
  if (semaphore.pending > MAX_PENDING) {
    log.warn(
      { pending: semaphore.pending, active: semaphore.active },
      'Claude queue overloaded - returning fallback',
    );
    return FALLBACK_BUSY;
  }

  const startMs = Date.now();
  const prompt = buildPrompt(req);
  const args = buildArgs(req);

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
      },
      'Claude invocation complete',
    );

    return response;
  } catch (err) {
    log.error({ err }, 'Unexpected error in askClaude');
    return FALLBACK_TIMEOUT;
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
