import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildPlatformCapabilitiesBlock } from './platform-capabilities-prompt.js';
import { buildAgentTools } from './tool-definitions.js';

describe('booking preferred-master tools and docs', () => {
  it('exposes master_id on get_available_slots and book_appointment in booking mode', () => {
    const tools = buildAgentTools('booking');
    const slots = tools.find((t) => t.name === 'get_available_slots');
    const book = tools.find((t) => t.name === 'book_appointment');

    expect(slots).toBeDefined();
    expect(book).toBeDefined();
    expect(slots!.parameters.properties).toHaveProperty('master_id');
    expect(book!.parameters.properties).toHaveProperty('master_id');
    expect(slots!.parameters.properties.services.items.properties).toHaveProperty('master_id');
    expect(book!.parameters.properties.services.items.properties).toHaveProperty('master_id');
    expect(slots!.description).toMatch(/master_id/);
    const handoff = tools.find((t) => t.name === 'request_handoff');
    expect(handoff!.description).toMatch(/cancel_appointment|reschedule_appointment|refund/i);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'cancel_appointment',
        'remove_appointment_service',
        'reschedule_appointment',
      ]),
    );
  });

  it('does not expose salon slot tools in sales or leadgen (general does)', () => {
    for (const mode of ['sales', 'leadgen'] as const) {
      const names = buildAgentTools(mode).map((t) => t.name);
      expect(names).not.toContain('get_available_slots');
      expect(names).not.toContain('book_appointment');
      expect(names).not.toContain('cancel_appointment');
    }
    expect(buildAgentTools('general').map((t) => t.name)).toEqual(
      expect.arrayContaining(['get_available_slots', 'book_appointment', 'cancel_appointment']),
    );
  });

  it('documents UC1/UC2 in platform capabilities for meta-agent', () => {
    const block = buildPlatformCapabilitiesBlock();
    expect(block).toContain('Booking master preference');
    expect(block).toContain('agent_config.timezone');
    expect(block).toContain('Europe/Kyiv');
    expect(block).toContain('get_available_slots');
    expect(block).toContain('master_id');
    expect(block).toContain('Повторний клієнт');
    expect(block).toContain('Новий клієнт');
    expect(block).toMatch(/request_handoff/);
    expect(block).toMatch(/cancel_appointment|reschedule_appointment/);
    expect(block).toMatch(/services\[\]\.master_id/);
    expect(block).toContain('MASTER_SERVICE_MISMATCH');
    expect(block).toMatch(/однаковим ім/);
    expect(block).toContain('MASTER_DAY_CLOSED');
  });

  it('documents grade pricing for booking tools in platform capabilities', () => {
    const block = buildPlatformCapabilitiesBlock();
    expect(block).toContain('Booking prices by master grade');
    expect(block).toContain('Ціни для обраного майстра');
    expect(block).toMatch(/недоступно/);
  });

  it('seed booking prompt covers returning and first-time master flows', () => {
    const seed = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../workspace/templates/prompts/booking-agent.txt'),
      'utf-8',
    );
    expect(seed).toContain('Повторний клієнт');
    expect(seed).toContain('Новий клієнт');
    expect(seed).toContain('get_available_slots');
    expect(seed).toContain('master_id');
    expect(seed).toMatch(/не показуй/i);
    expect(seed).toContain('Ціни за рівнем майстра');
    expect(seed).toMatch(/недоступно для цього майстра/);
    expect(seed).toMatch(/request_handoff/);
    expect(seed).toMatch(/другий візит/);
    expect(seed).toMatch(/cancel_appointment|reschedule_appointment/);
    expect(seed).toMatch(/різних майстрів/);
  });
});
