import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import {
  claudeAuthCheck,
  claudeHealthCheck,
  getClaudeBinaryPath,
  verifyClaudeAuthLive,
} from './claude.js';

const log = pino({ name: 'claude-auth' });

/** Tenant has this long to open the OAuth URL and paste the callback code. */
const SESSION_TTL_MS = 5 * 60 * 1000;
/** Fail only if CLI never prints an OAuth URL within this window. */
const URL_WAIT_MS = 60_000;
const START_URL_WAIT_MS = 30_000;
const LOGIN_RATE_LIMIT_MS = 60_000;
const LIVE_AUTH_CACHE_MS = 45_000;

export interface ClaudeAuthStatus {
  binaryOk: boolean;
  binaryPath: string;
  binaryVersion: string | null;
  loggedIn: boolean;
  /** auth status JSON said loggedIn but live API probe failed (401 / expired token). */
  sessionExpired: boolean;
  authMethod: string | null;
  email: string | null;
  subscriptionType: string | null;
  orgName: string | null;
  error: string | null;
  loginInProgress: boolean;
}

export interface GetClaudeAuthStatusOptions {
  /** Bypass live-probe cache (Settings "Перевірити статус"). */
  skipLiveCache?: boolean;
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
  codeSubmitted: boolean;
}

const sessions = new Map<string, LoginSession>();
let lastLoginStartAt = 0;
let liveAuthCache: { at: number; ok: boolean; error: string | null } | null = null;

export function clearClaudeAuthLiveCache(): void {
  liveAuthCache = null;
}

async function verifyClaudeAuthLiveCached(skipCache: boolean): Promise<{ ok: boolean; error: string | null }> {
  if (
    !skipCache &&
    liveAuthCache &&
    Date.now() - liveAuthCache.at < LIVE_AUTH_CACHE_MS
  ) {
    return liveAuthCache;
  }

  const result = await verifyClaudeAuthLive();
  liveAuthCache = { at: Date.now(), ok: result.ok, error: result.error };
  return liveAuthCache;
}

/** Strip ANSI escape codes from `script`/PTY output. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

/** Extract OAuth URL printed by `claude auth login`. */
export function extractClaudeAuthUrl(text: string): string | null {
  const clean = stripAnsi(text);
  const match = clean.match(
    /https:\/\/(?:claude\.(?:ai|com)|console\.anthropic\.com)\/[^\s"'<>)\]]+/i,
  );
  if (!match) return null;
  return match[0].replace(/[)\].,]+$/, '');
}

/** Headless-server env: skip real browser launch, print OAuth URL immediately. */
function buildAuthLoginEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI: 'true',
    BROWSER: process.platform === 'linux' ? '/bin/false' : 'false',
    DISPLAY: '',
  };
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

/** Drop stale local credentials so OAuth re-login is not short-circuited by `auth status`. */
async function clearStaleClaudeAuthBeforeLogin(): Promise<void> {
  const json = await readAuthStatusJson();
  if (json?.loggedIn !== true) return;

  const path = getClaudeBinaryPath();
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync(path, ['auth', 'logout'], {
      timeout: 10_000,
      env: { ...process.env },
      maxBuffer: 64 * 1024,
    });
    clearClaudeAuthLiveCache();
    log.info('Cleared stale Claude credentials before OAuth login');
  } catch (err) {
    log.warn({ err }, 'claude auth logout before login failed (continuing)');
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
    session.error = 'Час сесії авторизації минув (5 хвилин)';
  }
  session.child = null;
}

function spawnAuthLoginProcess(): ChildProcess {
  const claude = getClaudeBinaryPath();
  const env = buildAuthLoginEnv();
  const stdio: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe'];
  if (process.platform === 'linux') {
    return spawn('script', ['-qefc', `${claude} auth login`, '/dev/null'], {
      env,
      stdio,
    });
  }
  return spawn(claude, ['auth', 'login'], {
    env,
    stdio,
  });
}

