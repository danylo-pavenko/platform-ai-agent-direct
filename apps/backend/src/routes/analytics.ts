import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

const PERIODS = ['24h', '7d', '30d', '90d', 'all'] as const;
type Period = (typeof PERIODS)[number];

function parsePeriod(q: string | undefined): Period {
  const v = (q ?? '7d').toLowerCase();
  return PERIODS.includes(v as Period) ? (v as Period) : '7d';
}

function periodStart(period: Period): Date | null {
  if (period === 'all') return null;
  const now = Date.now();
  const day = 86400000;
  switch (period) {
    case '24h':
      return new Date(now - day);
    case '7d':
      return new Date(now - 7 * day);
    case '30d':
      return new Date(now - 30 * day);
    case '90d':
      return new Date(now - 90 * day);
    default:
      return new Date(now - 7 * day);
  }
}

// ── Types for raw query rows ─────────────────────────────────────────

type AgentChannelValue = 'ig' | 'tg' | 'sandbox' | 'meta_agent' | 'supervisor';

type TotalsRow = {
  total: bigint;
  successes: bigint;
  busy: bigint;
  timeout: bigint;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  avg: number | null;
};

type ByChannelRow = {
  channel: AgentChannelValue;
  total: bigint;
  successes: bigint;
  p50: number | null;
  p95: number | null;
};

type ByDayRow = {
  day: Date;
  total: bigint;
  successes: bigint;
  p50: number | null;
  p95: number | null;
};

type TtfrTotalsRow = {
  samples: bigint;
  p50: number | null;
  p95: number | null;
  avg: number | null;
};

type TtfrByDayRow = {
  day: Date;
  samples: bigint;
  p50: number | null;
};

