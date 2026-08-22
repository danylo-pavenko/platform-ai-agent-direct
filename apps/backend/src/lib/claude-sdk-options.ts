/**
 * Frozen Agent SDK query options for this platform.
 * Coding tools must never appear on the customer / admin assistant path.
 */

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_SDK_DISALLOWED_TOOLS } from './claude-runtime.js';

export const CLAUDE_SDK_CLIENT_APP = 'platform-ai-agent-direct';

/** `tools: []` disables every built-in Claude Code tool (Bash/Read/Write/…). */
export const CLAUDE_SDK_LOCKDOWN = {
  allowedTools: [] as string[],
  disallowedTools: [...CLAUDE_SDK_DISALLOWED_TOOLS],
  tools: [] as string[],
  permissionMode: 'dontAsk' as const,
  settingSources: [] as [],
  // No maxTurns — the query timeout (timeoutMs / AbortSignal) is the stop.
  // Book/collect still execute in conversation.ts (MCP returns HOST_QUEUED).
  strictMcpConfig: true,
};

export interface BuildClaudeSdkQueryOptionsInput {
  model: string;
  cwd: string;
  systemPrompt: string;
  resumeSessionId?: string;
  abortController: AbortController;
  includePartialMessages: boolean;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  mcpServers?: Options['mcpServers'];
  mcpAllowedTools?: string[];
  canUseTool?: Options['canUseTool'];
}

export function buildClaudeSdkQueryOptions(input: BuildClaudeSdkQueryOptionsInput): Options {
  const baseEnv = input.env ?? process.env;
  const mcpTools = (input.mcpAllowedTools ?? []).filter(Boolean);
  const options: Options = {
    ...CLAUDE_SDK_LOCKDOWN,
    allowedTools: mcpTools,
    tools: mcpTools.length > 0 ? mcpTools : [],
    model: input.model,
    cwd: input.cwd,
    systemPrompt: input.systemPrompt,
    abortController: input.abortController,
    includePartialMessages: input.includePartialMessages,
    persistSession: true,
    env: {
      ...baseEnv,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: CLAUDE_SDK_CLIENT_APP,
      API_TIMEOUT_MS: String(input.timeoutMs),
    },
  };

  if (input.mcpServers) {
    options.mcpServers = input.mcpServers;
  }

  if (input.canUseTool) {
    options.canUseTool = input.canUseTool;
  }

  if (input.resumeSessionId) {
    options.resume = input.resumeSessionId;
  }

  return options;
}

/** True when SDK init/options would expose a coding-agent filesystem tool. */
export function sdkOptionsExposeCodingTools(options: {
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: unknown;
}): boolean {
  const coding = new Set<string>(CLAUDE_SDK_DISALLOWED_TOOLS);
  if (options.tools === undefined) return true;
  if (!Array.isArray(options.tools)) return true;
  if (options.tools.some((name) => coding.has(String(name)))) return true;
  if ((options.allowedTools ?? []).some((name) => coding.has(name))) return true;
  return false;
}
