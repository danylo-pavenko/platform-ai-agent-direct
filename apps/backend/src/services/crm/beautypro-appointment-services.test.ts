import { describe, expect, it } from 'vitest';
import {
  buildBeautyproServiceDeleteBody,
  matchBeautyproServiceLine,
  parseBeautyproAppointmentServices,
} from './beautypro-appointment-services.js';

describe('beautypro-appointment-services', () => {
  it('parses service lines from appointment payload', () => {
    const rows = parseBeautyproAppointmentServices({
      services: [
        {
          id: 'line-1',
          service: 'svc-mani',
          serviceName: 'Манікюр',
          start: '10:00:00',
          duration: 115,
          professional: 'pro-1',
        },
        {
          id: 'line-2',
          service: 'svc-pedi',
          serviceName: 'Педикюр',
          start: '10:00:00',
          duration: 90,
          professional: 'pro-2',
        },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      lineId: 'line-1',
      serviceId: 'svc-mani',
      serviceName: 'Манікюр',
      durationMin: 115,
    });
  });

  it('matches by catalog id then by unique name', () => {
    const rows = parseBeautyproAppointmentServices([
      { id: 'l1', service: 'svc-a', serviceName: 'Комплекс манікюр' },
      { id: 'l2', service: 'svc-b', serviceName: 'Брови' },
    ]);
    expect(matchBeautyproServiceLine(rows, { serviceCatalogId: 'svc-b' })?.lineId).toBe('l2');
    expect(matchBeautyproServiceLine(rows, { serviceName: 'брови' })?.lineId).toBe('l2');
    expect(matchBeautyproServiceLine(rows, { serviceName: 'немає' })).toBeNull();
  });

  it('builds delete body with action=delete', () => {
    expect(buildBeautyproServiceDeleteBody('line-9')).toEqual({
      services: [{ id: 'line-9', action: 'delete' }],
    });
  });
});
