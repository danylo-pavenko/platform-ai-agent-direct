import { describe, expect, it } from 'vitest';
import {
  collectWebhookRoutingCandidateIds,
  selectTenantWebhookTargetKinds,
  webhookPayloadHasEcho,
  webhookPayloadHasNonEchoWork,
} from './webhook-routing-candidates.js';

const CULTURA_BUSINESS = '17841437228550639';
const CULTURA_IG_ID = '1971149383793917';
const CLIENT_IGSID = '17841410659012767';

describe('collectWebhookRoutingCandidateIds', () => {
  it('uses recipient.id for inbound messaging (entry.id is sender)', () => {
    const ids = collectWebhookRoutingCandidateIds([
      {
        id: CLIENT_IGSID,
        messaging: [
          {
            sender: { id: CLIENT_IGSID },
            recipient: { id: CULTURA_IG_ID },
          },
        ],
      },
    ]);
    expect([...ids]).toEqual([CULTURA_IG_ID]);
  });

  it('uses business sender + entry.id for echoes, never the client recipient', () => {
    const ids = collectWebhookRoutingCandidateIds([
      {
        id: CULTURA_BUSINESS,
        messaging: [
          {
            sender: { id: CULTURA_BUSINESS },
            recipient: { id: CLIENT_IGSID },
            message: { is_echo: true },
          },
        ],
      },
    ]);
    expect(ids.has(CULTURA_BUSINESS)).toBe(true);
    expect(ids.has(CLIENT_IGSID)).toBe(false);
  });

  it('falls back to entry.id when no messaging recipients', () => {
    const ids = collectWebhookRoutingCandidateIds([{ id: '17841411782835655' }]);
    expect([...ids]).toEqual(['17841411782835655']);
  });
});

describe('selectTenantWebhookTargetKinds', () => {
  it('forwards inbound only for a client DM', () => {
    expect(
      selectTenantWebhookTargetKinds([
        {
          messaging: [
            {
              sender: { id: CLIENT_IGSID },
              recipient: { id: CULTURA_IG_ID },
              message: { is_echo: false },
            },
          ],
        },
      ]),
    ).toEqual(['inbound']);
    expect(
      webhookPayloadHasEcho([
        {
          messaging: [
            {
              sender: { id: CLIENT_IGSID },
              recipient: { id: CULTURA_IG_ID },
              message: {},
            },
          ],
        },
      ]),
    ).toBe(false);
  });

  it('forwards echo only for a page echo (skips inbound route)', () => {
    const entries = [
      {
        messaging: [
          {
            sender: { id: CULTURA_BUSINESS },
            recipient: { id: CLIENT_IGSID },
            message: { is_echo: true },
          },
        ],
      },
    ];
    expect(webhookPayloadHasEcho(entries)).toBe(true);
    expect(webhookPayloadHasNonEchoWork(entries)).toBe(false);
    expect(selectTenantWebhookTargetKinds(entries)).toEqual(['echo']);
  });

  it('forwards both paths for a mixed batch', () => {
    expect(
      selectTenantWebhookTargetKinds([
        {
          messaging: [
            {
              sender: { id: CLIENT_IGSID },
              recipient: { id: CULTURA_IG_ID },
              message: { is_echo: false },
            },
            {
              sender: { id: CULTURA_BUSINESS },
              recipient: { id: CLIENT_IGSID },
              message: { is_echo: true },
            },
          ],
        },
      ]),
    ).toEqual(['inbound', 'echo']);
  });
});
