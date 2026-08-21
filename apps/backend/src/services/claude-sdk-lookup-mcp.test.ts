import { describe, expect, it } from 'vitest';
import { buildAgentTools } from '../lib/tool-definitions.js';
import {
  lookupToolsForMcp,
  mcpAllowedToolNames,
  mcpLookupToolName,
  platformToolsForMcp,
} from './claude-sdk-lookup-mcp.js';

describe('lookupToolsForMcp', () => {
  it('allowlists booking lookups and omits history until the client is linked', () => {
    const tools = buildAgentTools('booking');
    expect(lookupToolsForMcp(tools, { clientId: 'c1', crmHistoryAllowed: false })).toEqual([
      'search_services',
      'get_available_slots',
    ]);
    expect(
      lookupToolsForMcp(tools, { clientId: 'c1', crmHistoryAllowed: true }),
    ).toContain('get_client_crm_history');
  });

  it('allowlists sales catalog lookups, not booking tools', () => {
    expect(lookupToolsForMcp(buildAgentTools('sales'), {})).toEqual([
      'search_catalog',
      'get_delivery_cost',
    ]);
  });

  it('gives leadgen an empty lookup MCP surface', () => {
    expect(lookupToolsForMcp(buildAgentTools('leadgen'), {})).toEqual([]);
  });

  it('registers booking terminal + profile tools on the platform MCP allowlist', () => {
    const names = platformToolsForMcp(buildAgentTools('booking'), {
      clientId: 'c1',
      crmHistoryAllowed: true,
    });
    expect(names).toContain('search_services');
    expect(names).toContain('book_appointment');
    expect(names).toContain('request_handoff');
    expect(names).toContain('update_client_info');
    expect(names).toContain('get_client_crm_history');
  });

  it('omits book/collect after mutations are disabled, but keeps handoff', () => {
    const names = platformToolsForMcp(buildAgentTools('booking'), {
      mutationsAllowed: false,
    });
    expect(names).not.toContain('book_appointment');
    expect(names).toContain('request_handoff');
    expect(names).toContain('search_services');
  });

  it('names MCP tools mcp__platform__*', () => {
    expect(mcpLookupToolName('search_services')).toBe('mcp__platform__search_services');
    expect(mcpAllowedToolNames(['search_services', 'get_available_slots'])).toEqual([
      'mcp__platform__search_services',
      'mcp__platform__get_available_slots',
    ]);
  });
});
