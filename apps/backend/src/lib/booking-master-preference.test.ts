import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
    expect(slots!.description).toMatch(/master_id/);
  });

  it('does not expose salon slot tools in sales or leadgen', () => {
    for (const mode of ['sales', 'leadgen'] as const) {
      const names = buildAgentTools(mode).map((t) => t.name);
      expect(names).not.toContain('get_available_slots');
      expect(names).not.toContain('book_appointment');
    }
  });

  it('documents UC1/UC2 in platform capabilities for meta-agent', () => {
    const block = buildPlatformCapabilitiesBlock();
    expect(block).toContain('Booking master preference');
    expect(block).toContain('get_available_slots');
    expect(block).toContain('master_id');
    expect(block).toContain('Повторний клієнт');
    expect(block).toContain('Новий клієнт');
  });

  it('seed booking prompt covers returning and first-time master flows', () => {
    const seed = readFileSync(
      resolve(process.cwd(), '../workspace/templates/prompts/booking-agent.txt'),
      'utf-8',
    );
    expect(seed).toContain('Повторний клієнт');
    expect(seed).toContain('Новий клієнт');
    expect(seed).toContain('get_available_slots');
    expect(seed).toContain('master_id');
    expect(seed).toMatch(/не показуй/i);
  });
});
