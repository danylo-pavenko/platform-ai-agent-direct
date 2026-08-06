import { describe, expect, it } from 'vitest';
import {
  AGENT_TURN_DEBUG_PREFIX,
  createAgentTurnDebugCollector,
  formatAgentTurnDebugNote,
  isAgentTurnDebugNote,
  recordTurnRound,
  recordTurnTool,
  shouldPersistAgentTurnDebug,
} from './agent-turn-debug.js';

describe('agent-turn-debug', () => {
  it('identifies persisted notes by prefix', () => {
    expect(isAgentTurnDebugNote(`${AGENT_TURN_DEBUG_PREFIX}\n• Режим: booking`)).toBe(true);
    expect(isAgentTurnDebugNote('🔍 Аналіз зображення')).toBe(false);
  });

  it('formats tools and rounds for admin', () => {
    const c = createAgentTurnDebugCollector();
    c.agentMode = 'booking';
    c.clientMessage = 'Хочу манікюр';
    c.stallRecovery = true;
    c.gateReason = 'ok';
    c.promptVersion = 12;
    c.runtimeGeneration = 4;
    c.promptRefreshedMidTurn = true;
    recordTurnRound(c, {
      label: 'first',
      toolCalls: [],
      textPreview: 'Добре, шукаю точні варіанти в каталозі, зараз буде',
    });
    recordTurnTool(c, 'search_services', { query: 'манікюр покриття' }, '[search_services] РЕЗУЛЬТАТ:\n…');
    c.finalReplyPreview = 'Класичний манікюр з покриттям — 850 грн.';

    const note = formatAgentTurnDebugNote(c, { durationMs: 4200 });
    expect(note.startsWith(AGENT_TURN_DEBUG_PREFIX)).toBe(true);
    expect(note).toContain('Stall recovery');
    expect(note).toContain('search_services');
    expect(note).toContain('манікюр покриття');
    expect(note).toContain('850 грн');
    expect(note).toContain('Промпт: v12, gen 4 (оновлено mid-turn)');
    expect(shouldPersistAgentTurnDebug(c)).toBe(true);
  });

  it('persists when only mid-turn prompt refresh happened', () => {
    const c = createAgentTurnDebugCollector();
    c.promptRefreshedMidTurn = true;
    expect(shouldPersistAgentTurnDebug(c)).toBe(true);
  });

  it('skips empty collectors', () => {
    expect(shouldPersistAgentTurnDebug(createAgentTurnDebugCollector())).toBe(false);
  });
});
