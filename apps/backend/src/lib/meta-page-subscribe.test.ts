import { describe, expect, it } from 'vitest';
import {
  formatWebhookSubscribeMessage,
  META_PAGE_WEBHOOK_FIELDS,
} from './meta-page-subscribe.js';

describe('META_PAGE_WEBHOOK_FIELDS', () => {
  it('omits messaging_seen which Graph v25 rejects on subscribed_apps', () => {
    expect(META_PAGE_WEBHOOK_FIELDS).not.toContain('messaging_seen');
    expect([...META_PAGE_WEBHOOK_FIELDS]).toEqual([
      'messages',
      'messaging_postbacks',
      'message_reactions',
      'standby',
    ]);
  });
});

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
