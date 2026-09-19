import { describe, expect, it } from 'vitest';
import {
  crmProviderRequiresGuid,
  formatInvalidCrmIdToolResult,
  isCrmGuid,
  isCrmGuidPrefix,
  resolveCrmEntityId,
} from './crm-ids.js';

const full = '88d8645d-2022-fa67-6d46-f6ed12f7a6a2';
const other = '88d8645e-aaaa-bbbb-cccc-ddddeeeeffff';

describe('crm guid helpers', () => {
  it('accepts BeautyPro-style GUIDs (non-RFC version nibble)', () => {
    expect(isCrmGuid(full)).toBe(true);
    expect(isCrmGuidPrefix('88d8645d')).toBe(true);
    expect(isCrmGuidPrefix(full)).toBe(false);
    expect(crmProviderRequiresGuid('beautypro')).toBe(true);
    expect(crmProviderRequiresGuid('cleverbox')).toBe(false);
  });
});

describe('resolveCrmEntityId', () => {
  it('expands a unique 8-char prefix', () => {
    const got = resolveCrmEntityId('88d8645d', [full, other], { requireGuid: true });
    expect(got).toEqual({ ok: true, id: full, expandedFrom: '88d8645d' });
  });

  it('rejects an ambiguous prefix', () => {
    const twin = '88d8645d-9999-aaaa-bbbb-cccccccccccc';
    const got = resolveCrmEntityId('88d8645d', [full, twin], { requireGuid: true });
    expect(got).toEqual({ ok: false, raw: '88d8645d', reason: 'ambiguous' });
  });

  it('accepts a full GUID even if it is not in the offer list', () => {
    const got = resolveCrmEntityId(full, [], { requireGuid: true });
    expect(got).toEqual({ ok: true, id: full });
  });

  it('rejects a truncated id with no candidates', () => {
    const got = resolveCrmEntityId('88d8645d', [], { requireGuid: true });
    expect(got).toEqual({ ok: false, raw: '88d8645d', reason: 'truncated' });
  });

  it('leaves CleverBOX numeric ids alone', () => {
    const got = resolveCrmEntityId('42', ['42', '99']);
    expect(got).toEqual({ ok: true, id: '42' });
  });
});

describe('formatInvalidCrmIdToolResult', () => {
  it('tells the model to reuse full UUIDs from the session', () => {
    const text = formatInvalidCrmIdToolResult({
      ok: false,
      raw: '88d8645d',
      reason: 'truncated',
    });
    expect(text).toMatch(/INVALID_CRM_ID/);
    expect(text).toContain('88d8645d');
    expect(text).toMatch(/ПОВНИЙ UUID/);
    expect(text).toMatch(/Не кажи клієнту що записано/);
  });
});
