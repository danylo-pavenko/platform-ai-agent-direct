import { parseClaudeRuntimeKind, type ClaudeRuntime, type ClaudeRuntimeKind } from '../lib/claude-runtime.js';
import { createCliClaudeRuntime } from './claude-cli-runtime.js';
import { createSdkClaudeRuntime } from './claude-sdk-runtime.js';

/**
 * Pick a Claude runtime implementation.
 * Default is Agent SDK `query()`. Explicit `cli` is a hotfix rollback.
 * SDK does **not** silently fall back to CLI except documented vision turns
 * (`cli_vision_fallback`).
 */
export function createClaudeRuntime(kind: ClaudeRuntimeKind | string | undefined): ClaudeRuntime {
  const parsed = parseClaudeRuntimeKind(kind);
  if (parsed === 'sdk') return createSdkClaudeRuntime();
  return createCliClaudeRuntime();
}
