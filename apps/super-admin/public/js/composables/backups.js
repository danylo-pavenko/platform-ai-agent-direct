import { BASE } from '../constants.js';

/**
 * Tenant DB backups page — list, backup now, restore + job log stream.
 */
export function createBackups(deps) {
  const {
    backups,
    backupsFilter,
    backupLog,
    backupLogEl,
    tenants,
    workers,
    authHeaders,
    headers,
    logout,
    nextTick,
  } = deps;

  let streamAbort = null;

  async function loadBackups() {
    try {
      const qs = new URLSearchParams();
      if (backupsFilter.tenantId) qs.set('tenantId', backupsFilter.tenantId);
      if (backupsFilter.serverId) qs.set('serverId', backupsFilter.serverId);
      qs.set('limit', '200');
      const r = await fetch(`${BASE}/backups?${qs}`, { headers: authHeaders() });
      if (r.status === 401) { logout(); return; }
      const d = await r.json();
      backups.value = d.backups || [];
    } catch (e) {
      console.error('loadBackups failed:', e);
      backups.value = [];
    }
  }

  function formatBytes(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function openBackupLog(job) {
    if (streamAbort) streamAbort.abort();
    streamAbort = new AbortController();
    backupLog.open = true;
    backupLog.html = '';
    backupLog.running = job.status === 'running';
    backupLog.jobId = job.id;
    backupLog.kind = job.kind || 'backup';
    backupLog.status = job.status;
    await streamBackupJob(job.id, streamAbort.signal);
  }

  function appendLogLine(line) {
    const esc = line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const cls = line.startsWith('[error]') || line.includes('FAILED') || line.startsWith('[✗')
      ? 'style="color:var(--danger)"'
      : line.startsWith('[✓') || line.includes('succeeded')
        ? 'style="color:var(--success)"'
        : '';
    backupLog.html += `<div ${cls}>${esc}</div>`;
    nextTick(() => {
      if (backupLogEl.value) backupLogEl.value.scrollTop = backupLogEl.value.scrollHeight;
    });
  }

  async function streamBackupJob(jobId, signal) {
    try {
      const r = await fetch(`${BASE}/backups/jobs/${jobId}/stream`, {
        headers: authHeaders(),
        signal,
      });
      if (!r.ok) {
        appendLogLine(`[error] HTTP ${r.status}`);
        backupLog.running = false;
        return;
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
          if (!part.startsWith('data: ')) continue;
          const line = part.slice(6);
          appendLogLine(line);
          if (line.startsWith('[job] finished')) {
            backupLog.running = false;
            backupLog.status = line.includes('succeeded') ? 'succeeded' : 'failed';
          }
        }
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
      appendLogLine(`[error] ${e.message || e}`);
    } finally {
      backupLog.running = false;
      await loadBackups();
    }
  }

  function closeBackupLog() {
    if (streamAbort) streamAbort.abort();
    streamAbort = null;
    backupLog.open = false;
  }

  async function backupTenantNow(tenantId) {
    const r = await fetch(`${BASE}/tenants/${tenantId}/backup`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({}),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 409) {
      alert(d.error || `HTTP ${r.status}`);
      return;
    }
    if (d.job) await openBackupLog(d.job);
  }

  async function restoreBackup(row) {
    const id = row.tenant?.instanceId || '';
    const typed = window.prompt(
      `Відновити БД «${id}» з\n${row.storageKey}\n\nВведіть instanceId для підтвердження:`,
      '',
    );
    if (!typed) return;
    const r = await fetch(`${BASE}/tenants/${row.tenantId}/restore`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ storageKey: row.storageKey, confirmInstanceId: typed.trim() }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 409) {
      alert(d.error || `HTTP ${r.status}`);
      return;
    }
    if (d.job) await openBackupLog(d.job);
  }

  return {
    loadBackups,
    formatBytes,
    backupTenantNow,
    restoreBackup,
    openBackupLog,
    closeBackupLog,
  };
}
