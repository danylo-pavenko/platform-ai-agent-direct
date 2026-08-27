import { describe, expect, it } from 'vitest';
import { formatAgentToolsPrompt } from './agent-tools-prompt.js';
import { buildAgentTools } from './tool-definitions.js';
import type { ToolDefinition } from './claude-runtime.js';

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
    expect(prompt).toContain('його немає в цьому режимі');
    expect(prompt).not.toContain('ПОВНИЙ підсумок e-commerce');
    expect(prompt).not.toContain('Режим general');
  });

  it('general prompt routes by intent and allows collect_order + submit_brief', () => {
    const prompt = formatAgentToolsPrompt(buildAgentTools('general'));
    expect(prompt).toContain('Режим general');
    expect(prompt).toContain('collect_order');
    expect(prompt).toContain('submit_brief');
    expect(prompt).not.toContain('його немає в цьому режимі');
    expect(prompt).toMatch(/для повного e-commerce замовлення/);
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

  it('includes preferred-master slot rules for booking tools', () => {
    const prompt = formatAgentToolsPrompt(buildAgentTools('booking'));
    expect(prompt).toContain('get_available_slots');
    expect(prompt).toMatch(/Повторний клієнт/);
    expect(prompt).toMatch(/master_id/);
    expect(prompt).toMatch(/Swap майстрів|міняє майстрів/i);
    expect(prompt).toMatch(/TIME_CONFLICT/);
  });

  it('forbids deferred catalog promises without search_services in booking', () => {
    const prompt = formatAgentToolsPrompt(buildAgentTools('booking'));
    expect(prompt).toMatch(/Заборонено писати клієнту/);
    expect(prompt).toContain('search_services');
    expect(prompt).toMatch(/ТІЙ САМІЙ відповіді/);
    expect(prompt).toMatch(/get_available_slots/);
    expect(prompt).toMatch(/НЕ вигадуй ціну/);
  });

  it('requires re-search when client corrects the service name', () => {
    const prompt = formatAgentToolsPrompt(buildAgentTools('booking'));
    expect(prompt).toMatch(/виправляє|уточнює послугу/);
    expect(prompt).toMatch(/це та сама послуга/);
    expect(prompt).toMatch(/словами клієнта|слів клієнта/);
  });

  it('teaches grade-aware pricing from tool results in booking', () => {
    const tools = buildAgentTools('booking');
    const search = tools.find((t) => t.name === 'search_services');
    const slots = tools.find((t) => t.name === 'get_available_slots');
    const book = tools.find((t) => t.name === 'book_appointment');
    expect(search!.description).toMatch(/діапазон|грейд/i);
    expect(slots!.description).toMatch(/Ціни для обраного майстра/);
    expect(book!.description).toMatch(/services\[\]\.price|price/);

    const prompt = formatAgentToolsPrompt(tools);
    expect(prompt).toMatch(/діапазон/);
    expect(prompt).toMatch(/Ціни для обраного майстра/);
    expect(prompt).toMatch(/недоступно для цього майстра/);
  });

  it('forbids confirming a visit without book_appointment', () => {
    const prompt = formatAgentToolsPrompt(buildAgentTools('booking'));
    expect(prompt).toMatch(/book_appointment/);
    expect(prompt).toMatch(/ОБОВʼЯЗКОВО виклич book_appointment|ОБОВ'ЯЗКОВО виклич book_appointment/);
    expect(prompt).toMatch(/чекаємо тебе/);
  });

  it('documents cancel/reschedule tools and forbids second book as move', () => {
    const prompt = formatAgentToolsPrompt(buildAgentTools('booking'));
    expect(prompt).toMatch(/cancel_appointment/);
    expect(prompt).toMatch(/reschedule_appointment/);
    expect(prompt).toMatch(/remove_appointment_service/);
    expect(prompt).toMatch(/не другий book|Не використовуй повторний book|reschedule_appointment/);
    expect(prompt).toMatch(/Refund|оплати/);
  });

  it('requires per-service master_id for parallel booking', () => {
    const prompt = formatAgentToolsPrompt(buildAgentTools('booking'));
    expect(prompt).toMatch(/різних майстрів/);
    expect(prompt).toMatch(/services\[\]\.master_id/);
  });

  it('omits lookup schemas from the text protocol on the SDK path', () => {
    const prompt = formatAgentToolsPrompt(buildAgentTools('booking'), { nativeLookup: true });
    expect(prompt).toContain('native');
    expect(prompt).toContain('book_appointment');
    expect(prompt).not.toMatch(/"name": "search_services"/);
    expect(prompt).toContain('НЕ вигадуй ціну');
    expect(prompt).not.toContain('<tool_call> search_services');
  });

  it('drops the text protocol entirely when all tools are native MCP', () => {
    const prompt = formatAgentToolsPrompt(buildAgentTools('booking'), { nativeAll: true });
    expect(prompt).toContain('NATIVE MCP');
    expect(prompt).not.toMatch(/<tool_call>\s*\{/);
    expect(prompt).not.toMatch(/"name": "book_appointment"/);
    expect(prompt).toContain('book_appointment');
    expect(prompt).toMatch(/request_handoff/);
  });
});
