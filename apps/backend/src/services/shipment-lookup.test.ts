import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    client: { findUnique: vi.fn() },
    order: { findMany: vi.fn() },
  },
}));
vi.mock('../lib/crm-routing.js', () => ({
  resolveCrmProvider: vi.fn(),
}));
vi.mock('./crm/index.js', () => ({
  getCrmAdapter: vi.fn(),
}));
vi.mock('./nova-poshta.js', () => ({
  trackNovaPoshtaDocument: vi.fn(),
}));

import { prisma } from '../lib/prisma.js';
import { resolveCrmProvider } from '../lib/crm-routing.js';
import { getCrmAdapter } from './crm/index.js';
import { trackNovaPoshtaDocument } from './nova-poshta.js';
import {
  formatShipmentLookupResult,
  lookupOrderShipment,
  normalizeTrackingCode,
  shipmentBelongsToClient,
  turnMentionsShipment,
} from './shipment-lookup.js';
import type { CrmShipment } from './crm/types.js';

const clientFind = vi.mocked(prisma.client.findUnique);
const orderFind = vi.mocked(prisma.order.findMany);
const resolveProvider = vi.mocked(resolveCrmProvider);
const adapterOf = vi.mocked(getCrmAdapter);
const trackNp = vi.mocked(trackNovaPoshtaDocument);

function shipment(overrides: Partial<CrmShipment> = {}): CrmShipment {
  return {
    crmOrderId: '101',
    buyerId: '55',
    statusName: 'На виробництві',
    closed: false,
    trackingCode: null,
    carrier: null,
    city: 'Камінь-Каширський',
    receivePoint: 'Відділення 1',
    recipientName: 'Юля Подмовська',
    phones: ['+380971442540'],
    grandTotal: 2800,
    createdAt: '2026-09-18T18:37:00.000Z',
    items: [{ name: 'Лонги', qty: 1 }],
    ...overrides,
  };
}

describe('shipment lookup helpers', () => {
  it('treats a follow-up «?» as a shipment question when history asked about dispatch', () => {
    expect(
      turnMentionsShipment('?', [
        { role: 'user', content: 'Добрий день, може підказати мої замовлення вже відправили ?' },
      ]),
    ).toBe(true);
    expect(turnMentionsShipment('скільки коштує худі?', [])).toBe(false);
    expect(normalizeTrackingCode('ТТН 2045 0123 4567 89')).toBe('20450123456789');
  });

  it('matches the client by phone tail, buyer id, or local order id', () => {
    const row = shipment();
    expect(
      shipmentBelongsToClient(row, { phone: '0971442540', buyerId: null, orderIds: new Set() }),
    ).toBe(true);
    expect(
      shipmentBelongsToClient(row, { phone: '+380501112233', buyerId: null, orderIds: new Set() }),
    ).toBe(false);
    expect(
      shipmentBelongsToClient(shipment({ phones: [] }), {
        phone: null,
        buyerId: '55',
        orderIds: new Set(),
      }),
    ).toBe(true);
  });

  it('does not describe a foreign TTN', () => {
    const text = formatShipmentLookupResult({
      providerLabel: 'KeyCRM',
      ttnQuery: '20450123456789',
      owned: [],
      foreignTtn: true,
      unsupported: false,
      missingIdentity: false,
      crmError: false,
      timeZone: 'Europe/Kyiv',
      trackingByCode: new Map(),
    });
    expect(text).toMatch(/не збігається/);
    expect(text).not.toContain('Юля');
    expect(text).not.toContain('Камінь');
    expect(text).not.toContain('101');
  });
});

describe('lookupOrderShipment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveProvider.mockResolvedValue('keycrm');
    clientFind.mockResolvedValue({
      phone: '+380971442540',
      crmBuyerId: '55',
      crmProvider: 'keycrm',
    } as never);
    orderFind.mockResolvedValue([] as never);
    trackNp.mockResolvedValue({ error: 'not_configured' });
  });

  it('tells the agent the order is in production and has no TTN yet', async () => {
    const lookupShipments = vi.fn().mockResolvedValue([shipment()]);
    adapterOf.mockReturnValue({
      name: 'keycrm',
      capabilities: { orders: true },
      lookupShipments,
    } as never);

    const text = await lookupOrderShipment({
      clientId: 'client-1',
      timeZone: 'Europe/Kyiv',
    });

    expect(lookupShipments).toHaveBeenCalledWith(
      expect.objectContaining({ buyerId: '55', phone: '+380971442540' }),
    );
    expect(text).toContain('На виробництві');
    expect(text).toContain('Лонги');
    expect(text).toContain('ТТН: ще немає');
    expect(text).not.toContain('crmOrderId');
    expect(text).not.toMatch(/\b101\b/);
    expect(trackNp).not.toHaveBeenCalled();
  });

  it('adds Nova Poshta status when the owned order has a TTN', async () => {
    const lookupShipments = vi.fn().mockResolvedValue([
      shipment({
        statusName: 'Відправлено',
        trackingCode: '20450123456789',
        carrier: 'Нова Пошта',
      }),
    ]);
    adapterOf.mockReturnValue({
      name: 'keycrm',
      capabilities: { orders: true },
      lookupShipments,
    } as never);
    trackNp.mockResolvedValue({
      number: '20450123456789',
      status: 'Відправлення прямує до міста',
      statusCode: '5',
      scheduledDeliveryDate: '02.10.2026',
      cityRecipient: null,
      warehouseRecipient: null,
    });

    const text = await lookupOrderShipment({
      clientId: 'client-1',
      trackingCode: '20450123456789',
      timeZone: 'Europe/Kyiv',
    });

    expect(text).toContain('20450123456789');
    expect(text).toContain('Відправлення прямує до міста');
    expect(text).toContain('02.10.2026');
    expect(trackNp).toHaveBeenCalledWith('20450123456789', '+380971442540');
  });

  it('hides another buyer when the pasted TTN is not this client', async () => {
    const lookupShipments = vi.fn().mockResolvedValue([
      shipment({
        crmOrderId: '999',
        buyerId: '1',
        phones: ['+380501112233'],
        recipientName: 'Інша Людина',
        city: 'Львів',
        trackingCode: '20450999999999',
        carrier: 'Нова Пошта',
        items: [{ name: 'Секрет', qty: 1 }],
      }),
    ]);
    adapterOf.mockReturnValue({
      name: 'keycrm',
      capabilities: { orders: true },
      lookupShipments,
    } as never);

    const text = await lookupOrderShipment({
      clientId: 'client-1',
      trackingCode: '20450999999999',
      timeZone: 'Europe/Kyiv',
    });

    expect(text).toMatch(/не збігається/);
    expect(text).not.toContain('Інша');
    expect(text).not.toContain('Львів');
    expect(text).not.toContain('Секрет');
    expect(trackNp).not.toHaveBeenCalled();
  });

  it('says the order CRM cannot look up shipments', async () => {
    resolveProvider.mockResolvedValue('beautypro');
    adapterOf.mockReturnValue({
      name: 'beautypro',
      capabilities: { orders: false },
    } as never);

    const text = await lookupOrderShipment({ clientId: 'client-1' });
    expect(text).toMatch(/BeautyPro/);
    expect(text).toMatch(/не вміє шукати ТТН/);
    expect(clientFind).not.toHaveBeenCalled();
  });
});
