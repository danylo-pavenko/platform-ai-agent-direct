import { describe, expect, it } from 'vitest';
import { buildSandboxCopyBundle } from '../services/sandbox-copy-bundle.js';

describe('buildSandboxCopyBundle', () => {
  it('includes failure reason and debug JSON for pasting into Cursor', () => {
    const text = buildSandboxCopyBundle({
      ok: false,
      failure: {
        code: 'timeout',
        reasonUk: 'Claude не встиг відповісти за відведений час (таймаут CLI).',
        errorDetail: 'timed out after 120000ms',
      },
      reply: 'Агент не встиг відповісти…',
      lastUserMessage: 'Хочу манікюр на завтра',
      debug: {
        agentMode: 'booking',
        stages: ['Шукаю послуги…'],
        tools: [],
      },
    });

    expect(text).toContain('=== Sandbox agent debug (paste into Cursor) ===');
    expect(text).toContain('failure.code: timeout');
    expect(text).toContain('timed out after 120000ms');
    expect(text).toContain('"agentMode": "booking"');
    expect(text).toContain('Хочу манікюр на завтра');
  });
});
