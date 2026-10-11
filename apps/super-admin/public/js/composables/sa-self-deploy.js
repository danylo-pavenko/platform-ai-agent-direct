import { computed } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js';
import { BASE } from '../constants.js';
import { escapeLine, sleepMs, isAbortError } from '../utils.js';

/**
 * Super Admin self-deploy (deploy-super-admin.sh) from the sidebar.
 * Survives API restart during PM2 bounce via status poll + SSE reconnect.
 */
export function createSaSelfDeploy(deps) {
  const {
    saDeployLog,
    saDeployLogEl,
    saSelfDeployBusy,
    saVersionLabel,
    auth,
    nextTick,
    loadSaVersion,
  } = deps;

  let tickTimer = null;
  let session = 0;
  let abortCtrl = null;

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

  function closeSaDeployLog() {
    saDeployLog.open = false;
    abortStream();
    stopTicker();
  }

  const saDeployLogElapsed = computed(() => {
    void saDeployLog.tick;
    if (!saDeployLog.startedAt) return '';
    const start = Date.parse(saDeployLog.startedAt);
    if (Number.isNaN(start)) return '';
    const endMs = saDeployLog.running
      ? Date.now()
      : (saDeployLog.finishedAt ? Date.parse(saDeployLog.finishedAt) : Date.now());
    const sec = Math.max(0, Math.floor(((Number.isNaN(endMs) ? Date.now() : endMs) - start) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  });

  function syncFromJob(job, runningOverride) {
    if (!job) {
      saDeployLog.status = null;
      saDeployLog.startedAt = null;
      saDeployLog.finishedAt = null;
      saDeployLog.exitCode = null;
      if (runningOverride !== undefined) saDeployLog.running = !!runningOverride;
      return;
    }
    saDeployLog.jobId = job.id || saDeployLog.jobId;
    saDeployLog.status = job.status || null;
    saDeployLog.startedAt = job.startedAt || null;
    saDeployLog.finishedAt = job.finishedAt || null;
    saDeployLog.exitCode = job.exitCode ?? null;
    saDeployLog.running = runningOverride !== undefined
      ? !!runningOverride
      : job.status === 'running';
  }

  function startTicker() {
    if (tickTimer) return;
    tickTimer = setInterval(() => { saDeployLog.tick += 1; }, 1000);
  }

  function stopTicker() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function authHeaders() {
    return { Authorization: `Bearer ${auth.token}` };
  }

  async function refreshStatus() {
    try {
      const r = await fetch(`${BASE}/platform/self-deploy/status`, { headers: authHeaders() });
      if (!r.ok) return null;
      const d = await r.json();
      const running = !!d.running;
      saSelfDeployBusy.value = running;
      if (saDeployLog.open) {
        syncFromJob(d.job || null, running);
        if (running) startTicker();
        else stopTicker();
      } else if (d.job) {
        saSelfDeployBusy.value = running;
      }
      return d;
    } catch {
      return null;
    }
  }

  function appendLine(line, sessionId) {
    if (sessionId != null && sessionId !== session) return;
    if (line === '[stream] keepalive') return;
    if (
      (line.startsWith('[job] ') && line.includes(' status=')) ||
      line.startsWith('[job] log=')
    ) {
      const already = saDeployLog.html && saDeployLog.html.includes(escapeLine(line));
      if (already) return;
    }
    const isErr = line.startsWith('[err]') || line.startsWith('[error]') || line.startsWith('[✗');
    const isStderr = line.startsWith('[stderr]');
    const isStream = line.startsWith('[stream]');
    const isWarn = /\bWARN:/i.test(line) || line.includes('skip upgrade');
    const isDone = line.startsWith('[✓') || line.startsWith('[✗') || line.startsWith('[job] finished') || line.startsWith('[self-deploy] finished');
    const escaped = escapeLine(line);
    let span;
    if (isErr) span = `<span class="err-line">${escaped}</span>`;
    else if (isStream) span = `<span class="meta-line">${escaped}</span>`;
    else if (isStderr) span = `<span class="stderr-line">${escaped}</span>`;
    else if (isWarn) span = `<span class="warn-line">${escaped}</span>`;
    else if (isDone) {
      const ok = line.startsWith('[✓') || line.includes('succeeded');
      span = `<strong style="color:${ok ? '#22c55e' : '#ef4444'}">${escaped}</strong>`;
    } else span = escaped;
    saDeployLog.html += (saDeployLog.html ? '\n' : '') + span;
    nextTick(() => {
      if (saDeployLogEl.value) saDeployLogEl.value.scrollTop = saDeployLogEl.value.scrollHeight;
    });
  }

  async function streamOnce(jobId, fromEnd, sessionId, signal) {
    const params = new URLSearchParams();
    if (jobId) params.set('jobId', jobId);
    if (fromEnd) params.set('fromEnd', '1');
    const qs = params.toString();
    const url = `${BASE}/platform/self-deploy/stream${qs ? `?${qs}` : ''}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${auth.token}` },
      signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let sawFinished = false;

    try {
      while (true) {
        if (signal.aborted || sessionId !== session) {
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
          appendLine(line, sessionId);
        }
      }
      if (buf.startsWith('data: ')) {
        const line = buf.slice(6);
        if (line.startsWith('[job] finished')) sawFinished = true;
        appendLine(line, sessionId);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    return sawFinished;
  }

  async function streamUntilDone(jobId, sessionId, signal) {
    let attempt = 0;
    const maxAttempts = 120;

    while (saDeployLog.open && sessionId === session && attempt < maxAttempts) {
      if (signal.aborted) return;
      try {
        const finished = await streamOnce(jobId, attempt > 0, sessionId, signal);
        if (sessionId !== session || signal.aborted) return;
        const st = await refreshStatus();
        if (finished || !st?.running) return;

        attempt += 1;
        appendLine(`[stream] connection closed — reconnecting… (${attempt})`, sessionId);
        await sleepMs(Math.min(1000 + attempt * 500, 5000));
      } catch (e) {
        if (isAbortError(e) || sessionId !== session || signal.aborted) return;
        // Expected while PM2 restarts SA-api
        const st = await refreshStatus();
        if (st && !st.running) return;

        attempt += 1;
        const msg = (e && e.message) ? e.message : String(e);
        appendLine(`[stream] ${msg} — waiting for API… (${attempt})`, sessionId);
        await sleepMs(Math.min(1500 + attempt * 400, 6000));
      }
    }
  }

  async function openSaDeployLog(job) {
    await refreshStatus();
    const { sessionId, signal } = beginSession();
    saDeployLog.open = true;
    saDeployLog.html = '';
    syncFromJob(job || null, job?.status === 'running');
    startTicker();

    const jobId = job?.id || saDeployLog.jobId;
    if (!jobId) {
      appendLine('[error] No self-deploy job found', sessionId);
      stopTicker();
      return;
    }

    try {
      await streamUntilDone(jobId, sessionId, signal);
    } catch (e) {
      if (!isAbortError(e) && sessionId === session) {
        appendLine(`[error] ${e.message}`, sessionId);
      }
    } finally {
      if (sessionId !== session) return;
      await refreshStatus();
      if (!saDeployLog.running) {
        stopTicker();
        try {
          await loadSaVersion?.();
        } catch { /* ignore */ }
      }
    }
  }

  async function triggerSaSelfDeploy() {
    if (saSelfDeployBusy.value) {
      const st = await refreshStatus();
      if (st?.job) await openSaDeployLog(st.job);
      return;
    }

    const ok = window.confirm(
      'Оновити Super Admin?\n\n'
      + 'Запустить git pull + build + PM2 restart (deploy-super-admin.sh).\n'
      + 'UI може коротко відключитися — лог можна відкрити знову після рестарту.',
    );
    if (!ok) return;

    saSelfDeployBusy.value = true;
    try {
      const r = await fetch(`${BASE}/platform/self-deploy`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 409) {
        window.alert(d.error || `HTTP ${r.status}`);
        saSelfDeployBusy.value = false;
        return;
      }
      const job = d.job;
      if (!job?.id) {
        window.alert(d.error || 'No job returned');
        saSelfDeployBusy.value = false;
        return;
      }
      await openSaDeployLog(job);
    } catch (e) {
      window.alert(e.message || 'Network error');
      saSelfDeployBusy.value = false;
    }
  }

  async function resumeSaSelfDeployIfRunning() {
    const st = await refreshStatus();
    if (st?.running && st.job) {
      // Do not auto-open modal on page load — just mark busy for the button.
      saSelfDeployBusy.value = true;
    }
  }

  return {
    saDeployLogElapsed,
    closeSaDeployLog,
    triggerSaSelfDeploy,
    openSaDeployLog,
    refreshSaSelfDeployStatus: refreshStatus,
    resumeSaSelfDeployIfRunning,
  };
}
