import { describe, expect, it } from 'vitest';
import { formatAgentToolsPrompt } from './agent-tools-prompt.js';
import { buildAgentTools } from './tool-definitions.js';

describe('buildAgentTools create_local_order', () => {
  it('is present in sales, leadgen, and booking', () => {
    for (const mode of ['sales', 'leadgen', 'booking'] as const) {
      const names = buildAgentTools(mode).map((t) => t.name);
      expect(names).toContain('create_local_order');
    }
  });

  it('keeps collect_order only in sales', () => {
    expect(buildAgentTools('sales').map((t) => t.name)).toContain('collect_order');
    expect(buildAgentTools('leadgen').map((t) => t.name)).not.toContain('collect_order');
    expect(buildAgentTools('booking').map((t) => t.name)).not.toContain('collect_order');
  });
});

describe('buildAgentTools mode surfaces (sales / leadgen / booking)', () => {
  const bookingOnly = [
    'book_appointment',
    'cancel_appointment',
    'remove_appointment_service',
    'reschedule_appointment',
    'search_services',
    'get_available_slots',
  ] as const;

  it('exposes cancel/reschedule only in booking', () => {
    const booking = buildAgentTools('booking').map((t) => t.name);
    for (const name of bookingOnly) {
      expect(booking).toContain(name);
    }
    for (const mode of ['sales', 'leadgen'] as const) {
      const names = buildAgentTools(mode).map((t) => t.name);
      for (const name of bookingOnly) {
        expect(names).not.toContain(name);
      }
    }
  });

  it('keeps sales catalog tools and leadgen brief tools isolated', () => {
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

  it('does not inject booking cancel/book rules into sales or leadgen prompts', () => {
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
  });
});
