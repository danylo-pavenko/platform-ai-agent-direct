import { describe, expect, it } from 'vitest';
import {
  AGENT_TURN_DEBUG_PREFIX,
  createAgentTurnDebugCollector,
  formatAgentTurnDebugNote,
  formatAgentTurnDebugTelegramHtml,
  isAgentTurnDebugNote,
  recordTurnRound,
  recordTurnSpawn,
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

  it('formats cold vs resume spawn counters', () => {
    const c = createAgentTurnDebugCollector();
    recordTurnSpawn(c, { purpose: 'reply', model: 'sonnet', resumed: false, inputChars: 4000 });
    recordTurnSpawn(c, { purpose: 'reply', model: 'sonnet', resumed: true, inputChars: 200 });
    recordTurnSpawn(c, { purpose: 'reply', model: 'sonnet', resumed: true, inputChars: 150 });
    expect(shouldPersistAgentTurnDebug(c)).toBe(true);
    const note = formatAgentTurnDebugNote(c, { durationMs: 100 });
    expect(note).toMatch(/cold 1, resume 2/);
    expect(note).toMatch(/~4350 input chars/);
  });

  it('formats compact HTML for Telegram without open-dialog link', () => {
    const c = createAgentTurnDebugCollector();
    c.agentMode = 'general';
    c.clientMessage = 'Скільки коштує Stage 1?';
    c.finalReplyPreview = 'Для Вашого авто Stage 1 — від 449€.';
    c.gateReason = 'ok';
    recordTurnTool(c, 'search_services', { query: 'stage 1' }, '[search_services] ok');
    const html = formatAgentTurnDebugTelegramHtml(c, {
      durationMs: 5200,
      clientLabel: '@driver',
    });
    expect(html).toContain('🛠 <b>Хід агента</b>');
    expect(html).toContain('<b>Режим:</b> general');
    expect(html).toContain('<code>search_services</code>');
    expect(html).toContain('@driver');
    expect(html).not.toMatch(/Відкрити діалог/);
    expect(html).not.toMatch(/href=/);
  });
});
