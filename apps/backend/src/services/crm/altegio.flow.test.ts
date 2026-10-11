import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatAgentToolsPrompt } from '../../lib/agent-tools-prompt.js';
import { evaluateMasterFreeTimeStatus } from '../../lib/beautypro-schedule-guard.js';
import { buildAgentTools } from '../../lib/tool-definitions.js';

vi.mock('../../lib/integration-config.js', () => ({
  getIntegrationConfig: vi.fn(async () => ({
    altegio: {
      partnerToken: 'partner-token',
      userToken: 'user-token',
      locationId: '42',
      webhookSecret: '',
      syncIntervalMin: 60,
    },
  })),
}));

vi.mock('../../lib/agent-config.js', () => ({
  getAgentConfig: vi.fn(async () => ({ timezone: 'Europe/Kyiv' })),
}));

type Mode = 'open' | 'closed' | 'busy';

const calls: Array<{ url: string; method: string; body: string }> = [];
let mode: Mode = 'open';
let recordServiceIds = [15, 16];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function route(url: string, method: string, body: string): Response {
  if (url.includes('/api/v2/locations/42/team_members')) {
    return json({
      data: [
        {
          type: 'team_member',
          id: '7',
          attributes: { name: 'Олена', specialization: 'Топ' },
        },
        {
          type: 'team_member',
          id: '8',
          attributes: { name: 'Іра', specialization: 'Майстер' },
        },
      ],
      included: [{ type: 'position', id: '1', attributes: { title: 'Перукар' } }],
    });
  }
  if (url.includes('/api/v2/locations/42/attendance_services')) {
    return json({
      data: [
        {
          type: 'attendance_service',
          id: '15:7',
          attributes: { service_id: 15, title: 'Стрижка', duration: 3600, price_min: 800 },
        },
        {
          type: 'attendance_service',
          id: '15:8',
          attributes: { service_id: 15, title: 'Стрижка', duration: 3600, price_min: 500 },
        },
        {
          type: 'attendance_service',
          id: '16:7',
          attributes: { service_id: 16, title: 'Укладка', duration: 1800, price_min: 300 },
        },
      ],
    });
  }
  if (url.includes('/api/v2/locations/42/appointments/') && method === 'DELETE') {
    return new Response(null, { status: 204 });
  }
  if (url.includes('/api/v2/locations/42/appointments')) {
    return json({
      data: [
        {
          type: 'appointment',
          id: '501',
          attributes: {
            date: '2026-09-01T10:00:00',
            duration: 3600,
            staff_id: 7,
            attendance_status_slug: 'came',
          },
          relationships: {
            services: { data: [{ type: 'attendance_service', id: '15' }] },
          },
        },
      ],
      included: [
        { type: 'attendance_service', id: '15', attributes: { title: 'Стрижка' } },
        { type: 'staff', id: '7', attributes: { name: 'Олена' } },
      ],
    });
  }
  if (url.endsWith('/api/v2/locations/42')) {
    return json({
      data: { type: 'location', id: '42', attributes: { title: 'Тест салон', address: 'Київ' } },
    });
  }
  if (url.includes('/api/v1/book_dates/')) {
    if (mode === 'closed') return json({ success: true, data: { booking_dates: [], working_dates: [] } });
    const params = new URL(url).searchParams;
    const from = params.get('date_from') ?? '2026-10-12';
    const to = params.get('date_to') ?? from;
    const days = to > from ? [from, to] : [from];
    return json({ success: true, data: { booking_dates: days, working_dates: days } });
  }
  if (url.includes('/api/v1/book_times/')) {
    const times = mode === 'busy' ? ['11:00'] : ['10:00', '11:00'];
    return json({ success: true, data: times.map((time) => ({ time, seance_length: 3600 })) });
  }
  if (url.includes('/api/v1/company/42/clients/search') && method === 'POST') {
    return json({ success: true, data: [{ id: 99, name: 'Марія', phone: '0501112233' }] });
  }
  if (url.includes('/api/v1/records/42') && method === 'POST') {
    return json({ success: true, data: { id: 501, client: { id: 99 } } });
  }
  if (url.includes('/api/v1/record/42/501') && method === 'GET') {
    return json({
      success: true,
      data: {
        id: 501,
        staff_id: 7,
        datetime: '2026-10-12T10:00:00+03:00',
        seance_length: 5400,
        services: recordServiceIds.map((id) => ({
          id,
          title: id === 15 ? 'Стрижка' : 'Укладка',
          cost: id === 15 ? 500 : 300,
        })),
      },
    });
  }
  if (url.includes('/api/v1/record/42/501') && method === 'PUT') {
    const parsed = JSON.parse(body) as { services?: Array<{ id: number }> };
    recordServiceIds = (parsed.services ?? []).map((row) => row.id);
    return json({ success: true, data: { id: 501 } });
  }
  return json({ error: `unmocked ${method} ${url}` }, 500);
}

