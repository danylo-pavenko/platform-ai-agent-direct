/**
 * Claude Agent SDK runtime (`query()` → bundled CLI subprocess).
 * Customer tools: in-process MCP (lookup executed here; terminal gated by
 * canUseTool and executed by conversation.ts). Not Anthropic Messages API.
 *
 * Vision turns (images) use an explicit CLI fallback — logged, never silent.
 */

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';
import { config } from '../config.js';
import { isClaudeRateLimitSignal } from '../lib/claude-auth-probe.js';
import { resolveClaudeSpawnCwd } from '../lib/claude-spawn-cwd.js';
import {
  evaluateClaudeSpawn,
  noteClaudeRateLimit,
  purposeFromAgentChannel,
  shouldArmClaudeQuotaCircuit,
} from '../lib/claude-quota-gate.js';
import {
  CLAUDE_WARMUP_REQUEST,
  claudeFallbackResponse,
  type ClaudeRequest,
  type ClaudeResponse,
  type ClaudeRuntime,
  type ClaudeRuntimeInvokeOptions,
} from '../lib/claude-runtime.js';
import { buildClaudeSdkQueryOptions } from '../lib/claude-sdk-options.js';
import { consumeSdkMessages, type SdkAgentMessage } from '../lib/claude-sdk-messages.js';
import { closeSdkQuery } from '../lib/claude-sdk-close.js';
import { recordClaudeRateLimit } from './claude-quota.js';
import { buildClaudePrompt, createCliClaudeRuntime } from './claude-cli-runtime.js';
import {
  CLAUDE_SDK_MCP_SERVER_NAME,
  createLookupMcpServer,
  mcpAllowedToolNames,
  platformToolsForMcp,
} from './claude-sdk-lookup-mcp.js';
import { createClaudeSdkCanUseTool } from '../lib/claude-sdk-permissions.js';

const log = pino({ name: 'claude-sdk-runtime' });

export const CLI_VISION_FALLBACK_DETAIL = 'runtime=cli_vision_fallback';

export type SdkQueryFn = typeof sdkQuery;

export interface SdkRuntimeDeps {
  query?: SdkQueryFn;
  cliRuntime?: ClaudeRuntime;
}

function linkAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) return () => undefined;
  const onAbort = () => {
    if (!child.signal.aborted) child.abort();
  };
  if (parent.aborted) {
    onAbort();
    return () => undefined;
  }
  parent.addEventListener('abort', onAbort, { once: true });
  return () => parent.removeEventListener('abort', onAbort);
}

