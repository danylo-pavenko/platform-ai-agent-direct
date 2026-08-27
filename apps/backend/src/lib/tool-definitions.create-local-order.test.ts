import { describe, expect, it } from 'vitest';
import { formatAgentToolsPrompt } from './agent-tools-prompt.js';
import {
  buildAgentTools,
  mergeToolsByName,
  modeHasBookingTools,
  modeHasLeadgenTools,
  modeHasSalesTools,
} from './tool-definitions.js';

describe('buildAgentTools create_local_order', () => {
  it('is present in sales, leadgen, booking, and general', () => {
    for (const mode of ['sales', 'leadgen', 'booking', 'general'] as const) {
      const names = buildAgentTools(mode).map((t) => t.name);
      expect(names).toContain('create_local_order');
    }
  });

  it('keeps collect_order in sales and general, not leadgen/booking-only', () => {
    expect(buildAgentTools('sales').map((t) => t.name)).toContain('collect_order');
    expect(buildAgentTools('general').map((t) => t.name)).toContain('collect_order');
    expect(buildAgentTools('leadgen').map((t) => t.name)).not.toContain('collect_order');
    expect(buildAgentTools('booking').map((t) => t.name)).not.toContain('collect_order');
  });
});

describe('buildAgentTools mode surfaces (sales / leadgen / booking / general)', () => {
  const bookingOnly = [
    'book_appointment',
    'cancel_appointment',
    'remove_appointment_service',
    'reschedule_appointment',
    'search_services',
    'get_available_slots',
  ] as const;

  it('exposes cancel/reschedule in booking and general, not sales/leadgen', () => {
    for (const mode of ['booking', 'general'] as const) {
      const names = buildAgentTools(mode).map((t) => t.name);
      for (const name of bookingOnly) {
        expect(names).toContain(name);
      }
    }
    for (const mode of ['sales', 'leadgen'] as const) {
      const names = buildAgentTools(mode).map((t) => t.name);
      for (const name of bookingOnly) {
        expect(names).not.toContain(name);
      }
    }
  });

  it('keeps sales catalog tools and leadgen brief tools isolated from each other', () => {
    const sales = buildAgentTools('sales').map((t) => t.name);
    const leadgen = buildAgentTools('leadgen').map((t) => t.name);
    expect(sales).toEqual(
      expect.arrayContaining(['search_catalog', 'get_delivery_cost', 'collect_order']),
    );
    expect(sales).not.toContain('submit_brief');
    expect(leadgen).toEqual(expect.arrayContaining(['classify_intent', 'submit_brief']));
    expect(leadgen).not.toContain('search_catalog');
    expect(leadgen).not.toContain('collect_order');
  });

  it('general is the union of sales + leadgen + booking tools', () => {
    const sales = buildAgentTools('sales').map((t) => t.name);
    const leadgen = buildAgentTools('leadgen').map((t) => t.name);
    const booking = buildAgentTools('booking').map((t) => t.name);
    const general = new Set(buildAgentTools('general').map((t) => t.name));
    for (const name of [...sales, ...leadgen, ...booking]) {
      expect(general.has(name)).toBe(true);
    }
  });

  it('mergeToolsByName keeps first occurrence', () => {
    const a = { name: 'a', description: '1', parameters: { type: 'object', properties: {} } };
    const a2 = { name: 'a', description: '2', parameters: { type: 'object', properties: {} } };
    const b = { name: 'b', description: 'b', parameters: { type: 'object', properties: {} } };
    const merged = mergeToolsByName([a, b, a2]);
    expect(merged.map((t) => t.name)).toEqual(['a', 'b']);
    expect(merged[0]!.description).toBe('1');
  });

  it('modeHas* helpers include general', () => {
    expect(modeHasSalesTools('sales')).toBe(true);
    expect(modeHasSalesTools('general')).toBe(true);
    expect(modeHasSalesTools('booking')).toBe(false);
    expect(modeHasLeadgenTools('leadgen')).toBe(true);
    expect(modeHasLeadgenTools('general')).toBe(true);
    expect(modeHasBookingTools('booking')).toBe(true);
    expect(modeHasBookingTools('general')).toBe(true);
    expect(modeHasBookingTools('sales')).toBe(false);
  });

  it('does not inject booking-only cancel/book rules into sales or leadgen prompts', () => {
    for (const mode of ['sales', 'leadgen'] as const) {
      const prompt = formatAgentToolsPrompt(buildAgentTools(mode));
      expect(prompt).not.toMatch(/виклич cancel_appointment/);
      expect(prompt).not.toMatch(/виклич reschedule_appointment/);
      expect(prompt).not.toMatch(/MODE: PARALLEL|MODE: SEQUENTIAL/);
      expect(prompt).not.toMatch(/ОБОВʼЯЗКОВО виклич book_appointment|ОБОВ'ЯЗКОВО виклич book_appointment/);
    }
    const bookingPrompt = formatAgentToolsPrompt(buildAgentTools('booking'));
    expect(bookingPrompt).toMatch(/cancel_appointment/);
    expect(bookingPrompt).toMatch(/reschedule_appointment/);
    expect(bookingPrompt).not.toContain('ПОВНИЙ підсумок e-commerce');

    const generalPrompt = formatAgentToolsPrompt(buildAgentTools('general'));
    expect(generalPrompt).toMatch(/Режим general/);
    expect(generalPrompt).toContain('collect_order');
    expect(generalPrompt).toContain('book_appointment');
    expect(generalPrompt).toContain('submit_brief');
  });
});