describe('Altegio agent booking path', () => {
  beforeEach(() => {
    calls.length = 0;
    mode = 'open';
    recordServiceIds = [15, 16];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        const body = typeof init?.body === 'string' ? init.body : '';
        calls.push({ url, method, body });
        const auth = new Headers(init?.headers).get('authorization') ?? '';
        expect(auth).toBe('Bearer partner-token, User user-token');
        expect(new Headers(init?.headers).get('accept')).toBe('application/vnd.api.v2+json');
        return route(url, method, body);
      }),
    );
  });

  it('walks test → search → slots → book → history → edit → cancel on the split APIs', async () => {
    const { altegioAdapter, testAltegioConnection } = await import('./altegio.js');
    const { getCrmAdapter } = await import('./registry.js');
    expect(getCrmAdapter('altegio')).toBe(altegioAdapter);

    const connected = await testAltegioConnection();
    expect(connected).toMatchObject({
      ok: true,
      staffCount: 2,
      serviceCount: 2,
      company: { id: '42', title: 'Тест салон' },
    });
    expect(calls.map((call) => call.url).join('\n')).toContain('/api/v2/locations/42/team_members');
    expect(calls.map((call) => call.url).join('\n')).toContain('/api/v2/locations/42/attendance_services');

    const found = await altegioAdapter.searchServices!('стриж');
    expect(found[0]).toMatchObject({ id: '15', name: 'Стрижка', price: 500, durationMin: 60 });

    const slots = await altegioAdapter.getAvailableSlots!({
      date: '12.10.2026',
      branchId: '42',
      services: [{ id: '15', durationMin: 60 }],
      masterId: '7',
    });
    expect(slots.masters).toEqual([{ id: '7', name: 'Олена' }]);
    expect(evaluateMasterFreeTimeStatus({
      slots: slots.slots,
      masterId: '7',
      date: '12.10.2026',
      time: '10:00',
    })).toBe('ok');
    expect(calls.some((call) => call.url.includes('/api/v1/book_dates/42'))).toBe(true);
    expect(calls.some((call) => call.url.includes('/api/v1/book_times/42/7/2026-10-12'))).toBe(true);

    const booked = await altegioAdapter.createBooking!({
      date: '12.10.2026',
      branchId: '42',
      clientName: 'Марія',
      phone: '+380501112233',
      services: [{ id: '15', durationMin: 60, masterId: '7', startTime: '10:00' }],
      forceTimeConflict: true,
    });
    expect(booked).toEqual({ crmRecordId: '501', crmBuyerId: '99', comment: undefined });
    const post = calls.find((call) => call.method === 'POST' && call.url.includes('/api/v1/records/42'));
    expect(post?.url.startsWith('https://api.alteg.io/api/v1/records/42')).toBe(true);
    const payload = JSON.parse(post!.body) as {
      staff_id: number;
      save_if_busy: boolean;
      datetime: string;
      client: { id: number };
    };
    expect(payload.staff_id).toBe(7);
    expect(payload.save_if_busy).toBe(true);
    expect(payload.datetime).toBe('2026-10-12T10:00:00.000+03:00');
    expect(payload.client.id).toBe(99);

    const history = await altegioAdapter.fetchClientHistory!('99');
    expect(history[0]).toMatchObject({
      id: '501',
      date: '01.09.2026',
      durationMin: 60,
      professionalId: '7',
      professionalName: 'Олена',
      items: [{ name: 'Стрижка' }],
    });
    expect(calls.some((call) => call.url.includes('/api/v2/locations/42/appointments'))).toBe(true);

    await altegioAdapter.appendBookingServices!({
      crmRecordId: '501',
      date: '12.10.2026',
      branchId: '42',
      clientName: 'Марія',
      phone: '+380501112233',
      startTime: '10:00',
      services: [
        { id: '15', durationMin: 60, masterId: '7', startTime: '10:00' },
        { id: '16', durationMin: 30, masterId: '7', startTime: '11:00' },
      ],
    });
    const appended = calls.filter((call) => call.method === 'PUT');
    const appendBody = JSON.parse(appended.at(-1)!.body) as { services: Array<{ id: number }> };
    expect(appendBody.services.map((row) => row.id)).toEqual([15, 16]);

    const removed = await altegioAdapter.removeBookingService!({
      crmRecordId: '501',
      serviceCatalogId: '15',
    });
    expect(removed).toEqual({ remainingCount: 1, cancelledVisit: false });

    calls.length = 0;
    const gone = await altegioAdapter.removeBookingService!({
      crmRecordId: '501',
      serviceCatalogId: '16',
    });
    expect(gone).toEqual({ remainingCount: 0, cancelledVisit: true });
    expect(calls.some((call) =>
      call.method === 'DELETE'
      && call.url.includes('/api/v2/locations/42/appointments/501'),
    )).toBe(true);
    expect(calls.some((call) => call.method === 'DELETE' && call.url.includes('/api/v1/'))).toBe(false);
  });

  it('refuses a closed day and a missing slot with the codes the host already understands', async () => {
    const { altegioAdapter } = await import('./altegio.js');
    mode = 'closed';
    const closed = await altegioAdapter.getAvailableSlots!({
      date: '12.10.2026',
      branchId: '42',
      masterId: '7',
      services: [{ id: '15', durationMin: 60 }],
    });
    expect(evaluateMasterFreeTimeStatus({
      slots: closed.slots,
      masterId: '7',
      date: '12.10.2026',
      time: '10:00',
    })).toBe('day_closed');
    await expect(altegioAdapter.createBooking!({
      date: '12.10.2026',
      branchId: '42',
      clientName: 'Марія',
      phone: '+380501112233',
      services: [{ id: '15', durationMin: 60, masterId: '7', startTime: '10:00' }],
    })).rejects.toThrow(/MASTER_DAY_CLOSED/);

    mode = 'busy';
    const busy = await altegioAdapter.getAvailableSlots!({
      date: '12.10.2026',
      branchId: '42',
      masterId: '7',
      services: [{ id: '15', durationMin: 60 }],
    });
    expect(evaluateMasterFreeTimeStatus({
      slots: busy.slots,
      masterId: '7',
      date: '12.10.2026',
      time: '10:00',
    })).toBe('slot_unavailable');
    await expect(altegioAdapter.createBooking!({
      date: '12.10.2026',
      branchId: '42',
      clientName: 'Марія',
      phone: '+380501112233',
      services: [{ id: '15', durationMin: 60, masterId: '7', startTime: '10:00' }],
    })).rejects.toThrow(/SLOT_NOT_AVAILABLE/);
  });

  it('looks a month ahead for every master when the client has not picked one', async () => {
    const { altegioAdapter } = await import('./altegio.js');
    const slots = await altegioAdapter.getAvailableSlots!({
      date: '12.10.2026',
      branchId: '42',
      services: [{ id: '15', durationMin: 60 }],
      fullMonth: true,
    });
    const dateCalls = calls.filter((call) => call.url.includes('/api/v1/book_dates/42'));
    expect(dateCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of dateCalls) {
      const params = new URL(call.url).searchParams;
      expect(params.get('date_from')).toBe('2026-10-12');
      expect(params.get('date_to')).toBe('2026-11-12');
    }
    expect(calls.filter((call) => call.url.includes('/api/v1/book_times/42/7/2026-10-12')).length).toBeGreaterThan(0);
    expect(calls.filter((call) => call.url.includes('/api/v1/book_times/42/8/2026-11-12')).length).toBeGreaterThan(0);
    expect(Object.keys(slots.slots)).toEqual(['12.10.2026', '12.11.2026']);
    expect(slots.slots['12.10.2026']?.map((slot) => slot.time)).toEqual(['10:00', '11:00']);
    expect(slots.masters.map((row) => row.id).sort()).toEqual(['7', '8']);
  });

  it('rejects two masters in one Altegio record', async () => {
    const { altegioAdapter } = await import('./altegio.js');
    await expect(altegioAdapter.createBooking!({
      date: '12.10.2026',
      branchId: '42',
      clientName: 'Марія',
      phone: '+380501112233',
      services: [
        { id: '15', durationMin: 60, masterId: '7', startTime: '10:00' },
        { id: '16', durationMin: 30, masterId: '8', startTime: '10:00' },
      ],
    })).rejects.toThrow(/ALTEGIO_ONE_MASTER/);
  });
});

describe('Altegio agent tool surface', () => {
  const required = [
    'search_services',
    'get_available_slots',
    'lookup_client_by_phone',
    'get_client_crm_history',
    'book_appointment',
    'cancel_appointment',
    'remove_appointment_service',
    'reschedule_appointment',
  ];

  it('gives booking and general the salon tools, and tells the model about one master', () => {
    for (const modeName of ['booking', 'general'] as const) {
      const names = buildAgentTools(modeName).map((tool) => tool.name);
      for (const name of required) expect(names, modeName).toContain(name);
      const book = buildAgentTools(modeName).find((tool) => tool.name === 'book_appointment');
      expect(JSON.stringify(book?.parameters)).toContain('altegio');
    }
    expect(buildAgentTools('sales').map((tool) => tool.name)).not.toContain('book_appointment');
    const prompt = formatAgentToolsPrompt(buildAgentTools('booking'), { nativeAll: true });
    expect(prompt).toContain('один візит = один майстер');
    expect(prompt).toContain('окремий book_appointment на кожного майстра');
    expect(prompt).toContain('cancel_appointment');
    expect(prompt).toContain('reschedule_appointment');
  });
});
