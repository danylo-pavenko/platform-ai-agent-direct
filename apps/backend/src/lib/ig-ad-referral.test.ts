import { describe, expect, it } from 'vitest';
import {
  buildAdReferralPromptBlock,
  conversationHasAdAttribution,
  parseMetaAdReferral,
  referralFromUnknown,
  shouldAdsOnlySoftHandoffOrganic,
} from './ig-ad-referral.js';

describe('ig-ad-referral', () => {
  it('parses ADS CTD referral and rejects non-ad sources', () => {
    const now = new Date('2026-11-12T10:00:00.000Z');
    expect(
      parseMetaAdReferral(
        {
          source: 'ADS',
          type: 'OPEN_THREAD',
          ad_id: '120212345678',
          ads_context_data: { ad_title: 'Знижка на манікюр' },
        },
        now,
      ),
    ).toEqual({
      source: 'ADS',
      type: 'OPEN_THREAD',
      adId: '120212345678',
      adTitle: 'Знижка на манікюр',
      capturedAt: now.toISOString(),
    });
    expect(parseMetaAdReferral({ source: 'SHORTLINK', ref: 'promo42' })?.ref).toBe('promo42');
    expect(parseMetaAdReferral(null)).toBeNull();
    expect(parseMetaAdReferral({ source: 'CUSTOMER_CHAT' })).toBeNull();
  });

  it('attributes sticky conversation or inbound message; organic stays false', () => {
    const msg = parseMetaAdReferral({ source: 'ADS', ad_id: '1' })!;
    expect(conversationHasAdAttribution({ messageReferral: msg })).toBe(true);
    expect(
      conversationHasAdAttribution({ conversationReferral: { source: 'ADS', adId: '1' } }),
    ).toBe(true);
    expect(conversationHasAdAttribution({})).toBe(false);

    const stored = referralFromUnknown({
      source: 'ads',
      adId: '1',
      adTitle: 'T',
      capturedAt: '2026-11-12T00:00:00.000Z',
    });
    expect(stored?.source).toBe('ADS');
    expect(buildAdReferralPromptBlock(stored!)).toContain('ad_id: 1');
  });

  it('soft-handoffs organic when respondAdsOnly and no exemption', () => {
    expect(
      shouldAdsOnlySoftHandoffOrganic({
        respondAdsOnly: true,
        hasAdAttribution: false,
        adsOnlyAssumed: false,
      }),
    ).toBe(true);
  });

  it('skips soft-handoff after exemption, reclaim, ads, or manager action', () => {
    const base = {
      respondAdsOnly: true,
      hasAdAttribution: false,
      adsOnlyAssumed: false,
    };
    expect(shouldAdsOnlySoftHandoffOrganic({ ...base, adsOnlyAssumed: true })).toBe(false);
    expect(shouldAdsOnlySoftHandoffOrganic({ ...base, resumedFromAdsOnlyHandoff: true })).toBe(false);
    expect(shouldAdsOnlySoftHandoffOrganic({ ...base, hasAdAttribution: true })).toBe(false);
    expect(shouldAdsOnlySoftHandoffOrganic({ ...base, managerAction: true })).toBe(false);
    expect(
      shouldAdsOnlySoftHandoffOrganic({
        respondAdsOnly: false,
        hasAdAttribution: false,
        adsOnlyAssumed: false,
      }),
    ).toBe(false);
  });
});
