import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/agent-config.js', () => ({
  getAgentConfig: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: {
    SA_INTERNAL_URL: 'https://sa.example',
    SUPERVISOR_SHARED_SECRET: 'secret',
    INSTANCE_ID: 'demo',
  },
}));

import { getAgentConfig } from '../lib/agent-config.js';
import {
  evaluateAutoUpdateGate,
  runAutoUpdateTick,
} from './auto-update.js';

describe('evaluateAutoUpdateGate', () => {
  it('skips when disabled', () => {
    expect(
      evaluateAutoUpdateGate({
        autoUpdateEnabled: false,
        saConfigured: true,
        localCode: 10,
        remote: { name: '1.0', code: 20 },
      }),
    ).toEqual({ shouldRequest: false, reason: 'autoUpdateEnabled=false' });
  });

  it('skips when SA not configured', () => {
    expect(
      evaluateAutoUpdateGate({
        autoUpdateEnabled: true,
        saConfigured: false,
        localCode: 10,
        remote: { name: '1.0', code: 20 },
      }).shouldRequest,
    ).toBe(false);
  });

  it('skips when remote equal or lower', () => {
    expect(
      evaluateAutoUpdateGate({
        autoUpdateEnabled: true,
        saConfigured: true,
        localCode: 20,
        remote: { name: '1.0', code: 20 },
      }).shouldRequest,
    ).toBe(false);
    expect(
      evaluateAutoUpdateGate({
        autoUpdateEnabled: true,
        saConfigured: true,
        localCode: 21,
        remote: { name: '1.0', code: 20 },
      }).shouldRequest,
    ).toBe(false);
  });

  it('requests when remote code is higher', () => {
    expect(
      evaluateAutoUpdateGate({
        autoUpdateEnabled: true,
        saConfigured: true,
        localCode: 10,
        remote: { name: '1.1', code: 11 },
      }),
    ).toEqual({ shouldRequest: true, reason: 'remote code higher' });
  });
});

describe('runAutoUpdateTick', () => {
  beforeEach(() => {
    vi.mocked(getAgentConfig).mockReset();
  });

  it('POSTs auto-update only when remote code is higher', async () => {
    vi.mocked(getAgentConfig).mockResolvedValue({
      autoUpdateEnabled: true,
      timezone: 'Europe/Kyiv',
    } as Awaited<ReturnType<typeof getAgentConfig>>);

    const requestUpdate = vi.fn().mockResolvedValue({ started: true });
    const result = await runAutoUpdateTick({
      getLocalVersion: () => ({ name: '1.0', code: 100 }),
      fetchVersion: async () => ({ name: '1.1', code: 105 }),
      requestUpdate,
    });

    expect(result).toMatchObject({
      action: 'requested',
      localCode: 100,
      remoteCode: 105,
      started: true,
    });
    expect(requestUpdate).toHaveBeenCalledOnce();
  });

  it('does not POST when local is current', async () => {
    vi.mocked(getAgentConfig).mockResolvedValue({
      autoUpdateEnabled: true,
      timezone: 'Europe/Kyiv',
    } as Awaited<ReturnType<typeof getAgentConfig>>);

    const requestUpdate = vi.fn();
    const result = await runAutoUpdateTick({
      getLocalVersion: () => ({ name: '1.1', code: 105 }),
      fetchVersion: async () => ({ name: '1.1', code: 105 }),
      requestUpdate,
    });

    expect(result.action).toBe('noop');
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it('skips when toggle off', async () => {
    vi.mocked(getAgentConfig).mockResolvedValue({
      autoUpdateEnabled: false,
      timezone: 'Europe/Kyiv',
    } as Awaited<ReturnType<typeof getAgentConfig>>);

    const requestUpdate = vi.fn();
    const result = await runAutoUpdateTick({
      getLocalVersion: () => ({ name: '1.0', code: 1 }),
      fetchVersion: async () => ({ name: '9.0', code: 999 }),
      requestUpdate,
    });

    expect(result).toEqual({ action: 'skipped', reason: 'autoUpdateEnabled=false' });
    expect(requestUpdate).not.toHaveBeenCalled();
  });
});
