import { mkdir, readFile, writeFile, utimes, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  addCivilDays,
  filterJsonlByRetention,
  msUntilNextLocalHour,
  purgeTenantLogs,
} from './log-retention.js';

describe('log-retention', () => {
  it('filters jsonl by at timestamp', () => {
    const now = Date.parse('2026-09-07T12:00:00.000Z');
    const cutoff = now - 7 * 24 * 3600_000;
    const content = [
      JSON.stringify({ at: '2026-08-20T10:00:00.000Z', method: 'GET', path: '/old' }),
      JSON.stringify({ at: '2026-09-06T10:00:00.000Z', method: 'POST', path: '/new' }),
      'not-json',
      '',
    ].join('\n');
    const { kept, keptCount, droppedCount } = filterJsonlByRetention(content, cutoff);
    expect(keptCount).toBe(1);
    expect(droppedCount).toBe(2);
    expect(kept).toContain('/new');
    expect(kept).not.toContain('/old');
  });

  it('computes ms until next local evening hour', () => {
    // 2026-09-07 16:00 Kyiv = 13:00 UTC → next 23:00 Kyiv is same day (20:00 UTC)
    const now = new Date('2026-09-07T13:00:00.000Z');
    const ms = msUntilNextLocalHour(now, 23, 'Europe/Kyiv');
    expect(ms).toBe(7 * 3600_000);
  });

  it('addCivilDays rolls month', () => {
    expect(addCivilDays(2026, 9, 30, 1)).toEqual({ year: 2026, month: 10, day: 1 });
  });

  it('purges old files and rewrites jsonl', async () => {
    const dir = join(tmpdir(), `log-retention-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const now = new Date('2026-09-07T12:00:00.000Z');

    const jsonl = join(dir, 'beautypro-api.jsonl');
    await writeFile(
      jsonl,
      [
        JSON.stringify({ at: '2026-08-01T00:00:00.000Z', path: '/old' }),
        JSON.stringify({ at: '2026-09-05T00:00:00.000Z', path: '/keep' }),
      ].join('\n') + '\n',
      'utf8',
    );

    const stale = join(dir, 'stale.txt');
    await writeFile(stale, 'x', 'utf8');
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 3600_000);
    await utimes(stale, eightDaysAgo, eightDaysAgo);

    const fresh = join(dir, 'fresh.txt');
    await writeFile(fresh, 'y', 'utf8');
    await utimes(fresh, now, now);

    const result = await purgeTenantLogs({ logsDir: dir, retentionDays: 7, now });
    expect(result.deletedFiles).toContain('stale.txt');
    expect(result.deletedFiles).not.toContain('fresh.txt');
    expect(result.rewrittenFiles.some((r) => r.file === 'beautypro-api.jsonl')).toBe(true);

    const kept = await readFile(jsonl, 'utf8');
    expect(kept).toContain('/keep');
    expect(kept).not.toContain('/old');
    await expect(stat(fresh)).resolves.toBeTruthy();
  });
});
