/**
 * End-to-end self-deploy lifecycle (real detached bash wrapper + flock).
 * Uses a fake deploy script — never touches git/PM2.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import {
  followSaSelfDeployLog,
  getSaSelfDeployStatus,
  startSaSelfDeploy,
} from './sa-self-deploy.js';
import { saSelfDeployRoutes } from '../routes/sa-self-deploy.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForTerminal(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { running, job } = getSaSelfDeployStatus();
    if (job && !running && job.status !== 'running') return job;
    await sleep(80);
  }
  throw new Error(
    `timeout waiting for self-deploy terminal status: ${JSON.stringify(getSaSelfDeployStatus())}`,
  );
}

describe('sa-self-deploy e2e', () => {
  let dir: string;
  let fakeOk: string;
  let fakeFail: string;
  let fakeSlow: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sa-self-deploy-e2e-'));
    process.env.SA_SELF_DEPLOY_DIR = dir;

    fakeOk = join(dir, 'fake-deploy-ok.sh');
    fakeFail = join(dir, 'fake-deploy-fail.sh');
    fakeSlow = join(dir, 'fake-deploy-slow.sh');

    writeFileSync(
      fakeOk,
      '#!/usr/bin/env bash\nset -euo pipefail\necho "[fake] pull"\necho "[fake] build"\necho "[fake] pm2 restart"\necho "[✓ Health OK (HTTP 200)"\nexit 0\n',
    );
    writeFileSync(
      fakeFail,
      '#!/usr/bin/env bash\necho "[fake] boom" >&2\nexit 7\n',
    );
    writeFileSync(
      fakeSlow,
      '#!/usr/bin/env bash\nset -euo pipefail\necho "[fake] slow start"\nsleep 1.5\necho "[fake] slow done"\nexit 0\n',
    );
    chmodSync(fakeOk, 0o755);
    chmodSync(fakeFail, 0o755);
    chmodSync(fakeSlow, 0o755);

    process.env.SA_SELF_DEPLOY_SCRIPT_OVERRIDE = fakeOk;
    delete process.env.SA_SELF_DEPLOY_WRAPPER_OVERRIDE;
  });

  afterEach(() => {
    delete process.env.SA_SELF_DEPLOY_DIR;
    delete process.env.SA_SELF_DEPLOY_SCRIPT_OVERRIDE;
    delete process.env.SA_SELF_DEPLOY_WRAPPER_OVERRIDE;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('runs wrapper → fake deploy → succeeded job.json + log', async () => {
    const started = startSaSelfDeploy();
    expect(started.started).toBe(true);
    expect(started.job.id).toBeTruthy();
    expect(started.job.status).toBe('running');

    const final = await waitForTerminal();
    const log = readFileSync(join(dir, 'current.log'), 'utf8');
    if (final.status !== 'succeeded') {
      throw new Error(`expected succeeded, got ${final.status}\nLOG:\n${log}\nJOB:\n${readFileSync(join(dir, 'job.json'), 'utf8')}`);
    }
    expect(final.exitCode).toBe(0);
    expect(final.finishedAt).toBeTruthy();

    expect(log).toContain('[self-deploy] requested by Super Admin UI');
    expect(log).toContain('[fake] pull');
    expect(log).toContain('[✓ Health OK');
    expect(log).toContain('finished: succeeded');

    const status = getSaSelfDeployStatus();
    expect(status.running).toBe(false);
    expect(status.job?.status).toBe('succeeded');
  });

  it('records failed when fake deploy exits non-zero', async () => {
    process.env.SA_SELF_DEPLOY_SCRIPT_OVERRIDE = fakeFail;
    const started = startSaSelfDeploy();
    expect(started.started).toBe(true);

    const final = await waitForTerminal();
    expect(final.status).toBe('failed');
    expect(final.exitCode).toBe(7);

    const log = readFileSync(join(dir, 'current.log'), 'utf8');
    expect(log).toContain('finished: failed');
  });

  it('rejects a second start while the first job is still running', async () => {
    process.env.SA_SELF_DEPLOY_SCRIPT_OVERRIDE = fakeSlow;
    const first = startSaSelfDeploy();
    expect(first.started).toBe(true);

    // Wait until status reports running (wrapper up + lock held)
    const waitRun = Date.now();
    while (Date.now() - waitRun < 5_000) {
      if (getSaSelfDeployStatus().running) break;
      await sleep(50);
    }
    expect(getSaSelfDeployStatus().running).toBe(true);

    const second = startSaSelfDeploy();
    expect(second.started).toBe(false);
    expect(second.error).toMatch(/already/i);

    const final = await waitForTerminal();
    expect(final.status).toBe('succeeded');
    expect(final.id).toBe(first.job.id);
  });

  it('followSaSelfDeployLog streams until finished', async () => {
    const started = startSaSelfDeploy();
    expect(started.started).toBe(true);

    const lines: string[] = [];
    await followSaSelfDeployLog(
      started.job.id,
      (line) => lines.push(line),
      () => true,
    );

    expect(lines.some((l) => l.includes('[job] finished: succeeded'))).toBe(true);
    expect(lines.some((l) => l.includes('[fake] pull') || l.includes('Health OK'))).toBe(true);
  });

  it('HTTP: auth required, POST starts job, status + stream complete', async () => {
    const app = Fastify({ logger: false });
    await app.register(fastifyJwt, { secret: 'e2e-test-jwt-secret!!' });
    app.decorate('authenticate', async (req: any, reply: any) => {
      try {
        await req.jwtVerify();
      } catch {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
    });
    await app.register(saSelfDeployRoutes);
    await app.ready();

    const unauth = await app.inject({ method: 'POST', url: '/api/platform/self-deploy' });
    expect(unauth.statusCode).toBe(401);

    const token = app.jwt.sign({ username: 'superadmin', role: 'superadmin' });

    const post = await app.inject({
      method: 'POST',
      url: '/api/platform/self-deploy',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(post.statusCode).toBe(200);
    const body = post.json() as { started: boolean; job: { id: string; status: string } };
    expect(body.started).toBe(true);
    expect(body.job.id).toBeTruthy();

    const final = await waitForTerminal();
    expect(final.status).toBe('succeeded');

    const statusRes = await app.inject({
      method: 'GET',
      url: '/api/platform/self-deploy/status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(statusRes.statusCode).toBe(200);
    const st = statusRes.json() as { running: boolean; job: { status: string } };
    expect(st.running).toBe(false);
    expect(st.job.status).toBe('succeeded');

    // Stream after finish still returns job finished marker
    const streamRes = await app.inject({
      method: 'GET',
      url: `/api/platform/self-deploy/stream?jobId=${body.job.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(streamRes.statusCode).toBe(200);
    expect(streamRes.headers['content-type']).toContain('text/event-stream');
    expect(streamRes.body).toContain('[job] finished: succeeded');

    await app.close();
  });
});
