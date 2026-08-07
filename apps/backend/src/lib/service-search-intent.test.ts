import { describe, expect, it } from 'vitest';
import type { CrmServiceItem } from '../services/crm/types.js';
import {
  buildServiceCorrectionNudge,
  extractGenderedServiceIntent,
  looksLikeFalseServiceEquivalence,
  looksLikeServiceCorrection,
  preferIntentFirst,
  queryDropsClientGender,
} from './service-search-intent.js';
import { rankServices } from './service-search-rank.js';

function svc(partial: Partial<CrmServiceItem> & Pick<CrmServiceItem, 'id' | 'name'>): CrmServiceItem {
  return { price: 0, durationMin: 45, ...partial };
}

describe('extractGenderedServiceIntent', () => {
  it('extracts чоловічий манікюр from a long booking request', () => {
    expect(
      extractGenderedServiceIntent(
        'Добрий день, хочу записатись на завтра на чоловічий манікюр, які є вікна після обіду? Без покриття.',
      ),
    ).toBe('чоловічий манікюр');
  });

  it('handles word order манікюр чоловічий', () => {
    expect(extractGenderedServiceIntent('треба манікюр чоловічий')).toBe('манікюр чоловічий');
  });
});

describe('queryDropsClientGender', () => {
  it('detects when the model searched гігієнічна without чоловічий', () => {
    expect(
      queryDropsClientGender(
        'гігієнічна чистка японський манікюр без покриття',
        'хочу чоловічий манікюр без покриття',
      ),
    ).toBe(true);
  });

  it('is fine when query keeps gender', () => {
    expect(queryDropsClientGender('чоловічий манікюр', 'хочу чоловічий манікюр')).toBe(false);
  });
});

describe('preferIntentFirst + ranking', () => {
  it('surfaces Манікюр чоловічий first even when agent queried гігієнічна чистка', () => {
    const catalog = [
      svc({
        id: 'hyg',
        name: 'Гігієнічна чистка + японський манікюр',
        categoryName: 'Манікюр',
        price: 850,
      }),
      svc({
        id: 'male',
        name: 'Манікюр чоловічий',
        categoryName: 'Манікюр',
        price: 500,
      }),
    ];
    const agentHits = rankServices(catalog, 'гігієнічна чистка японський манікюр без покриття', 5);
    const intentHits = rankServices(catalog, 'чоловічий манікюр', 5);
    const merged = preferIntentFirst(agentHits, intentHits, 5);
    expect(merged[0]?.id).toBe('male');
  });
});

describe('looksLikeServiceCorrection / false equivalence', () => {
  it('catches «мені треба просто чоловічий манікюр»', () => {
    expect(looksLikeServiceCorrection('Мені треба просто чоловічий манікюр')).toBe(true);
  });

  it('ignores long first booking request without correction markers', () => {
    expect(
      looksLikeServiceCorrection(
        'Добрий день, хочу записатись на завтра на чоловічий манікюр, які є вікна після обіду? Без покриття.',
      ),
    ).toBe(false);
  });

  it('detects «це та сама послуга»', () => {
    expect(
      looksLikeFalseServiceEquivalence(
        'Це якраз та сама послуга: гігієнічна чистка без покриття, 850 грн.',
      ),
    ).toBe(true);
  });

  it('nudge names search_services and intent', () => {
    const nudge = buildServiceCorrectionNudge('Мені треба просто чоловічий манікюр');
    expect(nudge).toContain('search_services');
    expect(nudge).toContain('чоловічий манікюр');
  });
});
