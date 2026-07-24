import { BASE } from '../constants.js';

export function createWorkers(deps) {
  const { workers, workerModal, authHeaders, headers, logout } = deps;

  async function loadWorkers() {
    try {
      const r = await fetch(`${BASE}/workers`, { headers: authHeaders() });
      if (r.status === 401) { logout(); return; }
      workers.value = await r.json();
    } catch (e) {
      console.error('loadWorkers failed:', e);
      workers.value = [];
    }
  }

  function emptyWorkerForm() {
    return {
      name: '',
      baseUrl: 'https://',
      publicIp: '',
      maxTenants: 12,
    };
  }

  function openAddWorkerModal() {
    workerModal.editing = null;
    workerModal.form = emptyWorkerForm();
    workerModal.createdSecret = '';
    workerModal.bootstrapHint = '';
    workerModal.testResult = null;
    workerModal.open = true;
  }

  function openEditWorkerModal(w) {
    workerModal.editing = w.id;
    workerModal.form = {
      name: w.name,
      baseUrl: w.baseUrl || '',
      publicIp: w.publicIp || '',
      maxTenants: w.maxTenants || 12,
      status: w.status || 'active',
      rotateSecret: '',
    };
    workerModal.createdSecret = '';
    workerModal.bootstrapHint = '';
    workerModal.testResult = null;
    workerModal.open = true;
  }

  async function saveWorker() {
    workerModal.saving = true;
    workerModal.error = '';
    try {
      if (workerModal.editing) {
        const payload = {
          baseUrl: workerModal.form.baseUrl.trim() || null,
          publicIp: workerModal.form.publicIp.trim(),
          maxTenants: Number(workerModal.form.maxTenants) || 12,
          status: workerModal.form.status,
        };
        if (workerModal.form.rotateSecret?.trim()) {
          payload.sharedSecret = workerModal.form.rotateSecret.trim();
        }
        const r = await fetch(`${BASE}/workers/${workerModal.editing}`, {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          workerModal.error = err.error || 'Save failed';
          return;
        }
        workerModal.open = false;
        await loadWorkers();
        return;
      }

      const r = await fetch(`${BASE}/workers`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          name: workerModal.form.name.trim().toLowerCase(),
          baseUrl: workerModal.form.baseUrl.trim(),
          publicIp: workerModal.form.publicIp.trim(),
          maxTenants: Number(workerModal.form.maxTenants) || 12,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        workerModal.error = d.error || 'Create failed';
        return;
      }
      workerModal.createdSecret = d.sharedSecret || '';
      workerModal.bootstrapHint = d.bootstrapHint || '';
      await loadWorkers();
    } finally {
      workerModal.saving = false;
    }
  }

  async function testWorker(w) {
    workerModal.testResult = { loading: true };
    try {
      const r = await fetch(`${BASE}/workers/${w.id}/test`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const d = await r.json().catch(() => ({}));
      workerModal.testResult = { loading: false, ...d, name: w.name };
      if (!workerModal.open) {
        alert(d.ok ? `Worker «${w.name}» OK` : `Worker «${w.name}»: ${d.error || 'failed'}`);
      }
    } catch (e) {
      workerModal.testResult = { loading: false, ok: false, error: e.message };
    }
  }

  async function deleteWorker(w) {
    if (w.kind === 'local') return;
    if (!confirm(`Delete worker «${w.name}»?`)) return;
    const r = await fetch(`${BASE}/workers/${w.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(err.error || 'Delete failed');
      return;
    }
    await loadWorkers();
  }

  return {
    loadWorkers,
    openAddWorkerModal,
    openEditWorkerModal,
    saveWorker,
    testWorker,
    deleteWorker,
  };
}
