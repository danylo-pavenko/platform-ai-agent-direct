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

export type AgentTurnSpawnDebug = {
  purpose: 'reply';
  model: string;
  resumed: boolean;
  inputChars?: number;
};

export type AgentTurnDebugCollector = {
  tools: AgentTurnToolDebug[];
  rounds: AgentTurnRoundDebug[];
  spawns: AgentTurnSpawnDebug[];
  stallRecovery: boolean;
  /** True when we recovered a false "you're booked" claim without book_appointment. */
  falseBookingRecovery: boolean;
  /** True after one aware rewrite when cancel/reschedule/remove failed. */
  bookingMutationFailureRecovery: boolean;
  gateReason?: string;
  redactedInternals?: boolean;
  agentFallback?: string | null;
  clientMessage?: string;
  finalReplyPreview?: string;
  agentMode?: string;
  /** Active system_prompts.id at turn start (or after mid-turn refresh). */
  promptId?: string | null;
  promptVersion?: number | null;
  /** Monotonic activate counter from settings.prompt_runtime_generation. */
  runtimeGeneration?: number;
  /** True when Admin activated a new prompt during this turn's tool rounds. */
  promptRefreshedMidTurn?: boolean;
};

const PREVIEW_MAX = 500;

export function createAgentTurnDebugCollector(): AgentTurnDebugCollector {
  return {
    tools: [],
    rounds: [],
    spawns: [],
    stallRecovery: false,
    falseBookingRecovery: false,
    bookingMutationFailureRecovery: false,
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

export function recordTurnSpawn(
  collector: AgentTurnDebugCollector,
  spawn: AgentTurnSpawnDebug,
): void {
  collector.spawns.push({
    purpose: spawn.purpose,
    model: spawn.model,
    resumed: spawn.resumed,
    inputChars: spawn.inputChars,
  });
}

export function shouldPersistAgentTurnDebug(collector: AgentTurnDebugCollector): boolean {
  return (
    collector.rounds.length > 0 ||
    collector.tools.length > 0 ||
    collector.spawns.length > 0 ||
    collector.stallRecovery ||
    collector.falseBookingRecovery ||
    collector.bookingMutationFailureRecovery ||
    Boolean(collector.agentFallback) ||
    Boolean(collector.redactedInternals) ||
    Boolean(collector.promptRefreshedMidTurn) ||
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
  if (collector.promptVersion != null || collector.runtimeGeneration != null) {
    const ver =
      collector.promptVersion != null ? `v${collector.promptVersion}` : 'fallback';
    const gen =
      collector.runtimeGeneration != null ? `, gen ${collector.runtimeGeneration}` : '';
    const mid = collector.promptRefreshedMidTurn ? ' (оновлено mid-turn)' : '';
    lines.push(`• Промпт: ${ver}${gen}${mid}`);
  }
  if (opts?.durationMs != null && Number.isFinite(opts.durationMs)) {
    lines.push(`• Тривалість: ${(opts.durationMs / 1000).toFixed(1)}с`);
  }
  if (collector.spawns.length > 0) {
    const cold = collector.spawns.filter((s) => !s.resumed).length;
    const resumed = collector.spawns.filter((s) => s.resumed).length;
    const chars = collector.spawns.reduce((n, s) => n + (s.inputChars ?? 0), 0);
    lines.push(
      `• Claude spawns: ${collector.spawns.length} (cold ${cold}, resume ${resumed}` +
        (chars > 0 ? `, ~${chars} input chars` : '') +
        ')',
    );
  }
  if (collector.stallRecovery) {
    lines.push('• Stall recovery: так (обіцянка пошуку без tool → повторний хід)');
  }
  if (collector.falseBookingRecovery) {
    lines.push('• False booking recovery: так (підтвердження без book_appointment)');
  }
  if (collector.bookingMutationFailureRecovery) {
    lines.push(
      '• Mutation failure recovery: так (cancel/reschedule failed → агент обирає відповідь або SILENCE)',
    );
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

function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Compact HTML body for Telegram private «Хід агента» (no open-dialog link —
 * that goes on an inline button).
 */
export function formatAgentTurnDebugTelegramHtml(
  collector: AgentTurnDebugCollector,
  opts?: {
    durationMs?: number;
    clientLabel?: string;
  },
): string {
  const meta: string[] = [];
  if (collector.agentMode) meta.push(`<b>Режим:</b> ${escapeTelegramHtml(collector.agentMode)}`);
  if (collector.promptVersion != null || collector.runtimeGeneration != null) {
    const ver =
      collector.promptVersion != null ? `v${collector.promptVersion}` : 'fallback';
    const gen =
      collector.runtimeGeneration != null ? `, gen ${collector.runtimeGeneration}` : '';
    const mid = collector.promptRefreshedMidTurn ? ' · mid-turn' : '';
    meta.push(`<b>Промпт:</b> ${escapeTelegramHtml(`${ver}${gen}${mid}`)}`);
  }
  if (opts?.durationMs != null && Number.isFinite(opts.durationMs)) {
    meta.push(`<b>Тривалість:</b> ${(opts.durationMs / 1000).toFixed(1)}с`);
  }
  if (collector.spawns.length > 0) {
    const cold = collector.spawns.filter((s) => !s.resumed).length;
    const resumed = collector.spawns.filter((s) => s.resumed).length;
    meta.push(
      `<b>Claude:</b> ${collector.spawns.length} spawn (cold ${cold}, resume ${resumed})`,
    );
  }
  if (collector.agentFallback) {
    meta.push(`<b>Fallback:</b> ${escapeTelegramHtml(collector.agentFallback)}`);
  }
  if (collector.gateReason) {
    meta.push(`<b>Gate:</b> ${escapeTelegramHtml(collector.gateReason)}`);
  } else if (collector.redactedInternals) {
    meta.push(`<b>Gate:</b> ok (redacted ids)`);
  }
  if (collector.stallRecovery) meta.push(`<b>Stall recovery:</b> так`);
  if (collector.falseBookingRecovery) meta.push(`<b>False booking recovery:</b> так`);
  if (collector.bookingMutationFailureRecovery) {
    meta.push(`<b>Mutation failure recovery:</b> так`);
  }

  const lines: string[] = [`🛠 <b>Хід агента</b>`, ''];
  if (meta.length) {
    lines.push(...meta.map((m) => `• ${m}`));
  }

  const client = collector.clientMessage?.trim();
  if (client) {
    lines.push('', `<b>Запит:</b>`, `<i>«${escapeTelegramHtml(previewDebugText(client, 180))}»</i>`);
  }

  if (collector.tools.length > 0) {
    lines.push('', `<b>Tools (${collector.tools.length}):</b>`);
    for (const t of collector.tools.slice(0, 8)) {
      const preview = previewDebugText(t.resultPreview || '—', 120);
      lines.push(`• <code>${escapeTelegramHtml(t.name)}</code> → ${escapeTelegramHtml(preview)}`);
    }
    if (collector.tools.length > 8) {
      lines.push(`• …ще ${collector.tools.length - 8}`);
    }
  } else {
    lines.push('', `<b>Tools:</b> не викликались`);
  }

  if (collector.rounds.length > 1) {
    lines.push('', `<b>Rounds:</b> ${collector.rounds.length}`);
    for (const r of collector.rounds.slice(0, 4)) {
      const tools =
        r.toolCalls && r.toolCalls.length > 0
          ? r.toolCalls.join(', ')
          : r.toolCall || '—';
      const label = r.label ? `[${r.label}] ` : '';
      const textBit = r.textPreview
        ? ` — «${escapeTelegramHtml(previewDebugText(r.textPreview, 80))}»`
        : '';
      lines.push(`${r.round}. ${label}${escapeTelegramHtml(tools)}${textBit}`);
    }
  }

  if (collector.finalReplyPreview?.trim()) {
    lines.push(
      '',
      `<b>Відповідь клієнту:</b>`,
      escapeTelegramHtml(previewDebugText(collector.finalReplyPreview, 320)),
    );
  }

  if (opts?.clientLabel?.trim()) {
    lines.push('', `<b>Клієнт:</b> ${escapeTelegramHtml(opts.clientLabel.trim())}`);
  }

  return lines.join('\n');
}
