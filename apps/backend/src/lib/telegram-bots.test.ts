import { describe, expect, it } from 'vitest';
import {
  formatTelegramBotsPromptBlock,
  mergeTelegramIntegrationUpdate,
  normalizeTelegramConfig,
  resolveTelegramBotsForChannel,
} from './telegram-bots.js';

describe('normalizeTelegramConfig', () => {
  it('synthesizes primary bot from legacy flat fields', () => {
    const cfg = normalizeTelegramConfig({
      botToken: '123:ABC',
      managerGroupId: '-1001',
      adminPassword: 'secret',
    });
    expect(cfg.bots).toHaveLength(1);
    expect(cfg.bots[0]?.isPrimary).toBe(true);
    expect(cfg.bots[0]?.botToken).toBe('123:ABC');
    expect(cfg.botToken).toBe('123:ABC');
    expect(cfg.bots[0]?.channels).toContain('handoff');
  });

  it('ensures exactly one primary', () => {
    const cfg = normalizeTelegramConfig({
      bots: [
        {
          id: 'a',
          label: 'A',
          rolePrompt: '',
          botToken: '1:a',
          adminPassword: '',
          managerGroupId: '',
          enabled: true,
          isPrimary: true,
          channels: ['order'],
        },
        {
          id: 'b',
          label: 'B',
          rolePrompt: 'leads',
          botToken: '1:b',
          adminPassword: '',
          managerGroupId: '',
          enabled: true,
          isPrimary: true,
          channels: ['brief'],
        },
      ],
    });
    expect(cfg.bots.filter((b) => b.isPrimary)).toHaveLength(1);
  });
});

describe('resolveTelegramBotsForChannel', () => {
  it('routes to bots that opted into the channel', () => {
    const cfg = normalizeTelegramConfig({
      bots: [
        {
          id: 'ops',
          label: 'Ops',
          rolePrompt: 'system',
          botToken: '1:ops',
          adminPassword: '',
          managerGroupId: '',
          enabled: true,
          isPrimary: true,
          channels: ['auth', 'agent_failure'],
        },
        {
          id: 'sales',
          label: 'Sales',
          rolePrompt: 'leads only',
          botToken: '1:sales',
          adminPassword: '',
          managerGroupId: '',
          enabled: true,
          isPrimary: false,
          channels: ['brief', 'order'],
        },
      ],
    });

    expect(resolveTelegramBotsForChannel(cfg, 'brief').map((b) => b.id)).toEqual(['sales']);
    expect(resolveTelegramBotsForChannel(cfg, 'auth').map((b) => b.id)).toEqual(['ops']);
  });

  it('falls back to primary when nobody opted in', () => {
    const cfg = normalizeTelegramConfig({
      bots: [
        {
          id: 'primary',
          label: 'P',
          rolePrompt: '',
          botToken: '1:p',
          adminPassword: '',
          managerGroupId: '',
          enabled: true,
          isPrimary: true,
          channels: ['handoff'],
        },
        {
          id: 'other',
          label: 'O',
          rolePrompt: '',
          botToken: '1:o',
          adminPassword: '',
          managerGroupId: '',
          enabled: true,
          isPrimary: false,
          channels: ['order'],
        },
      ],
    });
    expect(resolveTelegramBotsForChannel(cfg, 'brief').map((b) => b.id)).toEqual(['primary']);
  });
});

describe('formatTelegramBotsPromptBlock', () => {
  it('never includes tokens', () => {
    const cfg = normalizeTelegramConfig({
      botToken: '123:SECRETTOKEN',
      managerGroupId: '-100',
      adminPassword: 'pw',
    });
    const block = formatTelegramBotsPromptBlock(cfg);
    expect(block).toContain('<telegram_bots>');
    expect(block).not.toContain('SECRETTOKEN');
    expect(block).not.toContain('pw');
  });
});

describe('mergeTelegramIntegrationUpdate', () => {
  it('preserves masked bot tokens by id', () => {
    const existing = normalizeTelegramConfig({
      bots: [
        {
          id: 'a',
          label: 'A',
          rolePrompt: 'role',
          botToken: '1:real-token',
          adminPassword: 'pass',
          managerGroupId: '-1',
          enabled: true,
          isPrimary: true,
          channels: ['ops'],
        },
      ],
    }) as unknown as Record<string, unknown>;

    const merged = mergeTelegramIntegrationUpdate(
      existing,
      {
        bots: [
          {
            id: 'a',
            label: 'A2',
            rolePrompt: 'role2',
            botToken: '••••••',
            adminPassword: '••••••',
            managerGroupId: '-1',
            enabled: true,
            isPrimary: true,
            channels: ['ops', 'brief'],
          },
        ],
      },
      (v) => typeof v === 'string' && v.startsWith('••••••'),
    );

    const bots = merged.bots as Array<{ botToken: string; adminPassword: string; label: string }>;
    expect(bots[0]?.botToken).toBe('1:real-token');
    expect(bots[0]?.adminPassword).toBe('pass');
    expect(bots[0]?.label).toBe('A2');
  });
});
