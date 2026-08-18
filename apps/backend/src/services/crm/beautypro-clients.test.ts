import { describe, expect, it } from 'vitest';
import {
  BP_CLIENT_LIST_FIELDS,
  beautyproClientCommentBody,
  buildClientPhoneSearchVariants,
  buildIgNameSearchVariants,
  commentsContainIg,
  clientNoteFromBeautyproRow,
  formatPhoneForBeautyproWrite,
  igCommentMarker,
  normalizeIgUsername,
  pickClientMatchingIg,
} from './beautypro-clients.js';

describe('beautypro client helpers', () => {
  it('builds UA phone search variants without duplicates', () => {
    const variants = buildClientPhoneSearchVariants('095 895 94 21');
    expect(variants[0]).toBe('+380958959421');
    expect(variants).toContain('380958959421');
    expect(variants).toContain('0958959421');
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('keeps international non-UA phones as trimmed + digits', () => {
    const variants = buildClientPhoneSearchVariants('+1 (555) 123-4567');
    expect(variants).toContain('+1 (555) 123-4567');
    expect(variants).toContain('15551234567');
  });

  it('normalizes IG usernames and builds comment marker', () => {
    expect(normalizeIgUsername('@Cultura.Bar')).toBe('cultura.bar');
    expect(normalizeIgUsername('bad nick')).toBeNull();
    expect(igCommentMarker('@moxito')).toBe('IG:@moxito');
  });

  it('matches IG from comment (official field) and comments fallback', () => {
    expect(commentsContainIg('VIP\nIG:@moxito.beauty', 'moxito.beauty')).toBe(true);
    expect(clientNoteFromBeautyproRow({ comment: 'IG:@danylo_p' })).toBe('IG:@danylo_p');
    const hit = pickClientMatchingIg(
      [
        { id: '1', name: 'Someone', comment: 'other' },
        { id: '2', name: 'Client', comment: 'IG:@danylo_p' },
      ],
      'danylo_p',
    );
    expect(hit?.id).toBe('2');
  });

  it('uses official client fields names (no id, comment not comments)', () => {
    const names = BP_CLIENT_LIST_FIELDS.split(',');
    expect(names).toContain('comment');
    expect(names).not.toContain('comments');
    expect(names).not.toContain('id');
    expect(beautyproClientCommentBody('IG:@moxito')).toEqual({ comment: 'IG:@moxito' });
    expect(beautyproClientCommentBody('  ')).toEqual({});
  });

  it('builds name search variants for IG', () => {
    expect(buildIgNameSearchVariants('@Foo_bar')).toEqual(['foo_bar', '@foo_bar']);
  });

  it('formats UA phones for write as +380…', () => {
    expect(formatPhoneForBeautyproWrite('0958959421')).toBe('+380958959421');
    expect(formatPhoneForBeautyproWrite('+1 555')).toBe('+1 555');
  });
});
