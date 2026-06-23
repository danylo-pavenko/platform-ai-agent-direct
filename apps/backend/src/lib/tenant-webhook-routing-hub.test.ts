import { describe, expect, it } from 'vitest';
import {
  collectWebhookDebugCandidateIds,
  collectWebhookRoutingCandidateIds,
  mergeTenantInstagramRoutingIds,
} from './webhook-routing-candidates.js';

describe('collectWebhookRoutingCandidateIds', () => {
  it('uses recipient.id for messaging events (entry.id is sender)', () => {
    const ids = collectWebhookRoutingCandidateIds([
      {
        id: '17841410659012767',
        messaging: [
          {
            sender: { id: '17841410659012767' },
            recipient: { id: '1003830218675544' },
          },
        ],
      },
    ]);
    expect([...ids]).toEqual(['1003830218675544']);
  });

  it('falls back to entry.id when no messaging recipients', () => {
    const ids = collectWebhookRoutingCandidateIds([{ id: '17841411782835655' }]);
    expect([...ids]).toEqual(['17841411782835655']);
  });
});

describe('mergeTenantInstagramRoutingIds', () => {
  it('drops stale extras when primary IG account changes', () => {
    const tenant = {
      instagramUserId: '178414OLD00000001',
      instagramRoutingIds: ['11805240761', '1193115350549873'],
    };
    const merged = mergeTenantInstagramRoutingIds(
      tenant,
      ['17841411782835655', '1003830218675544', '1193115350549873'],
      '17841411782835655',
    );
    expect(merged).not.toContain('11805240761');
    expect(merged).toContain('1003830218675544');
  });
});

describe('collectWebhookDebugCandidateIds', () => {
  it('includes sender and recipient for troubleshooting', () => {
    const ids = collectWebhookDebugCandidateIds([
      {
        id: '17841410659012767',
        messaging: [
          {
            sender: { id: '17841410659012767' },
            recipient: { id: '1003830218675544' },
          },
        ],
      },
    ]);
    expect(ids.has('17841410659012767')).toBe(true);
    expect(ids.has('1003830218675544')).toBe(true);
  });
});
