import pino from 'pino';
import { isSendTypingIndicatorEnabled } from '../lib/feature-flags.js';
import { markSeen, sendTypingOff, sendTypingOn } from './instagram.js';

const log = pino({ name: 'ig-typing-indicator' });

/** Re-send typing_on — Meta typically clears it after ~20s. */
export const TYPING_KEEPALIVE_MS = 15_000;

export interface IgTypingHandle {
  end(): Promise<void>;
}

const noopHandle: IgTypingHandle = {
  async end() {},
};

const activeByRecipient = new Map<string, IgTypingSession>();

class IgTypingSession implements IgTypingHandle {
  private interval: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly recipientId: string) {}

  async begin(): Promise<void> {
    activeByRecipient.set(this.recipientId, this);
    await this.fireAction('mark_seen', () => markSeen(this.recipientId));
    if (this.stopped) return;
    await this.fireTypingOn('typing_on');
    if (this.stopped) return;
    this.interval = setInterval(() => {
      void this.fireTypingOn('typing_on_keepalive');
    }, TYPING_KEEPALIVE_MS);
  }

  async stopBeforeSend(): Promise<void> {
    if (this.stopped) return;
    // Mark stopped first so any in-flight keepalive cannot re-assert typing
    // after we clear the indicator / send the reply.
    this.stopped = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (activeByRecipient.get(this.recipientId) === this) {
      activeByRecipient.delete(this.recipientId);
    }
    await this.fireAction('typing_off', () => sendTypingOff(this.recipientId));
  }

  async end(): Promise<void> {
    await this.stopBeforeSend();
  }

  /** Sync cleanup for tests — clears timers without awaiting Meta. */
  forceResetForTests(): void {
    this.stopped = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Send typing_on only while this session is still the active owner.
   * If a keepalive request finishes after stop/send, clear the stale
   * indicator — but never clobber a newer session for the same recipient.
   */
  private async fireTypingOn(label: string): Promise<void> {
    if (this.stopped || activeByRecipient.get(this.recipientId) !== this) {
      return;
    }
    try {
      await sendTypingOn(this.recipientId);
    } catch (err) {
      log.warn(
        { err, recipientId: this.recipientId, action: label },
        'IG sender action failed (non-fatal)',
      );
      return;
    }

    if (this.stopped && activeByRecipient.get(this.recipientId) == null) {
      try {
        await sendTypingOff(this.recipientId);
      } catch (err) {
        log.warn(
          { err, recipientId: this.recipientId, action: 'typing_off_after_stale_on' },
          'IG sender action failed (non-fatal)',
        );
      }
    }
  }

  private async fireAction(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      log.warn({ err, recipientId: this.recipientId, action: label }, 'IG sender action failed (non-fatal)');
    }
  }
}

/** Stop typing indicator before any outbound IG message to the same recipient. */
export async function stopIgTypingBeforeSend(recipientId: string): Promise<void> {
  const session = activeByRecipient.get(recipientId);
  if (session) {
    await session.stopBeforeSend();
  }
}

/**
 * Start mark_seen + typing_on for an IG conversation turn.
 * No-op when disabled, non-IG channel, or missing recipient id.
 */
export async function beginIgTypingIndicator(params: {
  channel: string;
  recipientId: string | null | undefined;
}): Promise<IgTypingHandle> {
  const { channel, recipientId } = params;
  if (channel !== 'ig' || !recipientId) return noopHandle;

  const enabled = await isSendTypingIndicatorEnabled();
  if (!enabled) return noopHandle;

  const existing = activeByRecipient.get(recipientId);
  if (existing) return existing;

  const session = new IgTypingSession(recipientId);
  await session.begin();
  return session;
}

/** Test helper — drop in-memory typing sessions. */
export function resetIgTypingSessionsForTests(): void {
  for (const session of activeByRecipient.values()) {
    session.forceResetForTests();
  }
  activeByRecipient.clear();
}
