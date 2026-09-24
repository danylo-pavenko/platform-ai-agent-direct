import { describe, expect, it } from 'vitest';
import {
  crmProviderRequiresGuid,
  crmProviderRequiresNumericId,
  formatInvalidCrmIdToolResult,
  isCrmGuid,
  isCrmGuidPrefix,
  isCrmNumericId,
  resolveCrmEntityId,
  shouldResolveBookingCrmIds,
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
    expect(crmProviderRequiresNumericId('cleverbox')).toBe(true);
    expect(crmProviderRequiresNumericId('beautypro')).toBe(false);
    expect(shouldResolveBookingCrmIds('beautypro')).toBe(true);
    expect(shouldResolveBookingCrmIds('cleverbox')).toBe(true);
    expect(shouldResolveBookingCrmIds('keycrm')).toBe(false);
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

  it('rejects a tool name such as reschedule instead of a BeautyPro GUID', () => {
    const got = resolveCrmEntityId('reschedule', [], { requireGuid: true });
    expect(got).toEqual({ ok: false, raw: 'reschedule', reason: 'not_guid' });
  });

  it('rejects a truncated id with no candidates', () => {
    const got = resolveCrmEntityId('88d8645d', [], { requireGuid: true });
    expect(got).toEqual({ ok: false, raw: '88d8645d', reason: 'truncated' });
  });

  it('leaves CleverBOX numeric ids alone when they match', () => {
    const got = resolveCrmEntityId('42', ['42', '99'], { requireNumeric: true });
    expect(got).toEqual({ ok: true, id: '42' });
    expect(isCrmNumericId('42')).toBe(true);
  });

  it('does not expand a short numeric id into a longer CleverBOX id', () => {
    const got = resolveCrmEntityId('12', ['12345', '99'], { requireNumeric: true });
    expect(got).toEqual({ ok: true, id: '12' });
  });

  it('maps a unique master/service name from the offer to its numeric id', () => {
    const got = resolveCrmEntityId('Іванка', ['5', '9'], {
      requireNumeric: true,
      names: [
        { id: '5', name: 'Іванка' },
        { id: '9', name: 'Надія' },
      ],
    });
    expect(got).toEqual({ ok: true, id: '5', expandedFrom: 'Іванка' });
  });

  it('rejects an unmatched name on CleverBOX', () => {
    const got = resolveCrmEntityId('Іванка', ['5'], { requireNumeric: true });
    expect(got).toEqual({ ok: false, raw: 'Іванка', reason: 'not_numeric' });
  });

  it('rejects two masters that share a name', () => {
    const got = resolveCrmEntityId('Анастасія', ['1', '2'], {
      requireNumeric: true,
      names: [
        { id: '1', name: 'Анастасія' },
        { id: '2', name: 'Анастасія' },
      ],
    });
    expect(got).toEqual({ ok: false, raw: 'Анастасія', reason: 'ambiguous' });
  });
});

describe('formatInvalidCrmIdToolResult', () => {
  it('tells the model to reuse full ids from the session', () => {
    const text = formatInvalidCrmIdToolResult({
      ok: false,
      raw: '88d8645d',
      reason: 'truncated',
    });
    expect(text).toMatch(/INVALID_CRM_ID/);
    expect(text).toContain('88d8645d');
    expect(text).toMatch(/повний id/);
    expect(text).toMatch(/CleverBOX/);
    expect(text).toMatch(/Не кажи клієнту що записано/);
  });
});
