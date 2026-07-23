import { computed } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js';
import { BASE } from '../constants.js';
import { escapeLine, sleepMs, isAbortError } from '../utils.js';

/**
 * Deploy log modal + SSE stream (with abort/session + auto-reconnect).
 * @param {object} deps
 */
export function createDeployLog(deps) {
  const {
    deployLog,
    deployJobs,
    deployLogEl,
    deploying,
    auth,
    nextTick,
    loadTenants,
  } = deps;

  let deployLogTickTimer = null;
  /** Bumps on every Log/Deploy open — stale SSE writers must not append. */
  let deployLogSession = 0;
  /** Aborts the in-flight fetch when Hide / re-open Log. */
  let deployLogAbort = null;

  function abortDeployLogStream() {
    if (deployLogAbort) {
      try { deployLogAbort.abort(); } catch { /* ignore */ }
      deployLogAbort = null;
    }
  }

  function beginDeployLogSession() {
    abortDeployLogStream();
    deployLogSession += 1;
    deployLogAbort = new AbortController();
    return { session: deployLogSession, signal: deployLogAbort.signal };
  }

  function closeDeployLog() {
    deployLog.open = false;
    abortDeployLogStream();
    stopDeployLogTicker();
  }

  const deployLogElapsed = computed(() => {
    void deployLog.tick;
    if (!deployLog.startedAt) return '';
    const start = Date.parse(deployLog.startedAt);
    if (Number.isNaN(start)) return '';
    const finishedAt = deployJobs[deployLog.tenantId]?.job?.finishedAt;
    const endMs = deployLog.running
      ? Date.now()
      : (finishedAt ? Date.parse(finishedAt) : Date.now());
    const sec = Math.max(0, Math.floor(((Number.isNaN(endMs) ? Date.now() : endMs) - start) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  });

  function syncDeployLogFromJob(job, runningOverride) {
    if (!job) {
      deployLog.status = null;
      deployLog.startedAt = null;
      deployLog.exitCode = null;
      if (runningOverride !== undefined) deployLog.running = !!runningOverride;
      return;
    }
    deployLog.jobId = job.id || deployLog.jobId;
    deployLog.status = job.status || null;
    deployLog.startedAt = job.startedAt || null;
    deployLog.exitCode = job.exitCode ?? null;
    deployLog.running = runningOverride !== undefined
      ? !!runningOverride
      : job.status === 'running';
  }

  function startDeployLogTicker() {
    if (deployLogTickTimer) return;
    deployLogTickTimer = setInterval(() => { deployLog.tick += 1; }, 1000);
  }

  function stopDeployLogTicker() {
    if (deployLogTickTimer) {
      clearInterval(deployLogTickTimer);
      deployLogTickTimer = null;
    }
  }

  function isDeployRunning(tenantId) {
    return !!deployJobs[tenantId]?.running;
  }

  function isDeployBusy(tenantId) {
    return deploying.value === tenantId || isDeployRunning(tenantId);
  }

  function authHeaders() {
    return { Authorization: `Bearer ${auth.token}` };
  }

  async function refreshDeployStatus(tenantId) {
    try {
      const r = await fetch(`${BASE}/tenants/${tenantId}/deploy/status`, { headers: authHeaders() });
      if (!r.ok) return;
      const d = await r.json();
      deployJobs[tenantId] = { running: !!d.running, job: d.job || null };
      if (deployLog.open && deployLog.tenantId === tenantId) {
        syncDeployLogFromJob(d.job || null, !!d.running);
        if (d.running) startDeployLogTicker();
        else stopDeployLogTicker();
      }
    } catch {
      // ignore
    }
  }

  function appendDeployLine(line, session) {
    if (session != null && session !== deployLogSession) return;
    if (line === '[stream] keepalive') return;
    if (
      (line.startsWith('[job] ') && line.includes(' status=')) ||
      (line.startsWith('[job] log='))
    ) {
      const already = deployLog.html && deployLog.html.includes(escapeLine(line));
      if (already) return;
    }
    const isErr = line.startsWith('[err]') || line.startsWith('[error]') || line.startsWith('[✗');
    const isStderr = line.startsWith('[stderr]');
    const isStream = line.startsWith('[stream]');
    const isWarn = /\bWARN:/i.test(line) || line.includes('skip upgrade');
    const isDone = line.startsWith('[✓') || line.startsWith('[✗') || line.startsWith('[job] finished');
    const escaped = escapeLine(line);
    let span;
    if (isErr) span = `<span class="err-line">${escaped}</span>`;
    else if (isStream) span = `<span class="meta-line">${escaped}</span>`;
    else if (isStderr) span = `<span class="stderr-line">${escaped}</span>`;
    else if (isWarn) span = `<span class="warn-line">${escaped}</span>`;
    else if (isDone) span = `<strong style="color:${line.startsWith('[✓') || line.includes('succeeded') ? '#22c55e' : '#ef4444'}">${escaped}</strong>`;
    else span = escaped;
    deployLog.html += (deployLog.html ? '\n' : '') + span;
    nextTick(() => {
      if (deployLogEl.value) deployLogEl.value.scrollTop = deployLogEl.value.scrollHeight;
    });
  }

  /** One SSE attach. Returns true if the job finished cleanly in this session. */
  async function streamDeployLogOnce(tenantId, jobId, fromEnd, session, signal) {
    const params = new URLSearchParams();
    if (jobId) params.set('jobId', jobId);
    if (fromEnd) params.set('fromEnd', '1');
    const qs = params.toString();
    const url = `${BASE}/tenants/${tenantId}/deploy/stream${qs ? `?${qs}` : ''}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${auth.token}` },
      signal,
    });
    if (!r.ok) {
      throw new Error(`HTTP ${r.status} ${r.statusText}`);
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let sawFinished = false;

    try {
      while (true) {
        if (signal.aborted || session !== deployLogSession) {
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          if (!part.startsWith('data: ')) continue;
          const line = part.slice(6);
          if (line.startsWith('[job] finished')) sawFinished = true;
          appendDeployLine(line, session);
        }
        if (deployJobs[tenantId]?.job) {
          syncDeployLogFromJob(deployJobs[tenantId].job, !!deployJobs[tenantId].running);
        }
      }
      if (buf.startsWith('data: ')) {
        const line = buf.slice(6);
        if (line.startsWith('[job] finished')) sawFinished = true;
        appendDeployLine(line, session);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    return sawFinished;
  }

  /**
   * Follow deploy log until the job finishes. Auto-reconnects when the
   * proxy/browser drops the SSE socket (common during long npm ci).
   */
  async function streamDeployLog(tenantId, jobId, session, signal) {
    let attempt = 0;
    const maxAttempts = 90;

    while (deployLog.open && session === deployLogSession && attempt < maxAttempts) {
      if (signal.aborted) return;
      try {
        const finished = await streamDeployLogOnce(
          tenantId,
          jobId,
          attempt > 0,
          session,
          signal,
        );
        if (session !== deployLogSession || signal.aborted) return;
        await refreshDeployStatus(tenantId);
        if (finished || !deployJobs[tenantId]?.running) return;

        attempt += 1;
        appendDeployLine(`[stream] connection closed — reconnecting… (${attempt})`, session);
        await sleepMs(Math.min(1000 + attempt * 500, 5000));
      } catch (e) {
        if (isAbortError(e) || session !== deployLogSession || signal.aborted) return;
        await refreshDeployStatus(tenantId);
        if (!deployJobs[tenantId]?.running) return;

        attempt += 1;
        const msg = (e && e.message) ? e.message : String(e);
        appendDeployLine(`[stream] ${msg} — reconnecting… (${attempt})`, session);
        await sleepMs(Math.min(1000 + attempt * 500, 5000));
      }
    }

    if (session !== deployLogSession || signal.aborted) return;
    await refreshDeployStatus(tenantId);
    if (deployJobs[tenantId]?.running && deployLog.open) {
      appendDeployLine(
        '[stream] live tail paused — open «Log» again to continue watching (deploy still running)',
        session,
      );
    }
  }

  async function openDeployLog(t) {
    await refreshDeployStatus(t.id);
    const job = deployJobs[t.id]?.job;
    const { session, signal } = beginDeployLogSession();
    deployLog.open = true;
    deployLog.name = t.name;
    deployLog.tenantId = t.id;
    deployLog.text = '';
    deployLog.html = '';
    syncDeployLogFromJob(job, !!deployJobs[t.id]?.running);
    startDeployLogTicker();

    if (!job?.id) {
      appendDeployLine('[error] No deploy job found', session);
      stopDeployLogTicker();
      return;
    }

    try {
      await streamDeployLog(t.id, job.id, session, signal);
    } catch (e) {
      if (!isAbortError(e) && session === deployLogSession) {
        appendDeployLine(`[error] ${e.message}`, session);
      }
    } finally {
      if (session !== deployLogSession) return;
      await refreshDeployStatus(t.id);
      syncDeployLogFromJob(deployJobs[t.id]?.job, !!deployJobs[t.id]?.running);
      if (!deployLog.running) stopDeployLogTicker();
      await loadTenants();
    }
  }

  async function triggerDeploy(t) {
    if (isDeployBusy(t.id)) {
      openDeployLog(t);
      return;
    }

    deploying.value = t.id;
    const { session, signal } = beginDeployLogSession();
    deployLog.open = true;
    deployLog.name = t.name;
    deployLog.tenantId = t.id;
    deployLog.jobId = null;
    deployLog.text = '';
    deployLog.html = '';
    deployLog.running = true;
    deployLog.status = 'running';
    deployLog.startedAt = new Date().toISOString();
    deployLog.exitCode = null;
    startDeployLogTicker();

    try {
      const startRes = await fetch(`${BASE}/tenants/${t.id}/deploy`, {
        method: 'POST',
        headers: authHeaders(),
        signal,
      });
      const startData = await startRes.json().catch(() => ({}));
      if (!startRes.ok) {
        appendDeployLine(`[error] ${startData.error || `HTTP ${startRes.status}`}`, session);
        return;
      }

      const jobId = startData.job?.id;
      deployJobs[t.id] = { running: true, job: startData.job || null };
      syncDeployLogFromJob(startData.job, true);
      if (!startData.started) {
        appendDeployLine('[job] Attach to already-running deploy', session);
      }

      await streamDeployLog(t.id, jobId, session, signal);
    } catch (e) {
      if (!isAbortError(e) && session === deployLogSession) {
        appendDeployLine(`[error] ${e.message}`, session);
      }
    } finally {
      if (session !== deployLogSession) {
        deploying.value = null;
        return;
      }
      deploying.value = null;
      await refreshDeployStatus(t.id);
      syncDeployLogFromJob(deployJobs[t.id]?.job, !!deployJobs[t.id]?.running);
      if (!deployLog.running) stopDeployLogTicker();
      await loadTenants();
    }
  }

  return {
    deployLogElapsed,
    closeDeployLog,
    openDeployLog,
    triggerDeploy,
    isDeployRunning,
    isDeployBusy,
    refreshDeployStatus,
  };
}
