/**
 * Admin-only per-turn debug notes for live conversation chats.
 * Persisted as system messages; ConversationDetail shows them only with
 * `?debug_enabled=true` (same opt-in as SandboxView).
 */

export const AGENT_TURN_DEBUG_PREFIX = '🛠 Хід агента';

export type AgentTurnToolDebug = {
  name: string;
  args: Record<string, unknown>;
  resultPreview: string;
};

export type AgentTurnRoundDebug = {
  round: number;
  label?: string;
  toolCall?: string | null;
  toolCalls?: string[];
  textPreview?: string;
  fallback?: string | null;
};

export type AgentTurnDebugCollector = {
  tools: AgentTurnToolDebug[];
  rounds: AgentTurnRoundDebug[];
  stallRecovery: boolean;
  gateReason?: string;
  redactedInternals?: boolean;
  agentFallback?: string | null;
  clientMessage?: string;
  finalReplyPreview?: string;
  agentMode?: string;
};

const PREVIEW_MAX = 500;

export function createAgentTurnDebugCollector(): AgentTurnDebugCollector {
  return {
    tools: [],
    rounds: [],
    stallRecovery: false,
  };
}

export function isAgentTurnDebugNote(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.startsWith(AGENT_TURN_DEBUG_PREFIX);
}

export function previewDebugText(text: string, max = PREVIEW_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function recordTurnTool(
  collector: AgentTurnDebugCollector,
  name: string,
  args: Record<string, unknown>,
  resultPreview: string,
): void {
  collector.tools.push({
    name,
    args,
    resultPreview: previewDebugText(resultPreview, PREVIEW_MAX),
  });
}

export function recordTurnRound(
  collector: AgentTurnDebugCollector,
  round: Omit<AgentTurnRoundDebug, 'round'> & { round?: number },
): void {
  collector.rounds.push({
    round: round.round ?? collector.rounds.length + 1,
    label: round.label,
    toolCall: round.toolCall,
    toolCalls: round.toolCalls,
    textPreview: round.textPreview ? previewDebugText(round.textPreview, 280) : undefined,
    fallback: round.fallback,
  });
}

export function shouldPersistAgentTurnDebug(collector: AgentTurnDebugCollector): boolean {
  return (
    collector.rounds.length > 0 ||
    collector.tools.length > 0 ||
    collector.stallRecovery ||
    Boolean(collector.agentFallback) ||
    Boolean(collector.redactedInternals) ||
    (collector.gateReason != null && collector.gateReason !== 'ok')
  );
}

function formatArgs(args: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(args);
    return previewDebugText(json || '{}', 280);
  } catch {
    return '{}';
  }
}

/**
 * Multiline system message for admin ConversationDetail (never sent to IG).
 */
export function formatAgentTurnDebugNote(
  collector: AgentTurnDebugCollector,
  opts?: { durationMs?: number },
): string {
  const lines: string[] = [AGENT_TURN_DEBUG_PREFIX];

  if (collector.agentMode) {
    lines.push(`• Режим: ${collector.agentMode}`);
  }
  if (opts?.durationMs != null && Number.isFinite(opts.durationMs)) {
    lines.push(`• Тривалість: ${(opts.durationMs / 1000).toFixed(1)}с`);
  }
  if (collector.stallRecovery) {
    lines.push('• Stall recovery: так (обіцянка пошуку без tool → повторний хід)');
  }
  if (collector.agentFallback) {
    lines.push(`• Claude fallback: ${collector.agentFallback}`);
  }
  if (collector.gateReason) {
    const redact = collector.redactedInternals ? ', затерто internal ids' : '';
    lines.push(`• Gate: ${collector.gateReason}${redact}`);
  } else if (collector.redactedInternals) {
    lines.push('• Gate: ok, затерто internal ids');
  }

  const client = collector.clientMessage?.trim();
  if (client) {
    lines.push(`• Запит клієнта: «${previewDebugText(client, 200)}»`);
  }

  if (collector.rounds.length > 0) {
    lines.push('', 'Rounds:');
    for (const r of collector.rounds) {
      const tools =
        r.toolCalls && r.toolCalls.length > 0
          ? r.toolCalls.join(', ')
          : r.toolCall || '—';
      const bits = [`${r.round}.`, r.label ? `[${r.label}]` : null, `tools=${tools}`];
      if (r.fallback) bits.push(`fallback=${r.fallback}`);
      if (r.textPreview) bits.push(`text=«${r.textPreview}»`);
      lines.push(bits.filter(Boolean).join(' '));
    }
  }

  if (collector.tools.length > 0) {
    lines.push('', `Tools (${collector.tools.length}):`);
    collector.tools.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.name}`);
      lines.push(`   args: ${formatArgs(t.args)}`);
      lines.push(`   result: ${t.resultPreview || '—'}`);
    });
  } else {
    lines.push('', 'Tools: (не викликались)');
  }

  if (collector.finalReplyPreview?.trim()) {
    lines.push('', `Фінальна відповідь клієнту: «${previewDebugText(collector.finalReplyPreview, 280)}»`);
  }

  return lines.join('\n');
}
