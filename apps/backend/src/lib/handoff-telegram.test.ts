import { describe, expect, it } from 'vitest';
import { shouldNotifyHandoffFollowUp } from './handoff-telegram.js';
import type { WorkingHoursLike } from './working-time.js';

const WEEKDAYS: WorkingHoursLike = {
  mon: { start: '09:00', end: '18:00', enabled: true },
  tue: { start: '09:00', end: '18:00', enabled: true },
  wed: { start: '09:00', end: '18:00', enabled: true },
  thu: { start: '09:00', end: '18:00', enabled: true },
  fri: { start: '09:00', end: '18:00', enabled: true },
  sat: { start: '09:00', end: '18:00', enabled: false },
  sun: { start: '09:00', end: '18:00', enabled: false },
};

const TZ = 'Europe/Kyiv';
const waitStartedAt = new Date('2026-09-21T07:00:00.000Z'); // Mon 10:00 Kyiv

function input(
  now: Date,
  prior: Date[] = [],
  slaHours = 2,
): Parameters<typeof shouldNotifyHandoffFollowUp>[0] {
  return {
    waitStartedAt,
    now,
    slaHours,
    workingHours: WEEKDAYS,
    timeZone: TZ,
    priorClientInboundAt: prior,
  };
}

describe('shouldNotifyHandoffFollowUp', () => {
  it('skips while the client is still within SLA', () => {
    expect(
      shouldNotifyHandoffFollowUp(input(new Date('2026-09-21T08:30:00.000Z'))),
    ).toBe(false);
  });

  it('alerts once when working-time wait exceeds SLA', () => {
    expect(
      shouldNotifyHandoffFollowUp(input(new Date('2026-09-21T09:00:00.000Z'))),
    ).toBe(true);
  });

  it('does not forward a later bubble after the SLA ping already could have fired', () => {
    expect(
      shouldNotifyHandoffFollowUp(
        input(new Date('2026-09-21T10:00:00.000Z'), [
          new Date('2026-09-21T09:05:00.000Z'),
        ]),
      ),
    ).toBe(false);
  });

  it('still alerts if earlier inbound was within SLA', () => {
    expect(
      shouldNotifyHandoffFollowUp(
        input(new Date('2026-09-21T09:00:00.000Z'), [
          new Date('2026-09-21T07:10:00.000Z'),
        ]),
      ),
    ).toBe(true);
  });

  it('does not alert when SLA hours are disabled', () => {
    expect(
      shouldNotifyHandoffFollowUp(
        input(new Date('2026-09-21T12:00:00.000Z'), [], 0),
      ),
    ).toBe(false);
  });
});
