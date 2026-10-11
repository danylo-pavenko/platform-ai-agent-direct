import { describe, expect, it } from 'vitest';
import { AltegioClient, serializeAltegioQuery } from './altegio-http.js';
import {
  ALTEGIO_MONTH_HORIZON_DAYS,
  altegioSlotDateTo,
  altegioWebhookAllowed,
  selectAltegioStaff,
  sortSlotsByDate,
  buildCreateRecordBody,
  durationMinFromRaw,
  formatAltegioDatetime,
  mapAttendanceService,
  mapService,
  mergeAttendanceServices,
  mergeSlots,
  phonesMatch,
  planAltegioWebhook,
  uniqueStaffIds,
  visitWindow,
} from './altegio-map.js';

describe('Altegio slot horizon', () => {
  it('keeps a named day on that day and looks a month ahead for everyone', () => {
    expect(altegioSlotDateTo('2026-10-12', false)).toBe('2026-10-12');
    expect(ALTEGIO_MONTH_HORIZON_DAYS).toBeGreaterThanOrEqual(31);
    expect(altegioSlotDateTo('2026-10-12', true)).toBe('2026-11-12');
  });

  it('does not drop masters when the client has not chosen one', () => {
    const staff = Array.from({ length: 9 }, (_, index) => ({ id: String(index + 1) }));
    expect(selectAltegioStaff(staff).map((row) => row.id)).toEqual(
      staff.map((row) => row.id),
    );
    expect(selectAltegioStaff(staff, '4').map((row) => row.id)).toEqual(['4']);
  });

  it('orders days chronologically so the nearest month days stay first', () => {
    expect(Object.keys(sortSlotsByDate({
      '20.11.2026': [{ date: '20.11.2026', time: '10:00', masterIds: ['1'] }],
      '13.10.2026': [{ date: '13.10.2026', time: '11:00', masterIds: ['1'] }],
      '12.10.2026': [{ date: '12.10.2026', time: '09:00', masterIds: ['1'] }],
    }))).toEqual(['12.10.2026', '13.10.2026', '20.11.2026']);
  });
});

describe('Altegio query encoding', () => {
  it('keeps array brackets literal', () => {
    const qs = serializeAltegioQuery({
      staff_id: 7,
      service_ids: ['10', '11'],
      empty: '',
    });
    expect(qs).toBe('staff_id=7&service_ids[]=10&service_ids[]=11');
    expect(serializeAltegioQuery({ include: ['services', 'staff'] })).toBe(
      'include=services&include=staff',
    );
  });
});

describe('Altegio datetime', () => {
  it('uses the Kyiv winter offset', () => {
    expect(formatAltegioDatetime('2026-01-15', '10:00', 'Europe/Kyiv')).toBe(
      '2026-01-15T10:00:00.000+02:00',
    );
  });

  it('uses the Kyiv summer offset', () => {
    expect(formatAltegioDatetime('2026-07-15', '10:30', 'Europe/Kyiv')).toBe(
      '2026-07-15T10:30:00.000+03:00',
    );
  });
});

describe('Altegio catalog mapping', () => {
  it('treats seance_length as seconds and price_min as the client price', () => {
    const service = mapService(
      { id: 15, title: 'Стрижка', price_min: 700, seance_length: 3600 },
      '42',
    );
    expect(service).toMatchObject({
      id: '15',
      name: 'Стрижка',
      price: 700,
      durationMin: 60,
      seanceSec: 3600,
    });
    expect(durationMinFromRaw({ duration: 90 })).toEqual({ min: 90, sec: 5400 });
  });

  it('reads B2B v2 attendance services and keeps the lower price', () => {
    const cut = mapAttendanceService(
      {
        type: 'attendance_service',
        id: '15:7',
        attributes: { service_id: 15, title: 'Стрижка', duration: 3600, price_min: 800 },
      },
      '42',
    );
    const cheaper = mapAttendanceService(
      {
        type: 'attendance_service',
        id: '15:8',
        attributes: { service_id: 15, title: 'Стрижка', duration: 3600, price_min: 500 },
      },
      '42',
    );
    expect(mergeAttendanceServices([cut!, cheaper!])).toEqual([
      expect.objectContaining({ id: '15', name: 'Стрижка', price: 500, durationMin: 60 }),
    ]);
  });

  it('merges the same clock time across masters', () => {
    const slots = mergeSlots([
      { dateIso: '2026-10-11', time: '10:00', staffId: '1' },
      { dateIso: '2026-10-11', time: '10:00', staffId: '2' },
      { dateIso: '2026-10-11', time: '11:00', staffId: '1' },
    ]);
    expect(slots['11.10.2026']).toEqual([
      { date: '11.10.2026', time: '10:00', masterIds: ['1', '2'] },
      { date: '11.10.2026', time: '11:00', masterIds: ['1'] },
    ]);
  });
});

