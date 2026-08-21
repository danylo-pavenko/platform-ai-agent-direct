import { describe, expect, it, vi } from 'vitest';
import { closeSdkQuery } from './claude-sdk-close.js';

describe('closeSdkQuery', () => {
  it('interrupts then closes', async () => {
    const interrupt = vi.fn(async () => undefined);
    const close = vi.fn();
    await closeSdkQuery({ interrupt, close });
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('still closes when interrupt throws', async () => {
    const close = vi.fn();
    await closeSdkQuery({
      interrupt: async () => {
        throw new Error('not streaming');
      },
      close,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('no-ops on undefined', async () => {
    await expect(closeSdkQuery(undefined)).resolves.toBeUndefined();
  });
});
