import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/integration-config.js', () => ({
  getIntegrationConfig: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  config: { KEYCRM_LEAD_PIPELINE_ID: 0 },
}));

import { getIntegrationConfig } from '../../lib/integration-config.js';
import { lookupKeycrmShipments } from './keycrm.js';

const getIntegrationConfigMock = vi.mocked(getIntegrationConfig);

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('lookupKeycrmShipments', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('loads an order by Nova Poshta TTN and maps shipping without internal notes', async () => {
    getIntegrationConfigMock.mockResolvedValue({
      keycrm: { apiKey: 'k', syncIntervalMin: 60, defaultSourceId: 1, appUrl: '' },
    } as never);
    const fetchMock = vi.fn(async (url: string) => {
      const href = String(url);
      expect(href).toContain('/order');
      expect(href).toContain('filter%5Btracking_code%5D=20450123456789');
      expect(href).toContain('shipping.deliveryService');
      return jsonResponse({
        data: [
          {
            id: 101,
            grand_total: 2800,
            created_at: '2026-09-18T18:37:00.000000Z',
            closed_at: null,
            manager_comment: 'внутрішня нотатка',
            status: { name: 'Відправлено' },
            buyer: { id: 55, phone: ['+380971442540'] },
            products: [{ name: 'Лонги', quantity: 1 }],
            shipping: {
              tracking_code: '20450123456789',
              shipping_status: 'in_transit',
              shipping_address_city: 'Камінь-Каширський',
              shipping_receive_point: 'Відділення 1',
              recipient_full_name: 'Юля Подмовська',
              recipient_phone: '380971442540',
              delivery_service: { name: 'Нова Пошта' },
            },
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const rows = await lookupKeycrmShipments({ trackingCode: '20450123456789', limit: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      crmOrderId: '101',
      buyerId: '55',
      statusName: 'Відправлено',
      trackingCode: '20450123456789',
      carrier: 'Нова Пошта',
      city: 'Камінь-Каширський',
      grandTotal: 2800,
      closed: false,
    });
    expect(rows[0]?.items).toEqual([{ name: 'Лонги', qty: 1 }]);
    expect(JSON.stringify(rows[0])).not.toContain('внутрішня нотатка');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('finds the buyer by phone variants, then lists their orders', async () => {
    getIntegrationConfigMock.mockResolvedValue({
      keycrm: { apiKey: 'k', syncIntervalMin: 60, defaultSourceId: 1, appUrl: '' },
    } as never);
    const fetchMock = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.includes('/buyer')) {
        return jsonResponse({ data: [{ id: 77, full_name: 'Юля', phone: ['+380971442540'] }] });
      }
      expect(href).toContain('filter%5Bbuyer_id%5D=77');
      return jsonResponse({
        data: [
          {
            id: 202,
            grand_total: 2800,
            created_at: '2026-09-18T18:37:00.000000Z',
            status: { name: 'На виробництві' },
            buyer: { id: 77, phone: ['+380971442540'] },
            products: [{ name: 'Лонги', quantity: 1 }],
            shipping: {
              tracking_code: '',
              shipping_address_city: 'Камінь-Каширський',
              shipping_receive_point: 'Відділення 1',
            },
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const rows = await lookupKeycrmShipments({ phone: '+380971442540' });
    expect(rows[0]?.statusName).toBe('На виробництві');
    expect(rows[0]?.trackingCode).toBeNull();
    expect(rows[0]?.crmOrderId).toBe('202');
  });
});
