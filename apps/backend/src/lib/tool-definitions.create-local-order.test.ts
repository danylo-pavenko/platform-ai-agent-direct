import { describe, expect, it } from 'vitest';
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
