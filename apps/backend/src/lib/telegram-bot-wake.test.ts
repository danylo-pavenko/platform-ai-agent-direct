import { describe, expect, it } from 'vitest';
import {
  resolveTelegramBotIdlePollMs,
  TELEGRAM_BOT_IDLE_POLL_MS,
  TELEGRAM_BOT_WAKE_POLL_MS,
  TELEGRAM_BOT_WAKE_WINDOW_MS,
} from './telegram-bot-wake.js';

describe('resolveTelegramBotIdlePollMs', () => {
  const now = 1_700_000_000_000;

  it('uses slow poll when no wake signal', () => {
    expect(resolveTelegramBotIdlePollMs(0, 0, now)).toBe(TELEGRAM_BOT_IDLE_POLL_MS);
  });

  it('uses fast poll after a new wake within the window', () => {
    const wakeAt = now - 5_000;
    expect(resolveTelegramBotIdlePollMs(wakeAt, 0, now)).toBe(TELEGRAM_BOT_WAKE_POLL_MS);
  });

  it('uses slow poll when wake was already seen', () => {
    const wakeAt = now - 5_000;
    expect(resolveTelegramBotIdlePollMs(wakeAt, wakeAt, now)).toBe(TELEGRAM_BOT_IDLE_POLL_MS);
  });

  it('uses slow poll when wake is outside the window', () => {
    const wakeAt = now - TELEGRAM_BOT_WAKE_WINDOW_MS - 1;
    expect(resolveTelegramBotIdlePollMs(wakeAt, 0, now)).toBe(TELEGRAM_BOT_IDLE_POLL_MS);
  });
});
