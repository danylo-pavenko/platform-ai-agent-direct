import { computed } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js';
import { BASE } from '../constants.js';
import { escapeLine, sleepMs, isAbortError } from '../utils.js';

/**
 * Destroy confirm modal + log SSE (mirrors deploy-log, uses /destroy/*).
 */
export function createDestroyLog(deps) {
  const {
    destroyModal,
    destroyLog,
    destroyJobs,
    destroyLogEl,
    destroying,
    auth,
    nextTick,
    loadTenants,
  } = deps;

  let tickTimer = null;
  let session = 0;
  let abortCtrl = null;

  function authHeaders() {
    return { Authorization: `Bearer ${auth.token}` };
  }

  function abortStream() {
    if (abortCtrl) {
      try { abortCtrl.abort(); } catch { /* ignore */ }
      abortCtrl = null;
    }
  }

  function beginSession() {
    abortStream();
    session += 1;
    abortCtrl = new AbortController();
    return { sessionId: session, signal: abortCtrl.signal };
  }

  function closeDestroyLog() {
    destroyLog.open = false;
    abortStream();
    stopTicker();
  }

  function closeDestroyModal() {
    if (destroying.value) return;
    destroyModal.open = false;
    destroyModal.tenant = null;
    destroyModal.confirmInstanceId = '';
    destroyModal.error = '';
  }

  const destroyLogElapsed = computed(() => {
    void destroyLog.tick;
    if (!destroyLog.startedAt) return '';
    const start = Date.parse(destroyLog.startedAt);
    if (Number.isNaN(start)) return '';
    const finishedAt = destroyJobs[destroyLog.tenantId]?.job?.finishedAt;
    const endMs = destroyLog.running
      ? Date.now()
      : (finishedAt ? Date.parse(finishedAt) : Date.now());
    const sec = Math.max(0, Math.floor(((Number.isNaN(endMs) ? Date.now() : endMs) - start) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  });

  const confirmMatches = computed(() => {
    const t = destroyModal.tenant;
    if (!t) return false;
    return String(destroyModal.confirmInstanceId || '').trim().toLowerCase() === String(t.instanceId).toLowerCase();
  });

  function syncFromJob(job, runningOverride) {
    if (!job) {
      destroyLog.status = null;
      destroyLog.startedAt = null;
      destroyLog.exitCode = null;
      if (runningOverride !== undefined) destroyLog.running = !!runningOverride;
      return;
    }
    destroyLog.jobId = job.id || destroyLog.jobId;
    destroyLog.status = job.status || null;
    destroyLog.startedAt = job.startedAt || null;
    destroyLog.exitCode = job.exitCode ?? null;
    destroyLog.running = runningOverride !== undefined
      ? !!runningOverride
      : job.status === 'running';
  }

  function startTicker() {
    if (tickTimer) return;
    tickTimer = setInterval(() => { destroyLog.tick += 1; }, 1000);
  }

  function stopTicker() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function isDestroyRunning(tenantId) {
    return !!destroyJobs[tenantId]?.running;
  }

  function isDestroyBusy(tenantId) {
    return destroying.value === tenantId || isDestroyRunning(tenantId);
  }

  async function refreshDestroyStatus(tenantId) {
    try {
      const r = await fetch(`${BASE}/tenants/${tenantId}/destroy/status`, { headers: authHeaders() });
      if (r.status === 404) {
        destroyJobs[tenantId] = { running: false, job: null };
        return;
      }
      if (!r.ok) return;
      const d = await r.json();
      destroyJobs[tenantId] = { running: !!d.running, job: d.job || null };
      if (destroyLog.open && destroyLog.tenantId === tenantId) {
        syncFromJob(d.job || null, !!d.running);
        if (d.running) startTicker();
        else stopTicker();
      }
    } catch {
      // ignore
    }
  }

  function appendLine(line, sessionId) {
    if (sessionId != null && sessionId !== session) return;
    if (line === '[stream] keepalive') return;
    destroyLog.text += (destroyLog.text ? '\n' : '') + line;
    const cls = line.startsWith('[error]') || line.startsWith('[✗') || line.startsWith('ERROR:')
      ? 'err'
      : line.startsWith('[✓') || line.startsWith('[job] finished: succeeded')
        ? 'ok'
        : '';
    destroyLog.html += `<div class="${cls}">${escapeLine(line)}</div>`;
    nextTick(() => {
      const el = destroyLogEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  async function streamOnce(tenantId, jobId, fromEnd, sessionId, signal) {
    const q = new URLSearchParams();
    if (jobId) q.set('jobId', jobId);
    if (fromEnd) q.set('fromEnd', '1');
    const r = await fetch(`${BASE}/tenants/${tenantId}/destroy/stream?${q}`, {
      headers: authHeaders(),
      signal,
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        for (const raw of part.split('\n')) {
          if (raw.startsWith('data: ')) appendLine(raw.slice(6), sessionId);
        }
      }
    }
  }

  async function streamDestroyLog(tenantId, jobId, sessionId, signal) {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        await streamOnce(tenantId, jobId, attempt > 0, sessionId, signal);
        await refreshDestroyStatus(tenantId);
        if (!destroyJobs[tenantId]?.running) break;
        attempt += 1;
        appendLine(`[stream] connection closed — reconnecting… (${attempt})`, sessionId);
        await sleepMs(800);
      } catch (e) {
        if (isAbortError(e) || signal.aborted) break;
        attempt += 1;
        appendLine(`[stream] ${e.message || e} — reconnecting… (${attempt})`, sessionId);
        await sleepMs(Math.min(4000, 600 * attempt));
        await refreshDestroyStatus(tenantId);
        if (!destroyJobs[tenantId]?.running) break;
      }
    }
  }

  function openDestroyModal(t) {
    destroyModal.open = true;
    destroyModal.tenant = t;
    destroyModal.confirmInstanceId = '';
    destroyModal.error = '';
  }

  async function openDestroyLog(t) {
    await refreshDestroyStatus(t.id);
    const { sessionId, signal } = beginSession();
    destroyLog.open = true;
    destroyLog.name = t.name;
    destroyLog.tenantId = t.id;
    destroyLog.text = '';
    destroyLog.html = '';
    const job = destroyJobs[t.id]?.job;
    destroyLog.jobId = job?.id || null;
    syncFromJob(job, !!destroyJobs[t.id]?.running);
    startTicker();
    if (!job?.id) {
      appendLine('[error] No destroy job found', sessionId);
      stopTicker();
      return;
    }
    try {
      await streamDestroyLog(t.id, job.id, sessionId, signal);
    } catch (e) {
      if (!isAbortError(e)) appendLine(`[error] ${e.message}`, sessionId);
    } finally {
      await refreshDestroyStatus(t.id);
      syncFromJob(destroyJobs[t.id]?.job, !!destroyJobs[t.id]?.running);
      if (!destroyLog.running) stopTicker();
      await loadTenants();
    }
  }

  async function confirmDestroy() {
    const t = destroyModal.tenant;
    if (!t || !confirmMatches.value) return;
    destroyModal.error = '';
    destroying.value = t.id;

    const { sessionId, signal } = beginSession();
    destroyModal.open = false;
    destroyLog.open = true;
    destroyLog.name = t.name;
    destroyLog.tenantId = t.id;
    destroyLog.text = '';
    destroyLog.html = '';
    destroyLog.running = true;
    destroyLog.status = 'running';
    destroyLog.startedAt = new Date().toISOString();
    destroyLog.exitCode = null;
    destroyLog.jobId = null;
    startTicker();
    appendLine(`[destroy] confirming instanceId=${t.instanceId}`, sessionId);

    try {
      const startRes = await fetch(`${BASE}/tenants/${t.id}/destroy`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmInstanceId: t.instanceId }),
        signal,
      });
      const startData = await startRes.json().catch(() => ({}));
      if (!startRes.ok) {
        appendLine(`[error] ${startData.error || `HTTP ${startRes.status}`}`, sessionId);
        destroyLog.running = false;
        destroyLog.status = 'failed';
        return;
      }
      const jobId = startData.job?.id;
      destroyLog.jobId = jobId;
      destroyJobs[t.id] = { running: true, job: startData.job };
      syncFromJob(startData.job, true);
      if (!jobId) {
        appendLine('[error] No job id from server', sessionId);
        return;
      }
      await streamDestroyLog(t.id, jobId, sessionId, signal);
    } catch (e) {
      if (!isAbortError(e)) appendLine(`[error] ${e.message}`, sessionId);
      destroyLog.running = false;
      destroyLog.status = 'failed';
    } finally {
      destroying.value = null;
      await refreshDestroyStatus(t.id);
      syncFromJob(destroyJobs[t.id]?.job, !!destroyJobs[t.id]?.running);
      if (!destroyLog.running) stopTicker();
      await loadTenants();
    }
  }

  return {
    openDestroyModal,
    closeDestroyModal,
    confirmDestroy,
    confirmMatches,
    openDestroyLog,
    closeDestroyLog,
    isDestroyRunning,
    isDestroyBusy,
    refreshDestroyStatus,
    destroyLogElapsed,
  };
}
