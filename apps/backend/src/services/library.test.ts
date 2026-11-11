import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: { BRAND_NAME: 'Test Brand', TENANT_KNOWLEDGE_DIR: '/tmp/tenant_knowledge_test' },
}));
vi.mock('../lib/prisma.js', () => ({ prisma: {} }));

import { buildRuntimePrompt, type WorkingHours } from './prompt-builder.js';
import { formatLibraryIndex, formatMatchedLibraryCards, selectLibraryCards, type LibraryCard } from './library.js';

const HOURS: WorkingHours = {
  mon: { start: '09:00', end: '18:00', enabled: true },
  tue: { start: '09:00', end: '18:00', enabled: true },
  wed: { start: '09:00', end: '18:00', enabled: true },
  thu: { start: '09:00', end: '18:00', enabled: true },
  fri: { start: '09:00', end: '18:00', enabled: true },
  sat: { start: '10:00', end: '16:00', enabled: true },
  sun: { start: '00:00', end: '00:00', enabled: false },
};

const cards: LibraryCard[] = [
  {
    slug: 'pre-f',
    title: 'Кузов старший за F',
    description: 'Коли називають E39 або старшу серію',
    aliases: ['e39', 'e46', 'e60'],
    body: 'Підтримка лише з F-серії. Не викликай request_handoff.',
  },
  {
    slug: 'diesel',
    title: 'Дизель',
    description: 'Коли пишуть tdi або дизель',
    aliases: ['tdi', '2.5 tdi', 'diesel'],
    body: 'Прошивки на дизельні ще в процесі розробки. Не викликай request_handoff.',
  },
  {
    slug: 'prices-n55',
    title: 'Ціни N55',
    description: 'Коли питають ціну N55',
    aliases: ['n55'],
    body: 'Stage 1/2: 349€',
  },
];

describe('selectLibraryCards', () => {
  it('attaches the pre-F and diesel cards for E39 2.5 tdi, not an N55 price', () => {
    const matched = selectLibraryCards(cards, 'E39 2.5 tdi 1998');
    const slugs = matched.map((card) => card.slug);
    expect(slugs).toContain('pre-f');
    expect(slugs).toContain('diesel');
    expect(slugs).not.toContain('prices-n55');
    expect(matched.length).toBeLessThanOrEqual(3);
    const text = formatMatchedLibraryCards(matched);
    expect(text).toContain('F-серії');
    expect(text).toContain('дизель');
    expect(text).toContain('Не викликай request_handoff');
  });

  it('does not put the N55 price into the prompt until that card is attached', () => {
    const index = formatLibraryIndex(cards);
    const bare = buildRuntimePrompt({
      activePromptContent: 'Поведінка. Ціну бери лише з картки.',
      catalogSnippet: 'Манікюр 900 грн',
      currentTime: new Date('2026-07-20T12:00:00'),
      workingHours: HOURS,
      conversationState: 'bot',
      libraryIndex: index,
    });
    expect(bare).toContain('prices-n55');
    expect(bare).toContain('Манікюр 900 грн');
    expect(bare).not.toContain('349€');

    const matched = selectLibraryCards(cards, 'скільки коштує N55');
    expect(matched.map((card) => card.slug)).toContain('prices-n55');
    const withCard = buildRuntimePrompt({
      activePromptContent: 'Поведінка. Ціну бери лише з картки.',
      catalogSnippet: 'Манікюр 900 грн',
      currentTime: new Date('2026-07-20T12:00:00'),
      workingHours: HOURS,
      conversationState: 'bot',
      libraryIndex: index,
      libraryCards: formatMatchedLibraryCards(matched),
    });
    expect(withCard).toContain('349€');
    expect(withCard).toContain('Манікюр 900 грн');
  });
});
