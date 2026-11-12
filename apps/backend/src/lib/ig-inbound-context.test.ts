import { describe, expect, it } from 'vitest';
import {
  buildIgInboundContextHeader,
  enrichUserMessageWithIgContext,
} from './ig-inbound-context.js';

describe('ig-inbound-context', () => {
  it('labels story replies for OCR/vision and wraps client text', () => {
    const header = buildIgInboundContextHeader({
      kind: 'story_reply',
      story: { id: 's1', url: 'https://cdn.example/story.jpg', storageKey: '2026/10/s.jpg' },
    });
    expect(header).toContain('відповів на вашу Instagram Stories');
    expect(header).toMatch(/OCR|прочитай текст/i);
    expect(header).toContain('vision');

    const out = enrichUserMessageWithIgContext('Де купити?', {
      kind: 'story_reply',
      story: { id: 's1' },
    });
    expect(out).toContain('Stories');
    expect(out).toContain('Де купити?');
  });

  it('labels detected phone and CTD ad referral', () => {
    const phone = enrichUserMessageWithIgContext('📞 +380979931530', {
      kind: 'detected_phone',
      phone: '+380979931530',
    });
    expect(phone).toContain('розпізнав номер');
    expect(phone).toContain('+380979931530');

    const ad = buildIgInboundContextHeader({
      kind: 'ad_referral',
      referral: {
        source: 'ADS',
        adId: '99',
        adTitle: 'CTD',
        capturedAt: '2026-11-12T00:00:00.000Z',
      },
    });
    expect(ad).toContain('Instagram-реклами');
    expect(ad).toContain('CTD');
  });
});