describe('Altegio booking payload', () => {
  it('builds one record for one master and refuses a split', () => {
    expect(uniqueStaffIds(['7', '7', undefined])).toEqual(['7']);
    expect(uniqueStaffIds(['7', '8'])).toEqual(['7', '8']);
    expect(visitWindow([
      { startTime: '10:00', durationMin: 60 },
      { startTime: '11:00', durationMin: 30 },
    ])).toEqual({ start: '10:00', seconds: 90 * 60 });

    const body = buildCreateRecordBody({
      staffId: 7,
      services: [{ id: 15, cost: 700, seanceSec: 3600 }],
      client: { phone: '+380501112233', name: 'Оля', id: 9 },
      datetime: '2026-10-11T10:00:00.000+03:00',
      comment: 'IG',
      saveIfBusy: false,
      seanceSec: 3600,
      apiId: 'platform_1',
    });
    expect(body).toMatchObject({
      staff_id: 7,
      save_if_busy: false,
      send_sms: false,
      seance_length: 3600,
      client: { id: 9, name: 'Оля' },
    });
  });

  it('matches phone tails', () => {
    expect(phonesMatch('+380501112233', '0501112233')).toBe(true);
    expect(phonesMatch('0501112233', '0509998877')).toBe(false);
  });
});

describe('Altegio HTTP client', () => {
  it('sends partner and user tokens and rejects success:false', async () => {
    const seen: { url?: string; authorization?: string; accept?: string } = {};
    const client = new AltegioClient(
      { partnerToken: 'partner-secret', userToken: 'user-secret' },
      async (url, init) => {
        seen.url = url;
        const headers = init?.headers as Record<string, string>;
        seen.authorization = headers.Authorization;
        seen.accept = headers.Accept;
        return new Response(JSON.stringify({ success: true, data: { id: 42, title: 'Salon' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );
    const json = await client.b2bGet<{ data: { title: string } }>('locations/42/team_members');
    expect(json.data.title).toBe('Salon');
    expect(seen.url).toBe('https://api.alteg.io/api/v2/locations/42/team_members');
    expect(seen.authorization).toBe('Bearer partner-secret, User user-secret');
    expect(seen.accept).toBe('application/vnd.api.v2+json');

    const failing = new AltegioClient(
      { partnerToken: 'partner-secret', userToken: 'user-secret' },
      async () =>
        new Response(JSON.stringify({ success: false, meta: { message: 'bad partner-secret' } }), {
          status: 401,
        }),
    );
    await expect(failing.get('company/42')).rejects.toThrow(/\[token\]/);
    await expect(failing.get('company/42')).rejects.not.toThrow(/partner-secret/);
  });
});

describe('Altegio webhooks', () => {
  it('plans record delete and update from resource+status', () => {
    expect(
      planAltegioWebhook({
        company_id: 42,
        resource: 'record',
        status: 'delete',
        data: { id: 99 },
      }),
    ).toEqual({ action: 'cancel_record', recordId: '99', companyId: '42' });

    expect(
      planAltegioWebhook({
        event: 'record.updated',
        salon_id: 42,
        data: { id: 99, datetime: '2026-10-12T15:30:00+03:00' },
      }),
    ).toMatchObject({
      action: 'update_record',
      recordId: '99',
      companyId: '42',
      dateUa: '12.10.2026',
      time: '15:30',
    });

    expect(planAltegioWebhook({ event: 'install' })).toEqual({
      action: 'ignore',
      reason: 'install',
    });
  });

  it('requires the webhook secret when one is saved', () => {
    expect(
      altegioWebhookAllowed({
        presentedSecret: 'hook',
        savedPartnerToken: 'partner',
        savedWebhookSecret: 'hook',
      }).ok,
    ).toBe(true);
    expect(
      altegioWebhookAllowed({
        bodyPartnerToken: 'partner',
        savedPartnerToken: 'partner',
        savedWebhookSecret: '',
      }).ok,
    ).toBe(true);
    expect(
      altegioWebhookAllowed({
        savedPartnerToken: 'partner',
        savedWebhookSecret: '',
      }).ok,
    ).toBe(false);
  });
});
