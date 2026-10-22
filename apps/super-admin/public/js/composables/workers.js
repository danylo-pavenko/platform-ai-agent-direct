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
      s3Enabled: false,
      s3Endpoint: '',
      s3Bucket: '',
      s3Region: 'us-east-1',
      s3ForcePathStyle: true,
      s3AccessKey: '',
      s3SecretAccessKey: '',
      secretConfigured: false,
      s3LastTestOk: null,
    };
    workerModal.createdSecret = '';
    workerModal.bootstrapHint = '';
    workerModal.testResult = null;
    workerModal.s3TestResult = null;
    workerModal.open = true;
    void loadWorkerBackupStorage(w.id);
  }

  async function loadWorkerBackupStorage(workerId) {
    try {
      const r = await fetch(`${BASE}/workers/${workerId}/backup-storage`, { headers: authHeaders() });
      if (!r.ok) return;
      const d = await r.json();
      workerModal.form.s3Enabled = !!d.s3Enabled;
      workerModal.form.s3Endpoint = d.s3Endpoint || '';
      workerModal.form.s3Bucket = d.s3Bucket || '';
      workerModal.form.s3Region = d.s3Region || 'us-east-1';
      workerModal.form.s3ForcePathStyle = d.s3ForcePathStyle !== false;
      workerModal.form.s3AccessKey = d.s3AccessKey || '';
      workerModal.form.s3SecretAccessKey = '';
      workerModal.form.secretConfigured = !!d.secretConfigured;
      workerModal.form.s3LastTestOk = d.s3LastTestOk;
    } catch (e) {
      console.error('loadWorkerBackupStorage', e);
    }
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
        const s3Payload = {
          s3Enabled: !!workerModal.form.s3Enabled,
          s3Endpoint: workerModal.form.s3Endpoint.trim() || null,
          s3Bucket: workerModal.form.s3Bucket.trim() || null,
          s3Region: workerModal.form.s3Region.trim() || 'us-east-1',
          s3ForcePathStyle: !!workerModal.form.s3ForcePathStyle,
          s3AccessKey: workerModal.form.s3AccessKey.trim() || null,
        };
        if (workerModal.form.s3SecretAccessKey?.trim()) {
          s3Payload.s3SecretAccessKey = workerModal.form.s3SecretAccessKey.trim();
        }
        const s3r = await fetch(`${BASE}/workers/${workerModal.editing}/backup-storage`, {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify(s3Payload),
        });
        if (!s3r.ok) {
          const err = await s3r.json().catch(() => ({}));
          workerModal.error = err.error || 'Worker saved, but S3 settings failed';
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

  async function testWorkerS3() {
    if (!workerModal.editing) return;
    workerModal.s3TestResult = { loading: true };
    try {
      // Persist current form first so test uses latest values (except empty secret keeps old).
      const s3Payload = {
        s3Enabled: true,
        s3Endpoint: workerModal.form.s3Endpoint.trim() || null,
        s3Bucket: workerModal.form.s3Bucket.trim() || null,
        s3Region: workerModal.form.s3Region.trim() || 'us-east-1',
        s3ForcePathStyle: !!workerModal.form.s3ForcePathStyle,
        s3AccessKey: workerModal.form.s3AccessKey.trim() || null,
      };
      if (workerModal.form.s3SecretAccessKey?.trim()) {
        s3Payload.s3SecretAccessKey = workerModal.form.s3SecretAccessKey.trim();
      }
      await fetch(`${BASE}/workers/${workerModal.editing}/backup-storage`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify(s3Payload),
      });
      const r = await fetch(`${BASE}/workers/${workerModal.editing}/backup-storage/test`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const d = await r.json().catch(() => ({}));
      workerModal.s3TestResult = { loading: false, ok: !!d.ok, error: d.error };
      workerModal.form.s3LastTestOk = !!d.ok;
    } catch (e) {
      workerModal.s3TestResult = { loading: false, ok: false, error: e.message };
    }
  }

  return {
    loadWorkers,
    openAddWorkerModal,
    openEditWorkerModal,
    saveWorker,
    testWorker,
    testWorkerS3,
    deleteWorker,
  };
}
