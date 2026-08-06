import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimePromptSession,
  type ActiveSystemPrompt,
  type PromptRuntimeMeta,
} from './prompt-runtime.js';

describe('createRuntimePromptSession', () => {
  const initial: ActiveSystemPrompt = {
    id: 'prompt-a',
    version: 3,
    content: 'OLD PROMPT BODY',
  };

  it('rebuilds when active prompt id changes mid-turn', async () => {
    let fp: PromptRuntimeMeta = { id: 'prompt-a', version: 3, generation: 1 };
    const fetchFingerprint = vi.fn(async () => fp);
    const fetchActive = vi.fn(async (): Promise<ActiveSystemPrompt> => ({
      id: 'prompt-b',
      version: 4,
      content: 'NEW PROMPT BODY',
    }));

    const session = createRuntimePromptSession({
      initial,
      generation: 1,
      rebuild: (content) => `RUNTIME:${content}`,
      fetchFingerprint,
      fetchActive,
    });

    expect(session.getPrompt()).toBe('RUNTIME:OLD PROMPT BODY');
    expect(session.getMeta()).toEqual({ id: 'prompt-a', version: 3, generation: 1 });

    const first = await session.refreshIfStale();
    expect(first.refreshed).toBe(false);
    expect(fetchActive).not.toHaveBeenCalled();

    fp = { id: 'prompt-b', version: 4, generation: 2 };
    const second = await session.refreshIfStale();
    expect(second.refreshed).toBe(true);
    expect(second.prompt).toBe('RUNTIME:NEW PROMPT BODY');
    expect(second.meta).toEqual({ id: 'prompt-b', version: 4, generation: 2 });
    expect(session.getPrompt()).toBe('RUNTIME:NEW PROMPT BODY');
    expect(fetchActive).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when only runtime generation bumps (same prompt re-activated)', async () => {
    let fp: PromptRuntimeMeta = { id: 'prompt-a', version: 3, generation: 1 };
    const fetchFingerprint = vi.fn(async () => fp);
    const fetchActive = vi.fn(async () => initial);

    const session = createRuntimePromptSession({
      initial,
      generation: 1,
      rebuild: (content) => `RUNTIME:${content}`,
      fetchFingerprint,
      fetchActive,
    });

    fp = { id: 'prompt-a', version: 3, generation: 5 };
    const result = await session.refreshIfStale();
    expect(result.refreshed).toBe(true);
    expect(result.meta.generation).toBe(5);
    expect(fetchActive).toHaveBeenCalledTimes(1);
  });

  it('keeps prompt when fingerprint is unchanged', async () => {
    const fetchFingerprint = vi.fn(async (): Promise<PromptRuntimeMeta> => ({
      id: 'prompt-a',
      version: 3,
      generation: 1,
    }));
    const fetchActive = vi.fn();

    const session = createRuntimePromptSession({
      initial,
      generation: 1,
      rebuild: (c) => c,
      fetchFingerprint,
      fetchActive,
    });

    const a = await session.refreshIfStale();
    const b = await session.refreshIfStale();
    expect(a.refreshed).toBe(false);
    expect(b.refreshed).toBe(false);
    expect(fetchActive).not.toHaveBeenCalled();
    expect(fetchFingerprint).toHaveBeenCalledTimes(2);
  });
});

describe('parseGeneration via session (value shapes)', () => {
  it('treats null active id as stable fallback fingerprint', async () => {
    const session = createRuntimePromptSession({
      initial: { id: null, version: null, content: 'FALLBACK' },
      generation: 0,
      rebuild: (c) => c,
      fetchFingerprint: async () => ({ id: null, version: null, generation: 0 }),
      fetchActive: async () => ({ id: null, version: null, content: 'FALLBACK' }),
    });
    const r = await session.refreshIfStale();
    expect(r.refreshed).toBe(false);
    expect(r.prompt).toBe('FALLBACK');
  });
});
