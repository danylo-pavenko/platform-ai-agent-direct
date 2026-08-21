/**
 * Claude agent runtime contract (Phase 0–1 of Agent SDK migration).
 *
 * Callers (`askClaude`, conversation, sandbox, teach) depend on these types —
 * not on CLI spawn vs SDK. Implementations live in `services/claude-*-runtime.ts`.
 */

import type { AgentChannel } from '../generated/prisma/enums.js';
import {
  CUSTOMER_FALLBACK_BUSY,
  CUSTOMER_FALLBACK_TIMEOUT,
} from './agent-fallback-defaults.js';
import type { ClaudeSpawnPurpose } from './claude-quota-gate.js';

export const CLAUDE_RUNTIME_KINDS = ['cli', 'sdk'] as const;
export type ClaudeRuntimeKind = (typeof CLAUDE_RUNTIME_KINDS)[number];

/** Frozen lockdown for Phase 1+ SDK options — never enable coding tools. */
export const CLAUDE_SDK_DISALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
] as const;

export interface ClaudeRequest {
  systemPrompt: string;
  conversationHistory: { role: 'user' | 'assistant'; content: string }[];
  userMessage: string;
  images?: string[];
  tools?: ToolDefinition[];
  /**
   * When set, reuse the Claude Code session (`--resume` / SDK `resume`) and
   * send only the new user message (tool result).
   */
  resumeSessionId?: string;
  /** Closed over by SDK MCP handlers + canUseTool (branch, CRM link, booking gate). */
  lookupContext?: {
    clientId?: string | null;
    branchCrmExternalId?: string | null;
    crmHistoryAllowed?: boolean;
    clientMessage?: string;
    /** After a terminal mutation this turn, follow-up query() must not book/collect again. */
    mutationsAllowed?: boolean;
    /** Synced/confirmed visit — different date/time is a reschedule (deny). */
    existingBooking?: { date: string; time: string } | null;
  };
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
   * Human-readable detail about why the fallback was produced. Internal —
   * callers should not surface this to end users.
   */
  errorDetail?: string;
  /** Claude Code session id — pass as `resumeSessionId` on the next round. */
  sessionId?: string;
  /** True when this invocation used resume with a slim prompt (no cold retry). */
  resumed?: boolean;
  /** Approx stdin / prompt size for this invocation (chars). */
  inputChars?: number;
  /**
   * Lookup results already produced by SDK MCP in this query.
   * conversation.ts must reuse these instead of calling CRM again.
   */
  lookupResults?: { name: string; result: string }[];
  /**
   * When false, finalize must not parse `<tool_call>` JSON from prose (SDK native tools).
   * CLI / vision fallback omit this (text protocol still applies).
   */
  usedTextToolProtocol?: boolean;
}

export const CLAUDE_WARMUP_REQUEST: ClaudeRequest = {
  systemPrompt: 'You are a health-check probe. Reply with exactly one word: OK. No punctuation.',
  conversationHistory: [],
  userMessage: 'ping',
};

export interface ClaudeCallContext {
  channel: AgentChannel;
  conversationId?: string;
  clientId?: string;
  /** Per-call override (e.g. voice turns after STT). */
  timeoutMs?: number;
  /** Claude `--model` (haiku router / sonnet|opus reply). Falls back to agent_config. */
  model?: string;
  /** Override quota-gate purpose (e.g. follow_up vs customer_dm). */
  spawnPurpose?: ClaudeSpawnPurpose;
  /** Cancels this invocation (sandbox disconnect / mid-turn prompt activate). */
  signal?: AbortSignal;
}

export type ClaudeStreamDeltaHandler = (delta: string) => void;

export interface ClaudeRuntimeInvokeOptions {
  timeoutMs: number;
  model: string;
  context?: ClaudeCallContext;
  onDelta?: ClaudeStreamDeltaHandler;
  signal?: AbortSignal;
  purpose?: ClaudeSpawnPurpose;
  /**
   * When false, a 429 / session-limit from this call must not open the quota
   * circuit. Warmup always skips arming (see `shouldArmClaudeQuotaCircuit`).
   */
  armQuotaCircuit?: boolean;
}

export interface ClaudeRuntime {
  readonly kind: ClaudeRuntimeKind;
  complete(req: ClaudeRequest, opts: ClaudeRuntimeInvokeOptions): Promise<ClaudeResponse>;
  stream(req: ClaudeRequest, opts: ClaudeRuntimeInvokeOptions): Promise<ClaudeResponse>;
  /** Light ping after API listen — must not sit on the IG/meta semaphores. */
  warmup(opts: ClaudeRuntimeInvokeOptions): Promise<ClaudeResponse>;
}

/** Meta-agent teach has its own semaphore so IG DMs are not queued behind it. */
export function claudeConcurrencyLane(
  channel: AgentChannel | undefined,
): 'meta' | 'shared' {
  return channel === 'meta_agent' ? 'meta' : 'shared';
}

export const ADMIN_AGENT_CHANNELS = new Set<AgentChannel>([
  'meta_agent',
  'sandbox',
  'supervisor',
  'insights',
]);

export const ADMIN_FALLBACK_BUSY =
  'Агент зараз перевантажений (забагато одночасних запитів). Спробуйте за хвилину.';
export const ADMIN_FALLBACK_TIMEOUT =
  'Агент не встиг відповісти за відведений час. Спробуйте скоротити запит або повторити ще раз.';

/** Default SDK (Phase 5). Explicit `cli` is the hotfix rollback. */
export function parseClaudeRuntimeKind(raw: unknown): ClaudeRuntimeKind {
  return raw === 'cli' ? 'cli' : 'sdk';
}

export function isAdminAgentChannel(channel: AgentChannel | undefined): boolean {
  return channel != null && ADMIN_AGENT_CHANNELS.has(channel);
}

export function claudeFallbackResponse(
  reason: 'busy' | 'timeout',
  context?: ClaudeCallContext,
  errorDetail?: string,
): ClaudeResponse {
  const isAdmin = context ? isAdminAgentChannel(context.channel) : false;
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

export function claudeTimeoutMs(
  context: ClaudeCallContext | undefined,
  defaults: { adminMs: number; customerMs: number },
): number {
  if (context?.timeoutMs != null) return context.timeoutMs;
  if (context && isAdminAgentChannel(context.channel)) return defaults.adminMs;
  return defaults.customerMs;
}
