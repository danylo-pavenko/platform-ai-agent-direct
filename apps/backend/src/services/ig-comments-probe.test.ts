import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeInstagramManageComments } from './ig-comments-probe.js';

describe('probeInstagramManageComments', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns ok when media + comments edges succeed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: 'media-1' }] }),
      })
      .mockResolvedValueOnce({
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: 'c1' }, { id: 'c2' }] }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeInstagramManageComments('178414000', 'page-token');
    expect(result.ok).toBe(true);
    expect(result.mediaId).toBe('media-1');
    expect(result.commentsReturned).toBe(2);
    expect(result.noteUk).toMatch(/instagram_manage_comments OK/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/media-1/comments');
  });

  it('explains empty media list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        text: async () => JSON.stringify({ data: [] }),
      }),
    );

    const result = await probeInstagramManageComments('178414000', 'page-token');
    expect(result.ok).toBe(false);
    expect(result.noteUk).toMatch(/немає постів/i);
  });
});
