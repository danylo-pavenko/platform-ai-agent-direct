import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('./claude-auth.js', () => ({ getClaudeAuthStatus: vi.fn() }));
vi.mock('../config.js', () => ({
  config: { INSTANCE_NAME: 'Test tenant', BRAND_NAME: 'Test brand' },
}));
vi.mock('../lib/agent-config.js', () => ({ getAgentConfig: vi.fn() }));
vi.mock('../lib/crm-routing.js', () => ({ getCrmRouting: vi.fn() }));
vi.mock('../lib/crm-write.js', () => ({ isCrmWriteReady: vi.fn() }));
vi.mock('../lib/integration-config.js', () => ({ getIntegrationConfig: vi.fn() }));
vi.mock('../lib/paths.js', () => ({ getTenantKnowledgeDir: vi.fn(() => '/tmp') }));
vi.mock('../lib/runtime-config.js', () => ({ getRuntimeConfig: vi.fn() }));

import {
  buildSafeIntegrationSummary,
  insightsPeriodStart,
  parseInsightsPeriod,
  redactInsightText,
  truncateInsightText,
} from './insights-snapshot.js';

describe('insights snapshot helpers', () => {
  it('accepts supported periods and defaults unknown values to 7d', () => {
    expect(parseInsightsPeriod('30D')).toBe('30d');
    expect(parseInsightsPeriod('90d')).toBe('90d');
    expect(parseInsightsPeriod('all')).toBe('all');
    expect(parseInsightsPeriod('lifetime')).toBe('7d');
    expect(parseInsightsPeriod(undefined)).toBe('7d');
  });

  it('calculates an exact rolling period start', () => {
    const now = new Date('2026-07-16T12:00:00.000Z');
    expect(insightsPeriodStart('7d', now)?.toISOString()).toBe(
      '2026-07-09T12:00:00.000Z',
    );
    expect(insightsPeriodStart('30d', now)?.toISOString()).toBe(
      '2026-06-16T12:00:00.000Z',
    );
    expect(insightsPeriodStart('all', now)).toBeNull();
  });

  it('redacts email and Ukrainian phone numbers from dialogue samples', () => {
    const text =
      'Напишіть test.user@example.com, +38 (067) 123-45-67 або +44 20 7946 0958';
    expect(redactInsightText(text)).toBe(
      'Напишіть [email приховано], [телефон приховано] або [телефон приховано]',
    );
  });

  it('normalizes whitespace and truncates long samples', () => {
    expect(truncateInsightText('  Привіт\n\n  світе  ', 30)).toBe('Привіт світе');
    expect(truncateInsightText('abcdefghij', 6)).toBe('abcde…');
  });

  it('projects integration readiness without leaking any secret values', () => {
    const safe = buildSafeIntegrationSummary({
      meta: {
        facebookAppId: 'secret-app-id',
        facebookAppSecret: 'secret-app-secret',
        pageId: 'page-id',
        pageAccessToken: 'secret-page-token',
        userAccessToken: 'secret-user-token',
        igUserId: 'ig-id',
        igUsername: 'business',
        verifyToken: 'secret-verify-token',
      },
      telegram: {
        botToken: 'secret-legacy-token',
        managerGroupId: 'group-id',
        adminPassword: 'secret-password',
        bots: [{
          id: 'primary',
          label: 'Primary',
          rolePrompt: '',
          botToken: 'secret-bot-token',
          adminPassword: 'secret-bot-password',
          managerGroupId: 'group-id',
          enabled: true,
          isPrimary: true,
          channels: ['order'],
        }],
      },
      keycrm: {
        apiKey: 'secret-keycrm-key',
        syncIntervalMin: 30,
        defaultSourceId: 1,
        appUrl: 'https://example.keycrm.app',
      },
      cleverbox: {
        apiToken: 'secret-cleverbox-token',
        defaultBranchId: 'branch-id',
        syncIntervalMin: 60,
      },
      novaposhta: {
        apiKey: 'secret-np-key',
        senderCity: 'Київ',
        senderCityRef: 'city-ref',
      },
    });

    expect(safe).toEqual({
      instagramConfigured: true,
      instagramUsername: 'business',
      telegramBotsConfigured: 1,
      keycrmConfigured: true,
      cleverboxConfigured: true,
      novaPoshtaConfigured: true,
      novaPoshtaSenderCity: 'Київ',
    });
    expect(JSON.stringify(safe)).not.toContain('secret');
  });
});