// ── Handler ──────────────────────────────────────────────────────────

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { period?: string };
  }>('/agent', { onRequest: [app.authenticate] }, async (request) => {
    const period = parsePeriod(request.query.period);
    const from = periodStart(period);
    const now = new Date();

    // Totals + latency percentiles (success-only for latency to avoid
    // fallbacks skewing the picture — a canned reply is near-zero ms and
    // would artificially lower p50).
    const totalsRows = from
      ? await prisma.$queryRaw<TotalsRow[]>`
          SELECT
            COUNT(*)::bigint AS total,
            COUNT(*) FILTER (WHERE success)::bigint AS successes,
            COUNT(*) FILTER (WHERE fallback_reason = 'busy')::bigint AS busy,
            COUNT(*) FILTER (WHERE fallback_reason = 'timeout')::bigint AS timeout,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE success) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE success) AS p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE success) AS p99,
            AVG(duration_ms) FILTER (WHERE success) AS avg
          FROM agent_invocations
          WHERE started_at >= ${from}
        `
      : await prisma.$queryRaw<TotalsRow[]>`
          SELECT
            COUNT(*)::bigint AS total,
            COUNT(*) FILTER (WHERE success)::bigint AS successes,
            COUNT(*) FILTER (WHERE fallback_reason = 'busy')::bigint AS busy,
            COUNT(*) FILTER (WHERE fallback_reason = 'timeout')::bigint AS timeout,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE success) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE success) AS p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE success) AS p99,
            AVG(duration_ms) FILTER (WHERE success) AS avg
          FROM agent_invocations
        `;

    const totals = totalsRows[0] ?? {
      total: 0n,
      successes: 0n,
      busy: 0n,
      timeout: 0n,
      p50: null,
      p95: null,
      p99: null,
      avg: null,
    };

    // Per-channel breakdown — useful for spotting one bad surface
    // (e.g. supervisor suddenly failing while IG stays healthy).
    const byChannelRows = from
      ? await prisma.$queryRaw<ByChannelRow[]>`
          SELECT
            channel::text AS channel,
            COUNT(*)::bigint AS total,
            COUNT(*) FILTER (WHERE success)::bigint AS successes,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE success) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE success) AS p95
          FROM agent_invocations
          WHERE started_at >= ${from}
          GROUP BY channel
          ORDER BY total DESC
        `
      : await prisma.$queryRaw<ByChannelRow[]>`
          SELECT
            channel::text AS channel,
            COUNT(*)::bigint AS total,
            COUNT(*) FILTER (WHERE success)::bigint AS successes,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE success) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE success) AS p95
          FROM agent_invocations
          GROUP BY channel
          ORDER BY total DESC
        `;

    // Daily sparkline window — same rule as dashboard: a sensible
    // fixed window tied to the selected period, falling back to 90 days.
    const seriesDays =
      period === 'all' ? 90 : period === '24h' ? 2 : period === '7d' ? 7 : period === '30d' ? 30 : 90;
    const seriesFrom = new Date(now.getTime() - seriesDays * 86400000);

    const byDayRows = await prisma.$queryRaw<ByDayRow[]>`
      SELECT
        date_trunc('day', started_at AT TIME ZONE 'UTC') AS day,
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE success)::bigint AS successes,
        percentile_cont(0.5)  WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE success) AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE success) AS p95
      FROM agent_invocations
      WHERE started_at >= ${seriesFrom}
      GROUP BY 1
      ORDER BY 1 ASC
    `;

    const total = Number(totals.total);
    const successes = Number(totals.successes);
    const successRate = total > 0 ? successes / total : null;

    return {
      period,
      from: from?.toISOString() ?? null,
      to: now.toISOString(),
      totals: {
        total,
        successes,
        failures: total - successes,
        busy: Number(totals.busy),
        timeout: Number(totals.timeout),
        successRate,
        latencyMs: {
          p50: totals.p50 !== null ? Math.round(totals.p50) : null,
          p95: totals.p95 !== null ? Math.round(totals.p95) : null,
          p99: totals.p99 !== null ? Math.round(totals.p99) : null,
          avg: totals.avg !== null ? Math.round(totals.avg) : null,
        },
      },
      byChannel: byChannelRows.map((r) => {
        const t = Number(r.total);
        const s = Number(r.successes);
        return {
          channel: r.channel,
          total: t,
          successes: s,
          successRate: t > 0 ? s / t : null,
          latencyMs: {
            p50: r.p50 !== null ? Math.round(r.p50) : null,
            p95: r.p95 !== null ? Math.round(r.p95) : null,
          },
        };
      }),
      series: byDayRows.map((r) => {
        const t = Number(r.total);
        const s = Number(r.successes);
        return {
          date: (r.day instanceof Date ? r.day : new Date(r.day)).toISOString().slice(0, 10),
          total: t,
          successes: s,
          successRate: t > 0 ? s / t : null,
          latencyMs: {
            p50: r.p50 !== null ? Math.round(r.p50) : null,
            p95: r.p95 !== null ? Math.round(r.p95) : null,
          },
        };
      }),
    };
  });

  // ── /analytics/ttfr — time-to-first-response KPI (B.4) ────────────────
  //
  // Samples a conversation only if both `first_inbound_at` and
  // `first_outbound_at` are set and the outbound is after the inbound
  // (defensive — historic rows or data-migration anomalies otherwise
  // produce negative deltas). Reports median / p95 / average seconds.
  app.get<{
    Querystring: { period?: string };
  }>('/ttfr', { onRequest: [app.authenticate] }, async (request) => {
    const period = parsePeriod(request.query.period);
    const from = periodStart(period);
    const now = new Date();

    const totalsRows = from
      ? await prisma.$queryRaw<TtfrTotalsRow[]>`
          SELECT
            COUNT(*)::bigint AS samples,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_outbound_at - first_inbound_at))) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_outbound_at - first_inbound_at))) AS p95,
            AVG(EXTRACT(EPOCH FROM (first_outbound_at - first_inbound_at))) AS avg
          FROM conversations
          WHERE first_inbound_at IS NOT NULL
            AND first_outbound_at IS NOT NULL
            AND first_outbound_at > first_inbound_at
            AND first_inbound_at >= ${from}
        `
      : await prisma.$queryRaw<TtfrTotalsRow[]>`
          SELECT
            COUNT(*)::bigint AS samples,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_outbound_at - first_inbound_at))) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_outbound_at - first_inbound_at))) AS p95,
            AVG(EXTRACT(EPOCH FROM (first_outbound_at - first_inbound_at))) AS avg
          FROM conversations
          WHERE first_inbound_at IS NOT NULL
            AND first_outbound_at IS NOT NULL
            AND first_outbound_at > first_inbound_at
        `;

    const totals = totalsRows[0] ?? { samples: 0n, p50: null, p95: null, avg: null };

    const seriesDays =
      period === 'all' ? 90 : period === '24h' ? 2 : period === '7d' ? 7 : period === '30d' ? 30 : 90;
    const seriesFrom = new Date(now.getTime() - seriesDays * 86400000);

    const byDayRows = await prisma.$queryRaw<TtfrByDayRow[]>`
      SELECT
        date_trunc('day', first_inbound_at AT TIME ZONE 'UTC') AS day,
        COUNT(*)::bigint AS samples,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_outbound_at - first_inbound_at))) AS p50
      FROM conversations
      WHERE first_inbound_at IS NOT NULL
        AND first_outbound_at IS NOT NULL
        AND first_outbound_at > first_inbound_at
        AND first_inbound_at >= ${seriesFrom}
      GROUP BY 1
      ORDER BY 1 ASC
    `;

    return {
      period,
      from: from?.toISOString() ?? null,
      to: now.toISOString(),
      totals: {
        samples: Number(totals.samples),
        seconds: {
          p50: totals.p50 !== null ? Math.round(totals.p50) : null,
          p95: totals.p95 !== null ? Math.round(totals.p95) : null,
          avg: totals.avg !== null ? Math.round(totals.avg) : null,
        },
      },
      series: byDayRows.map((r) => ({
        date: (r.day instanceof Date ? r.day : new Date(r.day)).toISOString().slice(0, 10),
        samples: Number(r.samples),
        seconds: {
          p50: r.p50 !== null ? Math.round(r.p50) : null,
        },
      })),
    };
  });
}
