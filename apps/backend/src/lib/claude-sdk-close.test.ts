import { describe, expect, it, vi } from 'vitest';
import { closeSdkQuery } from './claude-sdk-close.js';

describe('closeSdkQuery', () => {
  it('interrupts then closes; still closes if interrupt throws; no-ops undefined', async () => {
    const interrupt = vi.fn(async () => undefined);
    const close = vi.fn();
    await closeSdkQuery({ interrupt, close });
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    const close2 = vi.fn();
    await closeSdkQuery({
      interrupt: async () => {
        throw new Error('not streaming');
      },
      close: close2,
    });
    expect(close2).toHaveBeenCalledTimes(1);
    await expect(closeSdkQuery(undefined)).resolves.toBeUndefined();
  });
});
