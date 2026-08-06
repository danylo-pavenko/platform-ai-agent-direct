import { describe, expect, it, vi } from 'vitest';
import { resolveTeachStreamClose } from '../../../admin/src/lib/teach-stream-close.ts';
import { consumeSse } from '../../../admin/src/lib/teach-stream-sse.ts';

describe('resolveTeachStreamClose', () => {
  it('is ok when done arrived', () => {
    expect(resolveTeachStreamClose({ gotDone: true, gotError: false, aborted: false })).toBe('ok');
  });

  it('is ok when error event arrived', () => {
    expect(resolveTeachStreamClose({ gotDone: false, gotError: true, aborted: false })).toBe('ok');
  });

  it('is aborted when client cancelled without terminal event', () => {
    expect(resolveTeachStreamClose({ gotDone: false, gotError: false, aborted: true })).toBe(
      'aborted',
    );
  });

  it('is silent_end when stream closes with neither done nor error', () => {
    expect(resolveTeachStreamClose({ gotDone: false, gotError: false, aborted: false })).toBe(
      'silent_end',
    );
  });

  it('prefers terminal events over aborted flag', () => {
    expect(resolveTeachStreamClose({ gotDone: true, gotError: false, aborted: true })).toBe('ok');
    expect(resolveTeachStreamClose({ gotDone: false, gotError: true, aborted: true })).toBe('ok');
  });
});

describe('consumeSse', () => {
  function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[i++]));
      },
    });
  }

  it('parses done event', async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    await consumeSse(
      sseBody(['event: done\ndata: {"reply":"ok"}\n\n']),
      {
        onEvent: (event, data) => events.push({ event, data }),
      },
    );
    expect(events).toEqual([{ event: 'done', data: { reply: 'ok' } }]);
  });

  it('exits without events when stream is empty (silent end → onError path)', async () => {
    const onEvent = vi.fn();
    await consumeSse(sseBody([]), { onEvent });
    expect(onEvent).not.toHaveBeenCalled();
    expect(
      resolveTeachStreamClose({ gotDone: false, gotError: false, aborted: false }),
    ).toBe('silent_end');
  });
});