export function createSdkClaudeRuntime(deps: SdkRuntimeDeps = {}): ClaudeRuntime {
  const queryFn = deps.query ?? sdkQuery;

  const run = async (
    req: ClaudeRequest,
    opts: ClaudeRuntimeInvokeOptions,
  ): Promise<ClaudeResponse> => {
    const resume = Boolean(req.resumeSessionId);
    const images = resume ? undefined : req.images;

    if (images && images.length > 0) {
      log.warn(
        {
          event: 'cli_vision_fallback',
          runtime: CLI_VISION_FALLBACK_DETAIL,
          imageCount: images.length,
          channel: opts.context?.channel ?? null,
        },
        'SDK runtime: vision turn uses CLI path (explicit fallback, not silent degrade)',
      );
      const cli = deps.cliRuntime ?? createCliClaudeRuntime();
      const viaCli = await cli.complete(req, opts);
      return viaCli;
    }

    const purpose =
      opts.purpose ??
      opts.context?.spawnPurpose ??
      purposeFromAgentChannel(opts.context?.channel ?? null);

    const gate = evaluateClaudeSpawn(purpose, {
      softPercent: config.CLAUDE_QUOTA_SOFT_PERCENT,
    });
    if (!gate.allowed) {
      log.warn(
        { purpose, reason: gate.reason, channel: opts.context?.channel ?? null },
        'Claude SDK query blocked by quota gate',
      );
      return claudeFallbackResponse(
        'timeout',
        opts.context,
        `quota_gate: ${gate.reason}`,
      );
    }

    const prompt = buildClaudePrompt(req, {
      resume,
      embedSystem: false,
      nativeAllTools: true,
    });
    const abortController = new AbortController();
    const unlinkParent = linkAbort(opts.signal, abortController);
    const platformNames = platformToolsForMcp(req.tools, req.lookupContext);
    const mcpAllowed = mcpAllowedToolNames(platformNames);
    const queryOptions = buildClaudeSdkQueryOptions({
      model: opts.model,
      cwd: resolveClaudeSpawnCwd(),
      systemPrompt: req.systemPrompt,
      resumeSessionId: req.resumeSessionId,
      abortController,
      includePartialMessages: Boolean(opts.onDelta),
      timeoutMs: opts.timeoutMs,
      ...(platformNames.length > 0
        ? {
            mcpServers: {
              [CLAUDE_SDK_MCP_SERVER_NAME]: createLookupMcpServer(
                req.lookupContext ?? {},
                platformNames,
              ),
            },
            mcpAllowedTools: mcpAllowed,
            canUseTool: createClaudeSdkCanUseTool({
              allowNames: new Set(platformNames),
              mutationsAllowed: req.lookupContext?.mutationsAllowed !== false,
              existingBooking: req.lookupContext?.existingBooking ?? null,
            }),
          }
        : {}),
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let q: ReturnType<SdkQueryFn> | undefined;

    const settleTimeout = () => {
      if (!abortController.signal.aborted) abortController.abort();
      void closeSdkQuery(q);
    };

    try {
      q = queryFn({ prompt, options: queryOptions });
      timer = setTimeout(settleTimeout, opts.timeoutMs);

      const abortResult = new Promise<ClaudeResponse>((resolve) => {
        const onAbort = () => {
          const detail = opts.signal?.aborted
            ? 'aborted by client'
            : `timed out after ${opts.timeoutMs}ms`;
          resolve(claudeFallbackResponse('timeout', opts.context, detail));
        };
        if (abortController.signal.aborted) onAbort();
        else abortController.signal.addEventListener('abort', onAbort, { once: true });
      });

      const response = await Promise.race([
        consumeSdkMessages(q as AsyncIterable<SdkAgentMessage>, { onDelta: opts.onDelta }),
        abortResult,
      ]);
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }

      if (response.fallback && abortController.signal.aborted) {
        return response;
      }

      const signal = [response.text, response.errorDetail ?? ''].join('\n');
      if (
        shouldArmClaudeQuotaCircuit(purpose, opts.armQuotaCircuit) &&
        response.fallback &&
        (isClaudeRateLimitSignal(signal) || isClaudeRateLimitSignal(response.errorDetail ?? ''))
      ) {
        noteClaudeRateLimit(response.errorDetail ?? signal);
        void recordClaudeRateLimit(response.errorDetail ?? signal);
      }

      if (response.fallback) {
        return claudeFallbackResponse(
          'timeout',
          opts.context,
          response.errorDetail ?? 'sdk query fallback',
        );
      }

      return { ...response, inputChars: prompt.length, usedTextToolProtocol: false };
    } catch (err) {
      const aborted =
        abortController.signal.aborted || opts.signal?.aborted === true;
      const message = err instanceof Error ? err.message : String(err);
      if (aborted) {
        const detail = opts.signal?.aborted
          ? 'aborted by client'
          : `timed out after ${opts.timeoutMs}ms`;
        log.warn(
          { channel: opts.context?.channel ?? null, detail },
          'Claude SDK query aborted',
        );
        return claudeFallbackResponse('timeout', opts.context, detail);
      }
      if (isClaudeRateLimitSignal(message) && shouldArmClaudeQuotaCircuit(purpose, opts.armQuotaCircuit)) {
        noteClaudeRateLimit(message);
        void recordClaudeRateLimit(message);
      }
      log.error({ err, channel: opts.context?.channel ?? null }, 'Claude SDK query failed');
      return claudeFallbackResponse(
        'timeout',
        opts.context,
        `sdk query failed: ${message}`,
      );
    } finally {
      if (timer) clearTimeout(timer);
      unlinkParent();
      await closeSdkQuery(q);
    }
  };

  return {
    kind: 'sdk',
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
