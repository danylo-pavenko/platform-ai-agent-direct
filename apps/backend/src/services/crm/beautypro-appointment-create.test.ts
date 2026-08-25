import { describe, expect, it } from 'vitest';
import { buildBeautyproAppointmentCreateBody, buildBeautyproAppointmentAppendServicesBody, isBeautyproTimeConflictError, pickSameDayAppointmentId } from './beautypro-appointment.js';

describe('buildBeautyproAppointmentCreateBody', () => {
  const body = buildBeautyproAppointmentCreateBody({
    isoDate: '2026-08-21',
    locationId: 'loc-1',
    clientId: 'client-1',
    comment: 'Брови паралельно',
    professional: 'master-1',
    start: '12:00:00',
    services: [
      { id: 'svc-manicure', durationMin: 115, masterId: 'master-1', startTime: '12:00' },
      { id: 'svc-strengthen', durationMin: 30, masterId: 'master-1' },
    ],
  });

  it('never sends appointment or line-item id (BeautyPro generates them)', () => {
    expect(body).not.toHaveProperty('id');
    const services = body.services as Array<Record<string, unknown>>;
    expect(services.every((row) => !('id' in row))).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/"id"/);
  });

  it('maps local service UUID onto the `service` field', () => {
    const services = body.services as Array<Record<string, unknown>>;
    expect(services[0]).toMatchObject({
      service: 'svc-manicure',
      professional: 'master-1',
      start: '12:00:00',
      duration: 115,
    });
    expect(services[1]).toMatchObject({
      service: 'svc-strengthen',
      professional: 'master-1',
      start: '13:55:00',
      duration: 30,
    });
  });

  it('puts visit notes on appointment comments, not client comment', () => {
    expect(body.comments).toBe('Брови паралельно');
    expect(body).not.toHaveProperty('comment');
  });

  it('keeps parallel starts when professionals differ', () => {
    const parallel = buildBeautyproAppointmentCreateBody({
      isoDate: '2026-08-21',
      locationId: 'loc-1',
      clientId: 'client-1',
      professional: 'master-1',
      start: '12:00',
      services: [
        { id: 'svc-nails', durationMin: 60, masterId: 'master-1' },
        { id: 'svc-brows', durationMin: 30, masterId: 'master-2' },
      ],
    });
    const services = parallel.services as Array<Record<string, unknown>>;
    expect(services[0]?.start).toBe('12:00:00');
    expect(services[1]?.start).toBe('12:00:00');
  });

  it('honors explicit per-service start_time for staggered masters', () => {
    const staggered = buildBeautyproAppointmentCreateBody({
      isoDate: '2026-08-26',
      locationId: 'loc-1',
      clientId: 'client-1',
      professional: 'master-1',
      start: '10:30',
      services: [
        { id: 'svc-tips', durationMin: 30, masterId: 'master-maxim', startTime: '10:30' },
        { id: 'svc-mani', durationMin: 115, masterId: 'master-alina', startTime: '11:00' },
      ],
    });
    const services = staggered.services as Array<Record<string, unknown>>;
    expect(services[0]).toMatchObject({
      service: 'svc-tips',
      professional: 'master-maxim',
      start: '10:30:00',
      duration: 30,
    });
    expect(services[1]).toMatchObject({
      service: 'svc-mani',
      professional: 'master-alina',
      start: '11:00:00',
      duration: 115,
    });
  });

  it('detects TIME_CONFLICT and picks the client visit on that day', () => {
    expect(
      isBeautyproTimeConflictError(
        new Error('BeautyPro POST /appointments HTTP 409: {"type":"TIME_CONFLICT","error":409004}'),
      ),
    ).toBe(true);
    expect(isBeautyproTimeConflictError(new Error('Unknown parameter id'))).toBe(false);
    expect(
      pickSameDayAppointmentId(
        [
          { id: 'other-day', date: '2026-08-20', location: 'loc-1', client: 'client-1' },
          { id: 'hit', date: '2026-08-21T00:00:00.000Z', location: 'loc-1', client: 'client-1' },
        ],
        { isoDate: '2026-08-21', locationId: 'loc-1', clientId: 'client-1' },
      ),
    ).toBe('hit');
  });

  it('builds PUT append body with action=insert for new rows only', () => {
    const body = buildBeautyproAppointmentAppendServicesBody({
      professional: 'master-1',
      start: '12:00',
      previousServiceCount: 1,
      allServices: [
        { id: 'svc-manicure', durationMin: 115, masterId: 'master-1' },
        { id: 'svc-brows', durationMin: 30, masterId: 'master-2' },
      ],
    });
    const services = body.services as Array<Record<string, unknown>>;
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({
      action: 'insert',
      service: 'svc-brows',
      professional: 'master-2',
      start: '12:00:00',
      duration: 30,
    });
  });
});
