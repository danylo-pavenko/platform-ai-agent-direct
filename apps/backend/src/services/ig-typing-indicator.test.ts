import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/feature-flags.js', () => ({
  isSendTypingIndicatorEnabled: vi.fn(),
}));

vi.mock('./instagram.js', () => ({
  markSeen: vi.fn().mockResolvedValue(undefined),
  sendTypingOn: vi.fn().mockResolvedValue(undefined),
  sendTypingOff: vi.fn().mockResolvedValue(undefined),
}));

import { isSendTypingIndicatorEnabled } from '../lib/feature-flags.js';
import { markSeen, sendTypingOff, sendTypingOn } from './instagram.js';
import {
  beginIgTypingIndicator,
  resetIgTypingSessionsForTests,
  stopIgTypingBeforeSend,
  TYPING_KEEPALIVE_MS,
} from './ig-typing-indicator.js';

describe('beginIgTypingIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetIgTypingSessionsForTests();
  });

  afterEach(() => {
    resetIgTypingSessionsForTests();
    vi.useRealTimers();
  });

  it('is a no-op for non-IG channels', async () => {
    const handle = await beginIgTypingIndicator({ channel: 'tg', recipientId: '123' });
    await handle.end();
    expect(markSeen).not.toHaveBeenCalled();
    expect(sendTypingOn).not.toHaveBeenCalled();
  });

  it('is a no-op when feature flag is disabled', async () => {
    vi.mocked(isSendTypingIndicatorEnabled).mockResolvedValue(false);
    const handle = await beginIgTypingIndicator({ channel: 'ig', recipientId: '123' });
    await handle.end();
    expect(markSeen).not.toHaveBeenCalled();
  });

  it('sends mark_seen and typing_on when enabled', async () => {
    vi.mocked(isSendTypingIndicatorEnabled).mockResolvedValue(true);
    const handle = await beginIgTypingIndicator({ channel: 'ig', recipientId: 'ig-user-1' });
    expect(markSeen).toHaveBeenCalledWith('ig-user-1');
    expect(sendTypingOn).toHaveBeenCalledWith('ig-user-1');
    await handle.end();
    expect(sendTypingOff).toHaveBeenCalledWith('ig-user-1');
  });

  it('re-sends typing_on on keepalive interval', async () => {
    vi.mocked(isSendTypingIndicatorEnabled).mockResolvedValue(true);
    const handle = await beginIgTypingIndicator({ channel: 'ig', recipientId: 'ig-user-1' });
    expect(sendTypingOn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TYPING_KEEPALIVE_MS);
    expect(sendTypingOn).toHaveBeenCalledTimes(2);
    await handle.end();
  });

  it('stopIgTypingBeforeSend clears active session before outbound message', async () => {
    vi.mocked(isSendTypingIndicatorEnabled).mockResolvedValue(true);
    await beginIgTypingIndicator({ channel: 'ig', recipientId: 'ig-user-1' });
    await stopIgTypingBeforeSend('ig-user-1');
    expect(sendTypingOff).toHaveBeenCalledWith('ig-user-1');
    sendTypingOff.mockClear();
    await stopIgTypingBeforeSend('ig-user-1');
    expect(sendTypingOff).not.toHaveBeenCalled();
  });

  it('clears a late keepalive typing_on that finishes after stop', async () => {
    vi.mocked(isSendTypingIndicatorEnabled).mockResolvedValue(true);

    let releaseKeepalive!: () => void;
    const keepalivePending = new Promise<void>((resolve) => {
      releaseKeepalive = resolve;
    });

    vi.mocked(sendTypingOn)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => keepalivePending);

    await beginIgTypingIndicator({ channel: 'ig', recipientId: 'ig-user-1' });
    expect(sendTypingOn).toHaveBeenCalledTimes(1);

    // Kick the keepalive interval; its typing_on hangs on keepalivePending.
    void vi.advanceTimersByTimeAsync(TYPING_KEEPALIVE_MS);
    await vi.waitFor(() => {
      expect(sendTypingOn).toHaveBeenCalledTimes(2);
    });

    await stopIgTypingBeforeSend('ig-user-1');
    expect(sendTypingOff).toHaveBeenCalledTimes(1);

    releaseKeepalive();
    await vi.waitFor(() => {
      expect(sendTypingOff).toHaveBeenCalledTimes(2);
    });
  });

  it('does not send keepalive typing_on after stop', async () => {
    vi.mocked(isSendTypingIndicatorEnabled).mockResolvedValue(true);
    await beginIgTypingIndicator({ channel: 'ig', recipientId: 'ig-user-1' });
    await stopIgTypingBeforeSend('ig-user-1');
    vi.mocked(sendTypingOn).mockClear();
    await vi.advanceTimersByTimeAsync(TYPING_KEEPALIVE_MS * 2);
    expect(sendTypingOn).not.toHaveBeenCalled();
  });
});
