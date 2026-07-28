import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';

const { execFileMock, healthCheckMock, getBinaryPathMock, verifyLiveMock, authCheckMock } =
  vi.hoisted(() => ({
    execFileMock: vi.fn(),
    healthCheckMock: vi.fn(),
    getBinaryPathMock: vi.fn(() => '/usr/bin/claude'),
    verifyLiveMock: vi.fn(),
    authCheckMock: vi.fn(),
  }));

vi.mock('./claude.js', () => ({
  claudeHealthCheck: healthCheckMock,
  getClaudeBinaryPath: getBinaryPathMock,
  verifyClaudeAuthLive: verifyLiveMock,
  claudeAuthCheck: authCheckMock,
  isClaudeAuthFailure: () => false,
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');

  const mockedExecFile = (
    file: string,
    args?: readonly string[] | null,
    options?: unknown,
    callback?: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (typeof options === 'function') {
      callback = options as typeof callback;
      options = undefined;
    }
    if (typeof callback === 'function') {
      Promise.resolve()
        .then(() => execFileMock(file, args, options))
        .then(
          (out: { stdout?: string; stderr?: string }) => {
            callback!(null, out?.stdout ?? '', out?.stderr ?? '');
          },
          (err: Error) => {
            callback!(err, '', '');
          },
        );
      return {} as never;
    }
    return execFileMock(file, args, options);
  };

  Object.defineProperty(mockedExecFile, promisify.custom, {
    configurable: true,
    value: (file: string, args?: readonly string[] | null, options?: unknown) =>
      Promise.resolve(execFileMock(file, args, options)),
  });

  return {
    ...actual,
    execFile: mockedExecFile,
  };
});

describe('logoutClaudeAuth', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    healthCheckMock.mockResolvedValue({
      ok: true,
      path: '/usr/bin/claude',
      version: '2.0.0',
      error: null,
    });
    verifyLiveMock.mockResolvedValue({ ok: false, error: null });
    authCheckMock.mockResolvedValue({ ok: false, error: null });
    getBinaryPathMock.mockReturnValue('/usr/bin/claude');
  });

  it('is idempotent when already logged out', async () => {
    execFileMock.mockImplementation((_file: string, args: string[] | null) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        return { stdout: JSON.stringify({ loggedIn: false }) };
      }
      return { stdout: '' };
    });

    const { logoutClaudeAuth, clearClaudeAuthLiveCache } = await import('./claude-auth.js');
    clearClaudeAuthLiveCache();
    const result = await logoutClaudeAuth();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyLoggedOut).toBe(true);
      expect(result.auth.loggedIn).toBe(false);
    }
    const logoutCalls = execFileMock.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1][0] === 'auth' && c[1][1] === 'logout',
    );
    expect(logoutCalls).toHaveLength(0);
  });

  it('runs claude auth logout when logged in', async () => {
    let loggedIn = true;
    execFileMock.mockImplementation((_file: string, args: string[] | null) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        return {
          stdout: JSON.stringify(
            loggedIn
              ? { loggedIn: true, email: 'a@b.com', authMethod: 'oauth' }
              : { loggedIn: false },
          ),
        };
      }
      if (args?.[0] === 'auth' && args?.[1] === 'logout') {
        loggedIn = false;
        return { stdout: 'Logged out' };
      }
      return { stdout: '' };
    });

    const { logoutClaudeAuth, clearClaudeAuthLiveCache } = await import('./claude-auth.js');
    clearClaudeAuthLiveCache();
    const result = await logoutClaudeAuth();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyLoggedOut).toBe(false);
      expect(result.auth.loggedIn).toBe(false);
    }
    const logoutCalls = execFileMock.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1][0] === 'auth' && c[1][1] === 'logout',
    );
    expect(logoutCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('returns BINARY_UNAVAILABLE when Claude CLI is missing', async () => {
    healthCheckMock.mockResolvedValue({
      ok: false,
      path: '/usr/bin/claude',
      version: null,
      error: 'claude not found',
    });
    const { logoutClaudeAuth } = await import('./claude-auth.js');
    const result = await logoutClaudeAuth();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('BINARY_UNAVAILABLE');
      expect(result.error).toContain('claude not found');
    }
  });
});
