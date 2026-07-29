import { describe, expect, it } from 'vitest';
import { formatAgentToolsPrompt } from './agent-tools-prompt.js';
import { buildAgentTools } from './tool-definitions.js';
import type { ToolDefinition } from '../services/claude.js';

function tool(name: string): ToolDefinition {
  return { name, description: `${name} desc`, parameters: { type: 'object', properties: {} } };
}

describe('formatAgentToolsPrompt', () => {
  it('includes collect_order rules only when that tool is present (sales)', () => {
    const sales = buildAgentTools('sales');
    const prompt = formatAgentToolsPrompt(sales);
    expect(prompt).toContain('collect_order');
    expect(prompt).toContain('ПОВНИЙ підсумок e-commerce');
    expect(prompt).not.toContain('submit_brief');
    expect(prompt).not.toContain('classify_intent — на початку');
  });

  it('includes submit_brief / classify_intent rules for leadgen, not collect_order sales rules', () => {
    const leadgen = buildAgentTools('leadgen');
    const prompt = formatAgentToolsPrompt(leadgen);
    expect(prompt).toContain('submit_brief');
    expect(prompt).toContain('classify_intent');
    expect(prompt).not.toContain('ПОВНИЙ підсумок e-commerce');
    expect(prompt).not.toMatch(/виклич collect_order/);
  });

  it('never instructs tools that are not in the list', () => {
    const prompt = formatAgentToolsPrompt([tool('request_handoff'), tool('update_client_info')]);
    expect(prompt).toContain('request_handoff');
    expect(prompt).toContain('update_client_info');
    expect(prompt).not.toContain('collect_order');
    expect(prompt).not.toContain('submit_brief');
    expect(prompt).not.toContain('create_local_order');
  });

  it('tells the model not to narrate tool/mode mismatches to the client', () => {
    const prompt = formatAgentToolsPrompt([tool('request_handoff')]);
    expect(prompt).toMatch(/Не згадуй інші tools/i);
    expect(prompt).toMatch(/не коментуй розбіжність/i);
  });
});
