import { describe, expect, it } from 'vitest';
import { formatWebhookSubscribeMessage } from './meta-page-subscribe.js';

describe('formatWebhookSubscribeMessage', () => {
  it('reports POST failure with status and body', () => {
    expect(
      formatWebhookSubscribeMessage({
        postOk: false,
        postStatus: 403,
        postBody: '{"error":{"message":"Requires pages_manage_metadata"}}',
      }),
    ).toBe(
      'Підписка webhook не пройшла: HTTP 403 — {"error":{"message":"Requires pages_manage_metadata"}}',
    );
  });

  it('treats GET 403 after successful POST as expected, not a failure', () => {
    expect(
      formatWebhookSubscribeMessage({
        postOk: true,
        postStatus: 200,
        readForbidden: true,
        readStatus: 403,
      }),
    ).toContain('пройшла успішно (POST)');
  });

  it('confirms all fields when GET succeeds', () => {
    expect(
      formatWebhookSubscribeMessage({
        postOk: true,
        readOk: true,
        subscribed: true,
      }),
    ).toBe('Підписка webhook на Page пройшла успішно. Усі поля активні.');
  });
});
