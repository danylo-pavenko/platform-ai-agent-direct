import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import {
  CLAUDE_HISTORY_FETCH_CAP,
  CLAUDE_HISTORY_SAFETY_CAP,
  resolveClaudeHistoryWindow,
  type ClaudeHistoryWindow,
} from '../lib/claude-history-window.js';
import { dedupeConversationMessages } from '../lib/message-dedupe.js';
import type { HistoryMessageRow } from '../lib/conversation-history.js';

const log = pino({ name: 'claude-history-load' });

const CLAUDE_HISTORY_SELECT = {
  id: true,
  direction: true,
  text: true,
  sender: true,
  createdAt: true,
  igMessageId: true,
  igContext: true,
} as const;

export type ClaudeHistoryLoadMeta = ClaudeHistoryWindow & {
  fetched: number;
  used: number;
};

async function loadCycleMarkers(conversationId: string): Promise<Array<{ at: Date }>> {
  const [orders, appointments] = await Promise.all([
    prisma.order.findMany({
      where: {
        conversationId,
        isArchived: false,
        kind: { not: 'booking' },
        status: { in: ['submitted', 'confirmed'] },
      },
      select: { createdAt: true, submittedToManagerAt: true },
    }),
    prisma.appointment.findMany({
      where: {
        conversationId,
        status: { in: ['confirmed', 'synced'] },
        crmSyncStatus: { in: ['synced', 'skipped'] },
      },
      select: { createdAt: true, crmSyncedAt: true },
    }),
  ]);

  const markers: Array<{ at: Date }> = [];
  for (const row of orders) {
    markers.push({ at: row.submittedToManagerAt ?? row.createdAt });
  }
  for (const row of appointments) {
    markers.push({ at: row.crmSyncedAt ?? row.createdAt });
  }
  return markers;
}

export async function resolveConversationClaudeHistoryWindow(params: {
  conversationId: string;
  conversationCreatedAt: Date;
  timeZone: string;
  now?: Date;
}): Promise<ClaudeHistoryWindow> {
  const now = params.now ?? new Date();
  const cycleMarkers = await loadCycleMarkers(params.conversationId);
  return resolveClaudeHistoryWindow({
    now,
    timeZone: params.timeZone,
    conversationCreatedAt: params.conversationCreatedAt,
    cycleMarkers,
  });
}

/**
 * Messages for Claude: tenant civil day of this conversation, or after the
 * last completed order/visit today. Safety cap is not a second 30-cut.
 */
export async function loadClaudeHistoryMessages(params: {
  conversationId: string;
  conversationCreatedAt: Date;
  timeZone: string;
  now?: Date;
}): Promise<{ rows: HistoryMessageRow[]; meta: ClaudeHistoryLoadMeta }> {
  const window = await resolveConversationClaudeHistoryWindow(params);
  const raw = await prisma.message.findMany({
    where: {
      conversationId: params.conversationId,
      createdAt: window.inclusive ? { gte: window.from } : { gt: window.from },
      sender: { in: ['client', 'bot', 'manager'] },
    },
    orderBy: { createdAt: 'desc' },
    take: CLAUDE_HISTORY_FETCH_CAP,
    select: CLAUDE_HISTORY_SELECT,
  });

  const withText = raw.filter((m) => typeof m.text === 'string' && m.text.trim().length > 0);
  const capped = withText.slice(0, CLAUDE_HISTORY_SAFETY_CAP);
  const rows = dedupeConversationMessages([...capped].reverse());

  const meta: ClaudeHistoryLoadMeta = {
    ...window,
    fetched: raw.length,
    used: rows.length,
  };
  log.info(
    {
      conversationId: params.conversationId,
      reason: meta.reason,
      inclusive: meta.inclusive,
      from: meta.from.toISOString(),
      fetched: meta.fetched,
      used: meta.used,
    },
    'Claude history window loaded',
  );
  return { rows, meta };
}
