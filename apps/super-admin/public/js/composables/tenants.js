import { computed } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js';
import {
  BASE,
  DEFAULT_GIT_REPO,
  PLATFORM_BASE_DOMAIN,
  SLUG_RE,
  emptyForm,
  platformDomainsForSlug,
  sanitizeSlug,
} from '../constants.js';
import { isoToLocalInput, tenantWhisperPort } from '../utils.js';

export function createTenants(deps) {
  const {
    tenants,
    health,
    modal,
    portDefaults,
    tenantModalOverlay,
    slugInputEl,
    saVersionLabel,
    authHeaders,
    headers,
    logout,
    nextTick,
    refreshDeployStatus,
  } = deps;

  let platformDefaultsTimer = null;

  function schedulePlatformDefaultsLoad(slug) {
    clearTimeout(platformDefaultsTimer);
    platformDefaultsTimer = setTimeout(() => {
      if (modal.form.domainMode !== 'platform') return;
      if (SLUG_RE.test(slug)) loadPlatformDefaults(slug);
    }, 350);
  }

  function resetTenantModalScroll(focusSlug) {
    nextTick(() => {
      if (tenantModalOverlay.value) tenantModalOverlay.value.scrollTop = 0;
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      if (focusSlug && slugInputEl.value && !modal.editing && modal.form.domainMode === 'platform') {
        slugInputEl.value.focus();
      }
    });
  }

  function applyPlatformFieldsFromSlug() {
    if (modal.form.domainMode !== 'platform') return;
    const d = platformDomainsForSlug(modal.form.instanceId);
    modal.form.apiDomain = d.apiDomain;
    modal.form.adminDomain = d.adminDomain;
    if (!modal.editing) {
      modal.form.linuxUser = d.linuxUser;
      modal.form.appDir = d.appDir;
    }
  }

  function applyDomainMode() {
    if (modal.form.domainMode === 'platform') {
      applyPlatformFieldsFromSlug();
    }
  }

  function onDomainModeChange() {
    applyDomainMode();
    if (modal.form.domainMode === 'platform') {
      if (!modal.form.instanceId && !modal.editing) refreshPortDefaults();
      else schedulePlatformDefaultsLoad(modal.form.instanceId);
    }
  }

  function onSlugInput(e) {
    const sanitized = sanitizeSlug(e.target.value);
    if (e.target.value !== sanitized) e.target.value = sanitized;
    modal.form.instanceId = sanitized;
    applyPlatformFieldsFromSlug();
    schedulePlatformDefaultsLoad(sanitized);
  }

  function onCustomInstanceIdInput(e) {
    const sanitized = sanitizeSlug(e.target.value);
    if (e.target.value !== sanitized) e.target.value = sanitized;
    modal.form.instanceId = sanitized;
  }

  async function loadPlatformDefaults(slug) {
    portDefaults.loading = true;
    portDefaults.error = '';
    try {
      const url = `${BASE}/tenants/platform-defaults${slug ? `?instanceId=${encodeURIComponent(slug)}` : ''}`;
      const r = await fetch(url, { headers: authHeaders() });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        portDefaults.error = typeof err.error === 'string' ? err.error : `HTTP ${r.status}`;
        return;
      }
      const d = await r.json();
      portDefaults.nextPorts = d.nextPorts;
      portDefaults.portPolicy = d.portPolicy;
      portDefaults.registeredPortPairs = d.registeredPortPairs || [];
      portDefaults.liveListeningPorts = d.liveListeningPorts || [];
      if (d.nextPorts && !modal.editing) {
        modal.form.apiPort = d.nextPorts.apiPort;
        modal.form.adminPort = d.nextPorts.adminPort;
      }
      if (slug && d.apiDomain) {
        modal.form.apiDomain = d.apiDomain;
        modal.form.adminDomain = d.adminDomain;
        modal.form.linuxUser = d.linuxUser;
        modal.form.appDir = d.appDir;
      }
    } catch (e) {
      console.warn('platform-defaults failed', e);
      portDefaults.error = 'Не вдалося завантажити порти з сервера';
    } finally {
      portDefaults.loading = false;
    }
  }

  async function refreshPortDefaults() {
    const slug = modal.form.domainMode === 'platform' ? modal.form.instanceId : '';
    await loadPlatformDefaults(slug);
  }

  const platformPreview = computed(() => {
    const slug = sanitizeSlug(modal.form.instanceId);
    const d = platformDomainsForSlug(slug);
    const valid = SLUG_RE.test(slug);
    return {
      slug,
      valid,
      apiUrl: slug ? `https://${d.apiDomain}` : `https://api-{slug}.${PLATFORM_BASE_DOMAIN}`,
      adminUrl: slug ? `https://${d.adminDomain}` : `https://agent-{slug}.${PLATFORM_BASE_DOMAIN}`,
    };
  });

  const portRegistryRows = computed(() => {
    const pairs = portDefaults.registeredPortPairs || [];
    const rows = pairs.map((row) => ({
      key: row.instanceId,
      instanceId: row.instanceId,
      name: row.name,
      apiPort: row.apiPort,
      adminPort: row.adminPort,
      whisperPort: row.apiPort + 5000,
      suggested: false,
    }));
    if (!modal.editing && portDefaults.nextPorts) {
      const np = portDefaults.nextPorts;
      rows.push({
        key: '__suggested__',
        instanceId: '',
        name: '',
        apiPort: np.apiPort,
        adminPort: np.adminPort,
        whisperPort: np.apiPort + 5000,
        suggested: true,
      });
    }
    return rows;
  });

  const portConflictWarning = computed(() => {
    const api = modal.form.apiPort;
    const admin = modal.form.adminPort;
    if (!api || !admin) return '';

    const editingTenant = modal.editing
      ? tenants.value.find((t) => t.id === modal.editing)
      : null;

    for (const row of portDefaults.registeredPortPairs || []) {
      if (editingTenant && row.instanceId === editingTenant.instanceId) continue;
      const ports = [row.apiPort, row.adminPort];
      if (ports.includes(api) || ports.includes(admin)) {
        return `Конфлікт: порти зайняті клієнтом «${row.instanceId}» (API :${row.apiPort}, Admin :${row.adminPort}).`;
      }
    }

    const live = portDefaults.liveListeningPorts || [];
    const ownPorts = editingTenant ? [editingTenant.apiPort, editingTenant.adminPort] : [];
    if (live.includes(api) && !ownPorts.includes(api)) {
      return `Порт :${api} уже слухає процес на VPS (ss -tln) — оберіть іншу пару.`;
    }
    if (live.includes(admin) && !ownPorts.includes(admin)) {
      return `Порт :${admin} уже слухає процес на VPS (ss -tln) — оберіть іншу пару.`;
    }
    if (!modal.editing && admin !== api + 1) {
      return `Зазвичай Admin Port = API Port + 1 (зараз ${api} / ${admin}).`;
    }
    return '';
  });

  function isTenantOnline(id) {
    const h = health[id];
    return !!(h && h.online);
  }

  function tenantVersionLabel(id) {
    const h = health[id];
    return (h && h.versionLabel) || '';
  }

  /** First-time server setup vs git pull update — not the same as DB status alone. */
  function tenantNeedsProvision(t) {
    const h = health[t.id];
    if (h && h.deployed === false) return true;
    if (h && h.deployed === true) return false;
    return t.status === 'provisioned';
  }

  async function loadTenants() {
    try {
      const r = await fetch(`${BASE}/tenants`, { headers: authHeaders() });
      if (r.status === 401) { logout(); return; }
      const data = await r.json();
      tenants.value = Array.isArray(data) ? data : [];
      if (!Array.isArray(data)) console.error('Tenants API error:', data);
      checkAllHealth();
    } catch (e) {
      console.error('loadTenants failed:', e);
      tenants.value = [];
    }
  }

  async function checkAllHealth() {
    for (const t of tenants.value) {
      fetch(`${BASE}/tenants/${t.id}/health`, { headers: authHeaders() })
        .then(r => r.json())
        .then(d => {
          const ver = d.status && d.status.version;
          const versionLabel = ver
            ? (ver.label || `v${ver.name} (${ver.code})`)
            : '';
          health[t.id] = {
            online: !!d.online,
            deployed: d.deployed === true ? true : d.deployed === false ? false : null,
            versionLabel,
          };
        })
        .catch(() => {
          health[t.id] = { online: false, deployed: t.status === 'provisioned' ? false : null, versionLabel: '' };
        });
      refreshDeployStatus(t.id);
    }
  }

  async function loadSaVersion() {
    try {
      const r = await fetch(`${BASE}/health`);
      if (!r.ok) return;
      const d = await r.json();
      if (d.version?.label) saVersionLabel.value = d.version.label;
      else if (d.version?.name != null) saVersionLabel.value = `v${d.version.name} (${d.version.code})`;
    } catch {
      // ignore
    }
  }

  function openAddModal() {
    modal.editing = null;
    modal.form = emptyForm();
    modal.advancedOpen = false;
    modal.open = true;
    portDefaults.nextPorts = null;
    portDefaults.registeredPortPairs = [];
    portDefaults.liveListeningPorts = [];
    loadPlatformDefaults('');
    resetTenantModalScroll(true);
  }

  function openEditModal(t) {
    modal.editing = t.id;
    const platform = t.apiDomain && t.apiDomain.startsWith('api-') && t.apiDomain.endsWith('.' + PLATFORM_BASE_DOMAIN);
    modal.form = {
      instanceId: t.instanceId,
      name: t.name,
      domainMode: platform ? 'platform' : 'custom',
      apiDomain: t.apiDomain,
      adminDomain: t.adminDomain,
      apiPort: t.apiPort,
      adminPort: t.adminPort,
      linuxUser: t.linuxUser,
      appDir: t.appDir,
      status: t.status,
      gitRepo: t.gitRepo || DEFAULT_GIT_REPO,
      envExtra: t.envExtra || '',
      instagramUserId: t.instagramUserId || '',
      instagramRoutingIdsText: Array.isArray(t.instagramRoutingIds)
        ? t.instagramRoutingIds.filter((id) => id && id !== t.instagramUserId).join(', ')
        : '',
      facebookAppSecret: t.facebookAppSecret || '',
      accessMode: t.accessExpiresAt ? 'until' : 'unlimited',
      accessExpiresAt: t.accessExpiresAt ? isoToLocalInput(t.accessExpiresAt) : '',
    };
    modal.advancedOpen = false;
    modal.open = true;
    resetTenantModalScroll(false);
  }

  async function saveTenant() {
    if (!/^[a-z0-9-]{2,24}$/.test(modal.form.instanceId || '')) {
      alert(modal.form.domainMode === 'platform'
        ? 'Slug: 2–24 символи, a-z, 0-9, дефіс.'
        : 'Instance ID: латиниця a-z, цифри, дефіс; 2–24 символи.');
      return;
    }
    if (modal.form.domainMode === 'platform') applyPlatformFieldsFromSlug();
    if (!modal.form.linuxUser) modal.form.linuxUser = modal.form.instanceId;
    if (!modal.form.appDir) modal.form.appDir = `/home/${modal.form.instanceId}/platform-ai-agent-direct`;
    if (modal.form.accessMode === 'until' && !modal.form.accessExpiresAt) {
      alert('Вкажіть дату, до якої діє доступ, або оберіть "Вічний".');
      return;
    }
    modal.saving = true;
    try {
      const url = modal.editing ? `${BASE}/tenants/${modal.editing}` : `${BASE}/tenants`;
      const method = modal.editing ? 'PUT' : 'POST';
      const { accessMode, accessExpiresAt, instagramRoutingIdsText, domainMode, ...rest } = modal.form;
      const routingExtra = (instagramRoutingIdsText || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s));
      const payload = {
        ...rest,
        accessExpiresAt: accessMode === 'until' ? new Date(accessExpiresAt).toISOString() : null,
        ...(routingExtra.length > 0 ? { instagramRoutingIds: routingExtra } : { instagramRoutingIds: [] }),
      };
      const r = await fetch(url, { method, headers: headers(), body: JSON.stringify(payload) });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        const msg = typeof err.error === 'string' ? err.error : JSON.stringify(err.error || err);
        alert(msg || 'Error saving');
        return;
      }
      modal.open = false;
      await loadTenants();
    } finally { modal.saving = false; }
  }

  async function deleteTenant(t) {
    if (!confirm(`Delete ${t.name}? This only removes the registry entry, not the server.`)) return;
    await fetch(`${BASE}/tenants/${t.id}`, { method: 'DELETE', headers: authHeaders() });
    await loadTenants();
  }

  return {
    platformPreview,
    portRegistryRows,
    portConflictWarning,
    tenantWhisperPort,
    isTenantOnline,
    tenantVersionLabel,
    tenantNeedsProvision,
    loadTenants,
    loadSaVersion,
    checkAllHealth,
    openAddModal,
    openEditModal,
    saveTenant,
    deleteTenant,
    onSlugInput,
    onCustomInstanceIdInput,
    onDomainModeChange,
    refreshPortDefaults,
  };
}