function attachLoginListeners(session: LoginSession): void {
  const child = session.child;
  if (!child) return;

  const append = (chunk: Buffer | string) => {
    session.output += stripAnsi(chunk.toString());
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
      // `auth status` may still say loggedIn while tokens are expired — require live probe.
      if (session.codeSubmitted || code === 0) {
        const live = await verifyClaudeAuthLive();
        if (live.ok) {
          session.status = 'completed';
          session.error = null;
          clearClaudeAuthLiveCache();
          return;
        }
        if (session.codeSubmitted) {
          session.status = 'failed';
          session.error = live.error ?? 'Авторизацію не завершено';
          return;
        }
      }

      session.status = 'failed';
      session.error =
        session.error ??
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

/** Compact snapshot for meta-agent / supervisor prompts (no secrets). */
export function formatClaudeAuthSnapshot(status: ClaudeAuthStatus): Record<string, unknown> {
  return {
    binaryOk: status.binaryOk,
    binaryPath: status.binaryPath,
    binaryVersion: status.binaryVersion,
    loggedIn: status.loggedIn,
    sessionExpired: status.sessionExpired,
    email: status.email,
    subscriptionType: status.subscriptionType,
    authMethod: status.authMethod,
    loginInProgress: status.loginInProgress,
    error: status.error,
  };
}

/** XML block injected into meta-agent system prompt. */
export function buildClaudeAuthPromptBlock(status: ClaudeAuthStatus): string {
  const snapshot = JSON.stringify(formatClaudeAuthSnapshot(status), null, 2);
  return `\n\n<claude_runtime>
Стан Claude CLI на цьому інстансі (read-only, оновлюється на кожен запит):
${snapshot}

Якщо адмін питає, чи авторизований Claude / чи працює CLI — відповідай з цих даних.
Не пропонуй запускати shell-команди для перевірки auth.
</claude_runtime>`;
}

/** Full Claude auth status for tenant admin. */
export async function getClaudeAuthStatus(
  opts: GetClaudeAuthStatusOptions = {},
): Promise<ClaudeAuthStatus> {
  cleanupExpiredSessions();

  const binary = await claudeHealthCheck();
  const loginInProgress = [...sessions.values()].some(
    (s) => s.status === 'starting' || s.status === 'waiting',
  );

  const baseUnavailable = (error: string): ClaudeAuthStatus => ({
    binaryOk: false,
    binaryPath: binary.path,
    binaryVersion: binary.version,
    loggedIn: false,
    sessionExpired: false,
    authMethod: null,
    email: null,
    subscriptionType: null,
    orgName: null,
    error,
    loginInProgress,
  });

  if (!binary.ok) {
    return baseUnavailable(binary.error ?? 'Claude CLI недоступний');
  }

  const json = await readAuthStatusJson();
  const sessionCheck = await claudeAuthCheck();
  const reportedlyLoggedIn = json?.loggedIn === true || (json?.loggedIn !== false && sessionCheck.ok);

  if (!reportedlyLoggedIn) {
    return {
      binaryOk: true,
      binaryPath: binary.path,
      binaryVersion: binary.version,
      loggedIn: false,
      sessionExpired: false,
      authMethod: json?.authMethod ?? null,
      email: json?.email ?? null,
      subscriptionType: json?.subscriptionType ?? null,
      orgName: json?.orgName ?? null,
      error: sessionCheck.error ?? 'Claude не авторизовано',
      loginInProgress,
    };
  }

  // Skip live probe while OAuth login is in progress — tokens may not be ready yet.
  if (loginInProgress) {
    return {
      binaryOk: true,
      binaryPath: binary.path,
      binaryVersion: binary.version,
      loggedIn: false,
      sessionExpired: false,
      authMethod: json?.authMethod ?? null,
      email: json?.email ?? null,
      subscriptionType: json?.subscriptionType ?? null,
      orgName: json?.orgName ?? null,
      error: null,
      loginInProgress: true,
    };
  }

  const live = await verifyClaudeAuthLiveCached(Boolean(opts.skipLiveCache));
  if (!live.ok) {
    return {
      binaryOk: true,
      binaryPath: binary.path,
      binaryVersion: binary.version,
      loggedIn: false,
      sessionExpired: true,
      authMethod: json?.authMethod ?? null,
      email: json?.email ?? null,
      subscriptionType: json?.subscriptionType ?? null,
      orgName: json?.orgName ?? null,
      error: live.error,
      loginInProgress: false,
    };
  }

  return {
    binaryOk: true,
    binaryPath: binary.path,
    binaryVersion: binary.version,
    loggedIn: true,
    sessionExpired: false,
    authMethod: json?.authMethod ?? null,
    email: json?.email ?? null,
    subscriptionType: json?.subscriptionType ?? null,
    orgName: json?.orgName ?? null,
    error: null,
    loginInProgress: false,
  };
}

export interface StartClaudeLoginResult {
  sessionId: string;
  authUrl: string | null;
  status: LoginSessionStatus;
  error: string | null;
}

function waitForAuthUrl(session: LoginSession, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (session.authUrl) {
      resolve();
      return;
    }
    const deadline = Date.now() + maxMs;
    const timer = setInterval(() => {
      if (!session.authUrl) {
        const url = extractClaudeAuthUrl(session.output);
        if (url) {
          session.authUrl = url;
          session.status = 'waiting';
        }
      }
      if (session.authUrl || Date.now() >= deadline) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
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
    codeSubmitted: false,
  };

  try {
    await clearStaleClaudeAuthBeforeLogin();
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
  await waitForAuthUrl(session, START_URL_WAIT_MS);

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
  /** CLI process is running and ready to accept the OAuth callback code on stdin. */
  expectsCode: boolean;
  codeSubmitted: boolean;
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

  // Only finish after the tenant pasted the OAuth code — stale `auth status` must not
  // complete the session while `claude auth login` is still waiting on stdin.
  if (
    (session.status === 'waiting' || session.status === 'starting') &&
    session.codeSubmitted
  ) {
    const live = await verifyClaudeAuthLive();
    if (live.ok) {
      session.status = 'completed';
      session.error = null;
      clearClaudeAuthLiveCache();
      if (session.child && !session.child.killed) session.child.kill('SIGTERM');
    }
  }

  let authSnapshot =
    session.status === 'completed'
      ? await getClaudeAuthStatus({ skipLiveCache: true })
      : null;

  if (session.status === 'completed' && authSnapshot && !authSnapshot.loggedIn) {
    session.status = 'failed';
    session.error = authSnapshot.error ?? 'Авторизацію не завершено';
    authSnapshot = null;
  }

  return {
    sessionId: session.id,
    status: session.status,
    authUrl: session.authUrl,
    error: session.error,
    expectsCode: session.status === 'waiting' || session.status === 'starting',
    codeSubmitted: session.codeSubmitted,
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

export interface SubmitClaudeAuthCodeResult {
  ok: boolean;
  error: string | null;
}

/** Pipe OAuth callback code from tenant browser into the running `claude auth login` process. */
export function submitClaudeAuthCode(
  sessionId: string,
  code: string,
): SubmitClaudeAuthCodeResult {
  cleanupExpiredSessions();
  const session = sessions.get(sessionId);
  if (!session) {
    return { ok: false, error: 'Сесію не знайдено або вона закінчилась' };
  }
  if (session.status !== 'waiting' && session.status !== 'starting') {
    return { ok: false, error: 'Сесія не очікує код авторизації' };
  }
  if (session.codeSubmitted) {
    return { ok: false, error: 'Код уже надіслано — зачекайте перевірки або почніть заново' };
  }

  const trimmed = code.trim();
  if (!trimmed || trimmed.length < 10) {
    return { ok: false, error: 'Невірний формат коду авторизації' };
  }
  if (!session.child?.stdin) {
    return {
      ok: false,
      error: 'Процес авторизації недоступний — натисніть «Увійти в Claude» ще раз',
    };
  }

  try {
    session.child.stdin.write(`${trimmed}\n`);
    session.child.stdin.end();
    session.codeSubmitted = true;
    return { ok: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, sessionId }, 'Failed to write OAuth code to claude auth login stdin');
    return { ok: false, error: message };
  }
}
