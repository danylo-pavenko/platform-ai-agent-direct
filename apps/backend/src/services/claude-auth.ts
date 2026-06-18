import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import {
  claudeAuthCheck,
  claudeHealthCheck,
  getClaudeBinaryPath,
} from './claude.js';

const log = pino({ name: 'claude-auth' });

const SESSION_TTL_MS = 10 * 60 * 1000;
const URL_WAIT_MS = 45_000;
const LOGIN_RATE_LIMIT_MS = 60_000;

export interface ClaudeAuthStatus {
  binaryOk: boolean;
  binaryPath: string;
  binaryVersion: string | null;
  loggedIn: boolean;
  authMethod: string | null;
  email: string | null;
  subscriptionType: string | null;
  orgName: string | null;
  error: string | null;
  loginInProgress: boolean;
}

interface AuthStatusJson {
  loggedIn?: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
  orgName?: string;
}

type LoginSessionStatus = 'starting' | 'waiting' | 'completed' | 'failed' | 'cancelled';

interface LoginSession {
  id: string;
  startedAt: number;
  authUrl: string | null;
  status: LoginSessionStatus;
  error: string | null;
  child: ChildProcess | null;
  output: string;
}

const sessions = new Map<string, LoginSession>();
let lastLoginStartAt = 0;

/** Extract OAuth URL printed by `claude auth login`. */
export function extractClaudeAuthUrl(text: string): string | null {
  const match = text.match(
    /https:\/\/(?:claude\.ai|console\.anthropic\.com)\/[^\s"'<>)\]]+/i,
  );
  if (!match) return null;
  return match[0].replace(/[)\].,]+$/, '');
}

function parseAuthStatusJson(stdout: string): AuthStatusJson | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed) as AuthStatusJson;
  } catch {
    return null;
  }
}

async function readAuthStatusJson(): Promise<AuthStatusJson | null> {
  const path = getClaudeBinaryPath();
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync(path, ['auth', 'status'], {
      timeout: 8000,
      env: { ...process.env },
      maxBuffer: 64 * 1024,
    });
    return parseAuthStatusJson(stdout);
  } catch {
    return null;
  }
}

function cleanupExpiredSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.startedAt < cutoff) {
      cancelLoginSession(id, 'expired');
    }
  }
}

function cancelLoginSession(id: string, reason: 'cancelled' | 'expired' = 'cancelled'): void {
  const session = sessions.get(id);
  if (!session) return;
  if (session.child && !session.child.killed) {
    session.child.kill('SIGTERM');
  }
  session.status = reason === 'expired' ? 'failed' : 'cancelled';
  if (reason === 'expired') {
    session.error = 'Час сесії авторизації минув';
  }
  session.child = null;
}

