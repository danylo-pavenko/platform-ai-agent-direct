import { describe, expect, it } from 'vitest';
import {
  formatAttachmentsForAgent,
  parseLibraryAttachments,
  pickLibraryAttachment,
} from './library-attachments.js';

describe('library-attachments', () => {
  it('parses and picks image by default', () => {
    const rows = parseLibraryAttachments([
      {
        id: '11111111-1111-4111-8111-111111111111',
        type: 'link',
        title: 'Catalog',
        url: 'https://example.com/a',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        type: 'image',
        title: 'Size chart',
        url: 'https://example.com/chart.jpg',
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(pickLibraryAttachment(rows)?.type).toBe('image');
    expect(
      pickLibraryAttachment(rows, '11111111-1111-4111-8111-111111111111')?.type,
    ).toBe('link');
  });

  it('formats agent meta without inventing storage keys', () => {
    const text = formatAttachmentsForAgent([
      {
        id: '22222222-2222-4222-8222-222222222222',
        type: 'image',
        title: 'Сітка',
        storageKey: 'library/2026/11/x.jpg',
      },
    ]);
    expect(text).toContain('send_library_asset');
    expect(text).toContain('Сітка');
    expect(text).not.toContain('library/2026');
  });

  it('rejects invalid attachments as empty', () => {
    expect(parseLibraryAttachments([{ type: 'link', title: 'x' }])).toEqual([]);
  });
});
