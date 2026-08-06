import { describe, expect, it } from 'vitest';
import {
  buildDeferredLookupNudge,
  looksLikeDeferredLookupPromise,
} from './deferred-lookup.js';

describe('looksLikeDeferredLookupPromise', () => {
  it('catches catalog stall fillers without a clarifying question', () => {
    expect(
      looksLikeDeferredLookupPromise('Добре, шукаю точні варіанти в каталозі, зараз буде 🙏'),
    ).toBe(true);
    expect(looksLikeDeferredLookupPromise('Зараз перевірю і напишу.')).toBe(true);
    expect(looksLikeDeferredLookupPromise('Зараз пошукаю вільні вікна.')).toBe(true);
  });

  it('allows clarifying questions that mention checking', () => {
    expect(
      looksLikeDeferredLookupPromise(
        'Гаразд, зараз ще раз перевірю 🙏 Поки уточню: покриття гель-лаком плануєш, чи без нього?',
      ),
    ).toBe(false);
  });

  it('ignores normal concrete replies', () => {
    expect(
      looksLikeDeferredLookupPromise('Класичний манікюр з покриттям — 850 грн, близько години. На який день зручно?'),
    ).toBe(false);
  });
});

describe('buildDeferredLookupNudge', () => {
  it('names the required tool', () => {
    expect(buildDeferredLookupNudge('search_services')).toContain('search_services');
    expect(buildDeferredLookupNudge('search_catalog')).toContain('search_catalog');
  });
});