function spawnAuthLoginProcess(): ChildProcess {
  const claude = getClaudeBinaryPath();
  if (process.platform === 'linux') {
    return spawn('script', ['-q', '-c', `${claude} auth login`, '/dev/null'], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return spawn(claude, ['auth', 'login'], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function attachLoginListeners(session: LoginSession): void {
  const child = session.child;
  if (!child) return;

  const append = (chunk: Buffer | string) => {
    session.output += chunk.toString();
    if (!session.authUrl) {
      const url = extractClaudeAuthUrl(session.output);
      if (url) {
        session.authUrl = url;
        session.status = 'waiting';
      }
    }
  };

  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  child.on('error', (err) => {
    session.status = 'failed';
    session.error = err.message;
    session.child = null;
  });

  child.on('close', (code) => {
    session.child = null;
    if (session.status === 'completed' || session.status === 'cancelled') return;

    void (async () => {
      const auth = await claudeAuthCheck();
      if (auth.ok) {
        session.status = 'completed';
        session.error = null;
        return;
      }
      if (session.status === 'waiting' && code === 0) {
        session.status = 'completed';
        return;
      }
      session.status = 'failed';
      session.error =
        auth.error ??
        (code !== 0 ? `claude auth login завершився з кодом ${code}` : 'Авторизацію не завершено');
    })();
  });

  setTimeout(() => {
    if (session.status === 'starting' && !session.authUrl) {
      session.status = 'failed';
      session.error = 'Не вдалося отримати посилання для входу з Claude CLI';
      if (session.child && !session.child.killed) session.child.kill('SIGTERM');
    }
  }, URL_WAIT_MS);
}

/** Full Claude auth status for tenant admin. */
export async function getClaudeAuthStatus(): Promise<ClaudeAuthStatus> {
  cleanupExpiredSessions();

  const binary = await claudeHealthCheck();
  const loginInProgress = [...sessions.values()].some(
    (s) => s.status === 'starting' || s.status === 'waiting',
  );

  if (!binary.ok) {
    return {
      binaryOk: false,
      binaryPath: binary.path,
      binaryVersion: binary.version,
      loggedIn: false,
      authMethod: null,
      email: null,
      subscriptionType: null,
      orgName: null,
      error: binary.error ?? 'Claude CLI недоступний',
      loginInProgress,
    };
  }

  const json = await readAuthStatusJson();
  if (json?.loggedIn) {
    return {
      binaryOk: true,
      binaryPath: binary.path,
      binaryVersion: binary.version,
      loggedIn: true,
      authMethod: json.authMethod ?? null,
      email: json.email ?? null,
      subscriptionType: json.subscriptionType ?? null,
      orgName: json.orgName ?? null,
      error: null,
      loginInProgress,
    };
  }

  const auth = await claudeAuthCheck();
  return {
    binaryOk: true,
    binaryPath: binary.path,
    binaryVersion: binary.version,
    loggedIn: auth.ok,
    authMethod: json?.authMethod ?? null,
    email: json?.email ?? null,
    subscriptionType: json?.subscriptionType ?? null,
    orgName: json?.orgName ?? null,
    error: auth.ok ? null : auth.error,
    loginInProgress,
  };
}

export interface StartClaudeLoginResult {
  sessionId: string;
  authUrl: string | null;
  status: LoginSessionStatus;
  error: string | null;
}

/** Begin interactive OAuth via Claude CLI under the tenant Linux user. */
export async function startClaudeAuthLogin(): Promise<StartClaudeLoginResult> {
  cleanupExpiredSessions();

  const now = Date.now();
  if (now - lastLoginStartAt < LOGIN_RATE_LIMIT_MS) {
    return {
      sessionId: '',
      authUrl: null,
      status: 'failed',
      error: 'Зачекайте хвилину перед повторною спробою входу',
    };
  }

  for (const [id, session] of sessions) {
    if (session.status === 'starting' || session.status === 'waiting') {
      cancelLoginSession(id);
    }
  }

  lastLoginStartAt = now;
  const sessionId = randomUUID();
  const session: LoginSession = {
    id: sessionId,
    startedAt: now,
    authUrl: null,
    status: 'starting',
    error: null,
    child: null,
    output: '',
  };

  try {
    session.child = spawnAuthLoginProcess();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to spawn claude auth login');
    return {
      sessionId: '',
      authUrl: null,
      status: 'failed',
      error: message,
    };
  }

  sessions.set(sessionId, session);
  attachLoginListeners(session);

  return {
    sessionId,
    authUrl: session.authUrl,
    status: session.status,
    error: session.error,
  };
}

export interface ClaudeLoginStatusResult {
  sessionId: string;
  status: LoginSessionStatus;
  authUrl: string | null;
  error: string | null;
  auth: ClaudeAuthStatus | null;
}

/** Poll login session; refreshes auth snapshot when completed. */
export async function getClaudeLoginStatus(sessionId: string): Promise<ClaudeLoginStatusResult | null> {
  cleanupExpiredSessions();
  const session = sessions.get(sessionId);
  if (!session) return null;

  if (
    (session.status === 'waiting' || session.status === 'starting') &&
    !session.authUrl
  ) {
    const url = extractClaudeAuthUrl(session.output);
    if (url) {
      session.authUrl = url;
      session.status = 'waiting';
    }
  }

  if (session.status === 'waiting' || session.status === 'starting') {
    const auth = await claudeAuthCheck();
    if (auth.ok) {
      session.status = 'completed';
      session.error = null;
      if (session.child && !session.child.killed) session.child.kill('SIGTERM');
    }
  }

  const authSnapshot =
    session.status === 'completed' ? await getClaudeAuthStatus() : null;

  return {
    sessionId: session.id,
    status: session.status,
    authUrl: session.authUrl,
    error: session.error,
    auth: authSnapshot,
  };
}

export function cancelClaudeAuthLogin(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (session.status === 'completed') return true;
  cancelLoginSession(sessionId);
  return true;
}
