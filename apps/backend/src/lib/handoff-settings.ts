import { prisma } from './prisma.js';

export const DEFAULT_HANDOFF_RETURN_TO_BOT_MINUTES = 60;

/**
 * Minutes of manager handoff idle time after which the bot resumes on the
 * next client message. `0` disables auto-return.
 */
export async function getHandoffReturnToBotMinutes(): Promise<number> {
  const row = await prisma.setting.findUnique({
    where: { key: 'handoff_return_to_bot_minutes' },
  });
  const v = row?.value;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
    return Math.floor(v);
  }
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    return parseInt(v.trim(), 10);
  }
  return DEFAULT_HANDOFF_RETURN_TO_BOT_MINUTES;
}
