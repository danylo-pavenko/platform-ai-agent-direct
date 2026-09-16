import { describe, expect, it } from 'vitest';
import {
  extractPhoneFromMetaMessage,
  extractPhoneFromUnknownPayload,
  formatIgDetectedPhoneText,
  isIgDetectedPhoneText,
  isRedundantDetectedPhoneText,
  looksLikeIgAutoPhoneCard,
} from './ig-detected-phone.js';

describe('extractPhoneFromUnknownPayload', () => {
  it('reads tel: URLs from fallback cards', () => {
    expect(
      extractPhoneFromUnknownPayload({
        url: 'tel:+380979931530',
        title: 'Call',
      }),
    ).toBe('+380979931530');
  });

  it('reads nested contact phone fields', () => {
    expect(
      extractPhoneFromUnknownPayload({
        contacts: [{ phones: [{ phone: '0979931530' }] }],
      }),
    ).toBe('+380979931530');
  });
});

describe('extractPhoneFromMetaMessage', () => {
  it('parses empty unsupported fallback with tel payload', () => {
    expect(
      extractPhoneFromMetaMessage({
        is_unsupported: true,
        attachments: [
          { type: 'fallback', payload: { url: 'tel:0979931530', title: '0979931530' } },
        ],
      }),
    ).toBe('+380979931530');
  });
});

describe('looksLikeIgAutoPhoneCard', () => {
  it('matches empty unsupported bubbles', () => {
    expect(
      looksLikeIgAutoPhoneCard({ text: '', isUnsupported: true, attachments: [] }),
    ).toBe(true);
  });

  it('does not match a normal captioned image', () => {
    expect(
      looksLikeIgAutoPhoneCard({
        text: 'ось фото',
        hasPlayableMedia: true,
        attachments: [{ type: 'image' }],
      }),
    ).toBe(false);
  });
});

describe('formatIgDetectedPhoneText', () => {
  it('prefixes the number for admin and agent', () => {
    expect(formatIgDetectedPhoneText('+380979931530')).toBe('📞 +380979931530');
    expect(isIgDetectedPhoneText('📞 +380979931530')).toBe(true);
  });
});

describe('isRedundantDetectedPhoneText', () => {
  it('drops the IG chip when the previous bubble already has the number', () => {
    expect(
      isRedundantDetectedPhoneText('📞 +380979931530', [
        'Каразія Світлана, 0979931530, нова пошта 1',
      ]),
    ).toBe(true);
  });

  it('keeps a different number', () => {
    expect(isRedundantDetectedPhoneText('📞 +380501112233', ['0979931530'])).toBe(false);
  });
});
