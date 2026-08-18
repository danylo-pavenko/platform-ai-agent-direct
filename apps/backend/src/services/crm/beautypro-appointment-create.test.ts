import { describe, expect, it } from 'vitest';
import { buildBeautyproAppointmentCreateBody } from './beautypro-appointment.js';

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
    expect(services[1]?.service).toBe('svc-strengthen');
  });
});
