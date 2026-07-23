import { createApp, ref, reactive, computed, onMounted, nextTick, watch } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js';

createApp({
  setup() {
    const BASE = '/api';
    const SA_PAGE_KEY = 'sa_page';
    const VALID_PAGES = ['dashboard', 'tenants', 'links', 'leads'];

    function readSavedPage() {
      const saved = localStorage.getItem(SA_PAGE_KEY);
      return VALID_PAGES.includes(saved) ? saved : 'dashboard';
    }

    const auth = reactive({ token: localStorage.getItem('sa_token') || '' });
    const login = reactive({ username: '', password: '', loading: false, error: '' });
    const page = ref(readSavedPage());
    const sidebarOpen = ref(false);
    const tenants = ref([]);
    const health = reactive({});
    const saVersionLabel = ref('');
    const deploying = ref(null);
    const deployJobs = reactive({}); // tenantId -> { running, job }
    const deployLog = reactive({
      open: false,
      name: '',
      text: '',
      html: '',
      running: false,
      tenantId: null,
      jobId: null,
      status: null,
      startedAt: null,
      exitCode: null,
      tick: 0,
    });
    const claudeHealth = reactive({ open: false, loading: null, tenantName: '', result: null });
    const chatMessages = ref(null);
    const deployLogEl = ref(null);
    const tenantModalOverlay = ref(null);
    const slugInputEl = ref(null);
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

    const chat = reactive({
      open: false, tenant: null, messages: [], input: '', typing: false,
      history: [], // for sandbox API
    });

    const DEFAULT_GIT_REPO = 'git@github.com:danylo-pavenko/platform-ai-agent-direct.git';
    const PLATFORM_BASE_DOMAIN = 'direct-ai-agents.com';
    const SLUG_RE = /^[a-z0-9-]{2,24}$/;

    function sanitizeSlug(raw) {
      return String(raw || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
    }

    let platformDefaultsTimer = null;
    function schedulePlatformDefaultsLoad(slug) {
      clearTimeout(platformDefaultsTimer);
      platformDefaultsTimer = setTimeout(() => {
        if (modal.form.domainMode !== 'platform') return;
        if (SLUG_RE.test(slug)) loadPlatformDefaults(slug);
      }, 350);
    }

    const fieldHints = {
      instanceId: 'Унікальний slug клієнта (2–24 символи). Використовується для доменів, Linux-користувача, PM2-префікса (CULTURA-api). Після створення змінити неможливо.',
      name: 'Назва бізнесу — відображається в списку клієнтів super-admin.',
      domainMode: 'Platform: автоматичні домени api-{slug}.direct-ai-agents.com. Custom: власні домени (legacy, окремий nginx vhost).',
      apiDomain: 'Публічний URL backend (webhook Meta, API). Nginx proxy_pass на API Port.',
      adminDomain: 'URL Vue-адмінки клієнта. Nginx проксіює на Admin Port.',
      apiPort: 'Локальний порт Fastify на VPS. Пари виділяються кроком +100 (3100, 3200…). Перевіряється реєстр + ss -tln.',
      adminPort: 'Локальний порт Vue admin (serve). Зазвичай API Port + 1.',
      status: 'Provisioned — запис у реєстрі, сервер ще не налаштовано. Active — розгорнуто на VPS. Suspended — блокує вхід у tenant admin.',
      accessMode: 'Обмеження підписки для tenant admin. Suspended має пріоритет над датою.',
      accessExpiresAt: 'Після цієї дати login у tenant admin буде заблоковано, доки не продовжать.',
      envExtra: 'Додаткові змінні в .env при provision/deploy. Формат: KEY=VALUE, одна на рядок.',
      linuxUser: 'Unix-користувач на VPS. Створюється provision-client.sh при першому Provision.',
      appDir: 'Шлях до клону репозиторію на сервері (/home/{slug}/platform-ai-agent-direct).',
      gitRepo: 'SSH/HTTPS URL для першого git clone при Provision.',
    };

    const portDefaults = reactive({
      loading: false,
      error: '',
      nextPorts: null,
      portPolicy: null,
      registeredPortPairs: [],
      liveListeningPorts: [],
    });

    function tenantWhisperPort(apiPort) {
      return apiPort ? apiPort + 5000 : '—';
    }

    function emptyForm() {
      return { instanceId:'', name:'', domainMode:'platform', apiDomain:'', adminDomain:'', apiPort:3100, adminPort:3101, linuxUser:'', appDir:'', status:'provisioned', gitRepo: DEFAULT_GIT_REPO, envExtra:'', instagramUserId:'', instagramRoutingIdsText:'', facebookAppSecret:'', accessMode:'unlimited', accessExpiresAt:'' };
    }

    function platformDomainsForSlug(slug) {
      const s = String(slug || '').trim().toLowerCase();
      if (!s) return { apiDomain: '', adminDomain: '', linuxUser: '', appDir: '' };
      return {
        apiDomain: `api-${s}.${PLATFORM_BASE_DOMAIN}`,
        adminDomain: `agent-${s}.${PLATFORM_BASE_DOMAIN}`,
        linuxUser: s,
        appDir: `/home/${s}/platform-ai-agent-direct`,
      };
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

    const modal = reactive({
      open: false, editing: null, saving: false, advancedOpen: false,
      form: emptyForm(),
    });

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

    const accessModal = reactive({
      open: false,
      tenant: null,
      saving: false,
      customDate: '',
      message: '',
      error: '',
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

    const links = ref([]);
    const leads = ref([]);
    const leadsSummary = reactive({ total: 0, byStatus: {} });
    const leadsFilter = reactive({ status: '' });

    function emptyLinkForm() {
      return { name: '', slug: '', destinationUrl: '' };
    }

    const linkModal = reactive({
      open: false, editing: null, saving: false,
      form: emptyLinkForm(),
    });

    const linkStats = reactive({
      open: false,
      link: null,
      bucket: 'hour',
      days: 14,
      metric: 'both',
      loading: false,
      error: '',
      points: [],
      summary: null,
    });
    const linkChartCanvas = ref(null);
    let linkChartInstance = null;
    const CHART_TZ = 'Europe/Kyiv';

    const totalHumanClicks = computed(() =>
      links.value.reduce((sum, l) => sum + linkHumanClicks(l), 0),
    );
    const totalFormSubmissions = computed(() =>
      links.value.reduce((sum, l) => sum + linkFormSubmissions(l), 0),
    );

    function linkStat(l, key) {
      const stats = l && l.stats;
      if (!stats || stats[key] == null) return 0;
      return stats[key];
    }

    function linkHumanClicks(l) { return linkStat(l, 'humanClicks'); }
    function linkRawClicks(l) { return linkStat(l, 'rawClicks'); }
    function linkFormSubmissions(l) { return linkStat(l, 'formSubmissions'); }

    function linkCountryEntries(l) {
      const countries = (l && l.stats && l.stats.countries) || null;
      if (!countries) return [];
      return Object.keys(countries).map((country) => ({ country, count: countries[country] }));
    }

    function linkCountryCount(l) { return linkCountryEntries(l).length; }

    function linkActiveClass(l) { return l.isActive ? 'badge-active' : 'badge-suspended'; }
    function linkActiveLabel(l) { return l.isActive ? 'on' : 'paused'; }
    function leadEmailClass(l) { return l.emailSent ? 'badge-active' : 'badge-suspended'; }

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

    function chatTenantName() {
      return (chat.tenant && chat.tenant.name) || '—';
    }

    function chatTenantDomain() {
      return (chat.tenant && chat.tenant.apiDomain) || '';
    }

    function formatInstagram(handle) {
      if (!handle) return '';
      return '@' + String(handle).replace(/^@+/, '');
    }

    // ISO string → value for <input type="datetime-local"> (local time)
    function isoToLocalInput(iso) {
      const d = new Date(iso);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function accessLabel(t) {
      if (t.status === 'suspended') return 'Blocked';
      if (!t.accessExpiresAt) return '∞ Unlimited';
      const d = new Date(t.accessExpiresAt);
      if (d.getTime() <= Date.now()) return 'Expired ' + d.toLocaleDateString('uk');
      return 'until ' + d.toLocaleDateString('uk');
    }

    function accessClass(t) {
      if (t.status === 'suspended') return 'badge-suspended';
      if (!t.accessExpiresAt) return 'badge-active';
      return new Date(t.accessExpiresAt).getTime() <= Date.now() ? 'badge-suspended' : 'badge-provisioned';
    }

    function openAccessModal(t) {
      accessModal.tenant = t;
      accessModal.customDate = t.accessExpiresAt ? isoToLocalInput(t.accessExpiresAt) : '';
      accessModal.message = '';
      accessModal.error = '';
      accessModal.open = true;
    }

    function formatAccessPreview(iso) {
      if (!iso) return '∞ безлімітний доступ';
      return `до ${new Date(iso).toLocaleString('uk')}`;
    }

    async function applyAccessAction(action) {
      await patchTenantAccess({ action });
    }

    async function applyAccessExtend(months) {
      await patchTenantAccess({ action: 'extend', months });
    }

    async function applyAccessSetDate() {
      if (!accessModal.customDate) return;
      await patchTenantAccess({
        action: 'set',
        accessExpiresAt: new Date(accessModal.customDate).toISOString(),
      });
    }

    async function patchTenantAccess(body) {
      if (!accessModal.tenant) return;
      accessModal.saving = true;
      accessModal.message = '';
      accessModal.error = '';
      try {
        const r = await fetch(`${BASE}/tenants/${accessModal.tenant.id}/access`, {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          accessModal.error = typeof data.error === 'string' ? data.error : 'Помилка збереження';
          return;
        }
        const idx = tenants.value.findIndex((x) => x.id === data.id);
        if (idx >= 0) tenants.value[idx] = data;
        accessModal.tenant = data;
        accessModal.customDate = data.accessExpiresAt ? isoToLocalInput(data.accessExpiresAt) : '';
        accessModal.message = `Збережено: ${formatAccessPreview(data.accessExpiresAt)}`;
      } catch {
        accessModal.error = 'Мережева помилка';
      } finally {
        accessModal.saving = false;
      }
    }

    function authHeaders() {
      return { Authorization: `Bearer ${auth.token}` };
    }

    function headers() {
      return { 'Content-Type': 'application/json', ...authHeaders() };
    }

    async function doLogin() {
      login.loading = true; login.error = '';
      try {
        const r = await fetch(`${BASE}/auth/login`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ username: login.username, password: login.password }),
        });
        const d = await r.json();
        if (!r.ok) { login.error = d.error || 'Login failed'; return; }
        auth.token = d.token;
        localStorage.setItem('sa_token', d.token);
        await loadSaVersion();
        await loadTenants();
        await refreshCurrentPageData();
      } catch { login.error = 'Network error'; }
      finally { login.loading = false; }
    }

    function logout() {
      auth.token = ''; localStorage.removeItem('sa_token');
    }

    function goPage(p) {
      if (!VALID_PAGES.includes(p)) return;
      page.value = p;
      localStorage.setItem(SA_PAGE_KEY, p);
      sidebarOpen.value = false;
      if (p === 'links') loadLinks();
      if (p === 'leads') loadLeads();
    }

    async function refreshCurrentPageData() {
      if (page.value === 'links') await loadLinks();
      if (page.value === 'leads') await loadLeads();
    }

    function formatDate(iso) {
      if (!iso) return '—';
      return new Date(iso).toLocaleString('uk', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        prompt('Copy:', text);
      }
    }

    async function loadLinks() {
      try {
        const r = await fetch(`${BASE}/links`, { headers: authHeaders() });
        if (r.status === 401) { logout(); return; }
        links.value = await r.json();
      } catch (e) {
        console.error('loadLinks failed:', e);
        links.value = [];
      }
    }

    function openLinkModal(l) {
      if (l) {
        linkModal.editing = l.id;
        linkModal.form = { name: l.name, slug: l.slug, destinationUrl: l.destinationUrl };
      } else {
        linkModal.editing = null;
        linkModal.form = emptyLinkForm();
      }
      linkModal.open = true;
    }

    async function saveLink() {
      if (!linkModal.form.name.trim()) {
        alert('Вкажіть назву');
        return;
      }
      linkModal.saving = true;
      try {
        const payload = {
          name: linkModal.form.name.trim(),
          ...(linkModal.form.slug.trim() ? { slug: linkModal.form.slug.trim().toLowerCase() } : {}),
          ...(linkModal.form.destinationUrl.trim() ? { destinationUrl: linkModal.form.destinationUrl.trim() } : {}),
        };
        const url = linkModal.editing ? `${BASE}/links/${linkModal.editing}` : `${BASE}/links`;
        const method = linkModal.editing ? 'PUT' : 'POST';
        const r = await fetch(url, { method, headers: headers(), body: JSON.stringify(payload) });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          alert(err.error || 'Помилка збереження');
          return;
        }
        linkModal.open = false;
        await loadLinks();
      } finally {
        linkModal.saving = false;
      }
    }

    async function toggleLink(l) {
      await fetch(`${BASE}/links/${l.id}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ isActive: !l.isActive }),
      });
      await loadLinks();
    }

    async function deleteLink(l) {
      if (!confirm('Видалити посилання «' + l.name + '»? Статистика кліків теж зникне.')) return;
      try {
        const r = await fetch(`${BASE}/links/${l.id}`, { method: 'DELETE', headers: authHeaders() });
        if (r.status === 401) { logout(); return; }
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          alert(err.error || ('Помилка видалення (HTTP ' + r.status + ')'));
          return;
        }
        await loadLinks();
      } catch (e) {
        alert('Помилка мережі при видаленні');
        console.error('deleteLink failed:', e);
      }
    }

    function destroyLinkChart() {
      if (linkChartInstance) {
        linkChartInstance.destroy();
        linkChartInstance = null;
      }
    }

    function formatChartTime(iso) {
      if (!iso) return '—';
      return new Date(iso).toLocaleString('uk-UA', {
        timeZone: CHART_TZ,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    function formatChartLabel(iso, bucket) {
      const d = new Date(iso);
      if (bucket === 'day') {
        return d.toLocaleDateString('uk-UA', { timeZone: CHART_TZ, day: '2-digit', month: '2-digit' });
      }
      return d.toLocaleString('uk-UA', {
        timeZone: CHART_TZ,
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    function renderLinkChart() {
      destroyLinkChart();
      const canvas = linkChartCanvas.value;
      if (!canvas || !window.Chart) return;

      const points = linkStats.points;
      const labels = points.map((p) => formatChartLabel(p.t, linkStats.bucket));
      const datasets = [];

      if (linkStats.metric === 'both' || linkStats.metric === 'human') {
        datasets.push({
          label: 'Люди',
          data: points.map((p) => p.human),
          borderColor: '#22c55e',
          backgroundColor: 'rgba(34,197,94,0.15)',
          fill: true,
          tension: 0.25,
          pointRadius: points.length > 48 ? 0 : 3,
        });
      }
      if (linkStats.metric === 'both' || linkStats.metric === 'all') {
        datasets.push({
          label: 'Всі кліки',
          data: points.map((p) => p.total),
          borderColor: '#7c6eff',
          backgroundColor: 'rgba(124,110,255,0.1)',
          fill: linkStats.metric === 'all',
          tension: 0.25,
          pointRadius: points.length > 48 ? 0 : 3,
        });
      }

      linkChartInstance = new window.Chart(canvas, {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { labels: { color: '#e8e8f0' } },
            tooltip: {
              callbacks: {
                title: (items) => {
                  const idx = items[0] && items[0].dataIndex;
                  if (idx == null || !points[idx]) return '';
                  return formatChartTime(points[idx].t);
                },
              },
            },
          },
          scales: {
            x: {
              ticks: {
                color: '#6b6b8a',
                maxRotation: 45,
                autoSkip: true,
                maxTicksLimit: linkStats.bucket === 'hour' ? 24 : 14,
              },
              grid: { color: 'rgba(255,255,255,0.06)' },
            },
            y: {
              beginAtZero: true,
              ticks: { color: '#6b6b8a', precision: 0 },
              grid: { color: 'rgba(255,255,255,0.06)' },
            },
          },
        },
      });
    }

    async function loadLinkTimeline() {
      if (!linkStats.link) return;
      linkStats.loading = true;
      linkStats.error = '';
      destroyLinkChart();
      try {
        const qs = '?bucket=' + encodeURIComponent(linkStats.bucket) + '&days=' + encodeURIComponent(String(linkStats.days));
        const r = await fetch(`${BASE}/links/${linkStats.link.id}/timeline${qs}`, { headers: authHeaders() });
        if (r.status === 401) { logout(); return; }
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          linkStats.error = err.error || ('HTTP ' + r.status);
          return;
        }
        const data = await r.json();
        linkStats.points = data.points || [];
        linkStats.summary = data.summary || null;
        linkStats.loading = false;
        await nextTick();
        renderLinkChart();
      } catch (e) {
        linkStats.error = 'Помилка завантаження графіка';
        console.error('loadLinkTimeline failed:', e);
      } finally {
        linkStats.loading = false;
      }
    }

    async function openLinkStats(l) {
      linkStats.link = { id: l.id, name: l.name, slug: l.slug };
      linkStats.bucket = 'hour';
      linkStats.days = 14;
      linkStats.metric = 'both';
      linkStats.points = [];
      linkStats.summary = null;
      linkStats.error = '';
      linkStats.open = true;
      await loadLinkTimeline();
    }

    function closeLinkStats() {
      linkStats.open = false;
      destroyLinkChart();
      linkStats.link = null;
    }

    async function loadLeads() {
      try {
        const qs = leadsFilter.status ? `?status=${encodeURIComponent(leadsFilter.status)}` : '';
        const r = await fetch(`${BASE}/leads${qs}`, { headers: authHeaders() });
        if (r.status === 401) { logout(); return; }
        const data = await r.json();
        leads.value = data.leads || [];
        leadsSummary.total = data.summary?.total ?? 0;
        leadsSummary.byStatus = data.summary?.byStatus ?? {};
      } catch (e) {
        console.error('loadLeads failed:', e);
        leads.value = [];
      }
    }

    async function updateLeadStatus(lead, status) {
      await fetch(`${BASE}/leads/${lead.id}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ status }),
      });
      lead.status = status;
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

    function escapeLine(line) {
      return line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function appendDeployLine(line, session) {
      // Drop lines from an aborted / superseded Log session (re-open / Hide).
      if (session != null && session !== deployLogSession) return;
      // Quiet stream pings — keep the socket alive, don't spam the log view.
      if (line === '[stream] keepalive') return;
      // Server always re-sends job header on attach; skip duplicates in one view.
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

    function sleepMs(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    function isAbortError(e) {
      return e && (e.name === 'AbortError' || e.code === 20);
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
     * Re-open / Hide aborts this loop via session + AbortController.
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
        // Fresh open always replays full log once (html was cleared).
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

    async function checkClaudeHealth(t) {
      claudeHealth.loading = t.id;
      claudeHealth.tenantName = t.name;
      claudeHealth.result = null;
      claudeHealth.open = true;
      try {
        const r = await fetch(`${BASE}/tenants/${t.id}/claude-health`, { headers: authHeaders() });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          claudeHealth.result = { ok: false, path: '', version: '', error: d.error || `HTTP ${r.status}` };
        } else {
          claudeHealth.result = d;
        }
      } catch (e) {
        claudeHealth.result = { ok: false, path: '', version: '', error: e.message };
      } finally {
        claudeHealth.loading = null;
      }
    }

    function openChat(t) {
      chat.tenant = t;
      chat.messages = [];
      chat.history = [];
      chat.input = '';
      chat.open = true;
    }

    function now() {
      return new Date().toLocaleTimeString('uk', { hour:'2-digit', minute:'2-digit' });
    }

    async function sendChat() {
      const text = chat.input.trim();
      if (!text || chat.typing) return;
      chat.input = '';
      chat.messages.push({ role:'user', content: text, time: now() });
      chat.history.push({ role:'user', content: text });
      chat.typing = true;
      await nextTick();
      if (chatMessages.value) chatMessages.value.scrollTop = chatMessages.value.scrollHeight;

      try {
        const r = await fetch(`${BASE}/tenants/${chat.tenant.id}/chat`, {
          method: 'POST', headers: headers(),
          body: JSON.stringify({ message: text, history: chat.history }),
        });
        const d = await r.json();
        const reply = d.reply || d.text || d.error || 'Немає відповіді';
        chat.messages.push({ role:'bot', content: reply, time: now() });
        chat.history.push({ role:'assistant', content: reply });
      } catch {
        chat.messages.push({ role:'bot', content: '⚠️ Агент недоступний', time: now() });
      }
      chat.typing = false;
      await nextTick();
      if (chatMessages.value) chatMessages.value.scrollTop = chatMessages.value.scrollHeight;
    }

    onMounted(async () => {
      await loadSaVersion();
      if (auth.token) {
        await loadTenants();
        await refreshCurrentPageData();
      }
    });

    watch(() => modal.open, (open) => {
      document.body.style.overflow = open ? 'hidden' : '';
    });

    return {
      auth, login, page, sidebarOpen, tenants, health, deploying, deployJobs, deployLog, deployLogEl,
      deployLogElapsed,
      chat, chatMessages, modal, accessModal, claudeHealth, DEFAULT_GIT_REPO, PLATFORM_BASE_DOMAIN,
      tenantModalOverlay, slugInputEl,
      fieldHints, portDefaults, portRegistryRows, portConflictWarning, tenantWhisperPort, platformPreview,
      links, linkModal, linkStats, linkChartCanvas, leads, leadsSummary, leadsFilter,
      totalHumanClicks, totalFormSubmissions,
      doLogin, logout, goPage, openAddModal, openEditModal, saveTenant, deleteTenant,
      triggerDeploy, openDeployLog, closeDeployLog, isDeployRunning, isDeployBusy,
      openChat, sendChat, checkClaudeHealth, accessLabel, accessClass,
      openAccessModal, applyAccessExtend, applyAccessAction, applyAccessSetDate,
      onSlugInput, onCustomInstanceIdInput, onDomainModeChange, refreshPortDefaults,
      loadLinks, openLinkModal, saveLink, toggleLink, deleteLink, copyText,
      openLinkStats, closeLinkStats, loadLinkTimeline, renderLinkChart, formatChartTime,
      loadLeads, updateLeadStatus, formatDate,
      linkHumanClicks, linkRawClicks, linkFormSubmissions, linkCountryEntries, linkCountryCount,
      linkActiveClass, linkActiveLabel, leadEmailClass, formatInstagram,
      isTenantOnline, tenantVersionLabel, tenantNeedsProvision, chatTenantName, chatTenantDomain,
      saVersionLabel,
    };
  }
}).mount('#app');
