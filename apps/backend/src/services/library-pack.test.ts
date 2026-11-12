import { describe, expect, it } from 'vitest';
import { parseLibraryPack } from './library-pack.js';

const card = {
  slug: 'refund-rules',
  title: 'Повернення',
  description: 'Коли клієнт просить повернути гроші',
  aliases: ['refund'],
  body: 'Гроші повертаємо за правилом салону.',
};

describe('parseLibraryPack', () => {
  it('accepts a versioned pack and turns a missing status into active', () => {
    const parsed = parseLibraryPack({ version: 1, cards: [card] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.cards[0].status).toBe('active');
      expect(parsed.cards[0].slug).toBe('refund-rules');
    }
  });

  it('accepts a bare array', () => {
    const parsed = parseLibraryPack([{ ...card, status: 'draft' }]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.cards[0].status).toBe('draft');
  });

  it('rejects a repeated slug and a bad slug', () => {
    const repeated = parseLibraryPack({ cards: [card, card] });
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) expect(repeated.issues[0].message).toContain('refund-rules');

    const bad = parseLibraryPack({ cards: [{ ...card, slug: 'Ціна N55' }] });
    expect(bad.ok).toBe(false);
  });

  it('accepts version 2 attachments with https url', () => {
    const parsed = parseLibraryPack({
      version: 2,
      cards: [
        {
          ...card,
          attachments: [
            {
              type: 'image',
              title: 'Сітка',
              url: 'https://cdn.example.com/size.jpg',
            },
          ],
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.cards[0].attachments).toHaveLength(1);
      expect(parsed.cards[0].attachments[0].type).toBe('image');
      expect(parsed.cards[0].attachments[0].url).toContain('https://');
    }
  });
});
