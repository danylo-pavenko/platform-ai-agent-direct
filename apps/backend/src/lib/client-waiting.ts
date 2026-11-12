/**
 * Clients waiting for a salon reply: last visible message is from the client
 * on an open conversation.
 */
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from './prisma.js';
import { getAgentConfig } from './agent-config.js';
import { getWorkingHours } from '../services/prompt-builder.js';
import { elapsedWorkingMs } from './working-time.js';

export type ClientWaitingFilter = 'reply' | 'long';

export type WaitingClientRow = {
  clientId: string;
  conversationId: string;
  waitingSince: Date;
};

type RawWaitingRow = {
  client_id: string;
  conversation_id: string;
  waiting_since: Date;
  last_sender: string;
};

/**
 * Open threads where the latest client/bot/manager message is from the client.
 * One row per client (most recent waiting conversation).
 */
export async function findClientsAwaitingReply(): Promise<WaitingClientRow[]> {
  const rows = await prisma.$queryRaw<RawWaitingRow[]>`
    SELECT sub.client_id, sub.conversation_id, sub.waiting_since, sub.last_sender
    FROM (
      SELECT DISTINCT ON (c.client_id)
        c.client_id,
        c.id AS conversation_id,
        m.created_at AS waiting_since,
        m.sender::text AS last_sender
      FROM conversations c
      INNER JOIN messages m
        ON m.conversation_id = c.id
        AND m.sender IN ('client', 'bot', 'manager')
        AND m.direction IN ('in', 'out')
      WHERE c.state <> 'closed'
      ORDER BY c.client_id, m.created_at DESC
    ) sub
    WHERE sub.last_sender = 'client'
    ORDER BY sub.waiting_since DESC
  `;

  return rows.map((r) => ({
    clientId: r.client_id,
    conversationId: r.conversation_id,
    waitingSince: new Date(r.waiting_since),
  }));
}

export async function filterWaitingBySla(
  rows: WaitingClientRow[],
  mode: ClientWaitingFilter,
): Promise<WaitingClientRow[]> {
  if (mode === 'reply') return rows;

  const [agentCfg, hours] = await Promise.all([getAgentConfig(), getWorkingHours()]);
  const slaHours = agentCfg.managerSlaHoursBusiness;
  if (!(slaHours > 0)) return rows;

  const slaMs = slaHours * 60 * 60 * 1000;
  const now = new Date();
  return rows.filter((row) => {
    const elapsed = elapsedWorkingMs(
      row.waitingSince,
      now,
      hours,
      agentCfg.timezone,
    );
    return elapsed >= slaMs;
  });
}

export async function resolveWaitingClientIds(
  waiting: ClientWaitingFilter | undefined,
): Promise<{ ids: string[] | null; waitingMeta: Map<string, WaitingClientRow> }> {
  if (!waiting) {
    return { ids: null, waitingMeta: new Map() };
  }
  const all = await findClientsAwaitingReply();
  const filtered = await filterWaitingBySla(all, waiting);
  const waitingMeta = new Map(filtered.map((r) => [r.clientId, r]));
  return { ids: filtered.map((r) => r.clientId), waitingMeta };
}

/** Merge search + waiting id filter into a Prisma where. */
export function mergeClientWhereWithWaitingIds(
  base: Prisma.ClientWhereInput | undefined,
  waitingIds: string[] | null,
): Prisma.ClientWhereInput | undefined {
  if (waitingIds === null) return base;
  if (waitingIds.length === 0) {
    return { id: { in: [] } };
  }
  if (!base || Object.keys(base).length === 0) {
    return { id: { in: waitingIds } };
  }
  return { AND: [base, { id: { in: waitingIds } }] };
}
