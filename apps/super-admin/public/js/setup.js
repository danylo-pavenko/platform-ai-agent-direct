import { ref, reactive, onMounted, nextTick, watch } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js';
import {
  BASE,
  SA_PAGE_KEY,
  VALID_PAGES,
  DEFAULT_GIT_REPO,
  PLATFORM_BASE_DOMAIN,
  fieldHints,
  readSavedPage,
  emptyForm,
  emptyLinkForm,
} from './constants.js';
import { formatDate, formatInstagram, copyText } from './utils.js';
import { createDeployLog } from './composables/deploy-log.js';
import { createTenants } from './composables/tenants.js';
import { createLinks } from './composables/links.js';
import { createLeads } from './composables/leads.js';
import { createAccess } from './composables/access.js';
import { createChat } from './composables/chat.js';

/** Vue setup() — wires shared state + domain composables. */
export function setup() {
  const auth = reactive({ token: localStorage.getItem('sa_token') || '' });
  const login = reactive({ username: '', password: '', loading: false, error: '' });
  const page = ref(readSavedPage());
  const sidebarOpen = ref(false);
  const tenants = ref([]);
  const health = reactive({});
  const saVersionLabel = ref('');
  const deploying = ref(null);
  const deployJobs = reactive({});
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

  const chat = reactive({
    open: false, tenant: null, messages: [], input: '', typing: false,
    history: [],
  });

  const portDefaults = reactive({
    loading: false,
    error: '',
    nextPorts: null,
    portPolicy: null,
    registeredPortPairs: [],
    liveListeningPorts: [],
  });

  const modal = reactive({
    open: false, editing: null, saving: false, advancedOpen: false,
    form: emptyForm(),
  });

  const accessModal = reactive({
    open: false,
    tenant: null,
    saving: false,
    customDate: '',
    message: '',
    error: '',
  });

  const links = ref([]);
  const leads = ref([]);
  const leadsSummary = reactive({ total: 0, byStatus: {} });
  const leadsFilter = reactive({ status: '' });

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

  function authHeaders() {
    return { Authorization: `Bearer ${auth.token}` };
  }

  function headers() {
    return { 'Content-Type': 'application/json', ...authHeaders() };
  }

  function logout() {
    auth.token = '';
    localStorage.removeItem('sa_token');
  }

  // Break circular deps: tenants ↔ deploy (health poll ↔ loadTenants after stream)
  const bridge = {
    refreshDeployStatus: async () => {},
    loadTenants: async () => {},
  };

  const tenantsApi = createTenants({
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
    refreshDeployStatus: (id) => bridge.refreshDeployStatus(id),
  });

  const deployApi = createDeployLog({
    deployLog,
    deployJobs,
    deployLogEl,
    deploying,
    auth,
    nextTick,
    loadTenants: () => bridge.loadTenants(),
  });

  bridge.refreshDeployStatus = deployApi.refreshDeployStatus;
  bridge.loadTenants = tenantsApi.loadTenants;

  const linksApi = createLinks({
    links,
    linkModal,
    linkStats,
    linkChartCanvas,
    authHeaders,
    headers,
    logout,
    nextTick,
  });

  const leadsApi = createLeads({
    leads,
    leadsSummary,
    leadsFilter,
    authHeaders,
    headers,
    logout,
  });

  const accessApi = createAccess({ accessModal, tenants, headers });

  const chatApi = createChat({
    chat,
    chatMessages,
    claudeHealth,
    authHeaders,
    headers,
    nextTick,
  });

  function goPage(p) {
    if (!VALID_PAGES.includes(p)) return;
    page.value = p;
    localStorage.setItem(SA_PAGE_KEY, p);
    sidebarOpen.value = false;
    if (p === 'links') linksApi.loadLinks();
    if (p === 'leads') leadsApi.loadLeads();
  }

  async function refreshCurrentPageData() {
    if (page.value === 'links') await linksApi.loadLinks();
    if (page.value === 'leads') await leadsApi.loadLeads();
  }

  async function doLogin() {
    login.loading = true;
    login.error = '';
    try {
      const r = await fetch(`${BASE}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: login.username, password: login.password }),
      });
      const d = await r.json();
      if (!r.ok) { login.error = d.error || 'Login failed'; return; }
      auth.token = d.token;
      localStorage.setItem('sa_token', d.token);
      await tenantsApi.loadSaVersion();
      await tenantsApi.loadTenants();
      await refreshCurrentPageData();
    } catch { login.error = 'Network error'; }
    finally { login.loading = false; }
  }

  onMounted(async () => {
    await tenantsApi.loadSaVersion();
    if (auth.token) {
      await tenantsApi.loadTenants();
      await refreshCurrentPageData();
    }
  });

  watch(() => modal.open, (open) => {
    document.body.style.overflow = open ? 'hidden' : '';
  });

  return {
    auth, login, page, sidebarOpen, tenants, health, deploying, deployJobs, deployLog, deployLogEl,
    deployLogElapsed: deployApi.deployLogElapsed,
    chat, chatMessages, modal, accessModal, claudeHealth, DEFAULT_GIT_REPO, PLATFORM_BASE_DOMAIN,
    tenantModalOverlay, slugInputEl,
    fieldHints, portDefaults,
    portRegistryRows: tenantsApi.portRegistryRows,
    portConflictWarning: tenantsApi.portConflictWarning,
    tenantWhisperPort: tenantsApi.tenantWhisperPort,
    platformPreview: tenantsApi.platformPreview,
    links, linkModal, linkStats, linkChartCanvas, leads, leadsSummary, leadsFilter,
    totalHumanClicks: linksApi.totalHumanClicks,
    totalFormSubmissions: linksApi.totalFormSubmissions,
    doLogin, logout, goPage,
    openAddModal: tenantsApi.openAddModal,
    openEditModal: tenantsApi.openEditModal,
    saveTenant: tenantsApi.saveTenant,
    deleteTenant: tenantsApi.deleteTenant,
    triggerDeploy: deployApi.triggerDeploy,
    openDeployLog: deployApi.openDeployLog,
    closeDeployLog: deployApi.closeDeployLog,
    isDeployRunning: deployApi.isDeployRunning,
    isDeployBusy: deployApi.isDeployBusy,
    openChat: chatApi.openChat,
    sendChat: chatApi.sendChat,
    checkClaudeHealth: chatApi.checkClaudeHealth,
    accessLabel: accessApi.accessLabel,
    accessClass: accessApi.accessClass,
    openAccessModal: accessApi.openAccessModal,
    applyAccessExtend: accessApi.applyAccessExtend,
    applyAccessAction: accessApi.applyAccessAction,
    applyAccessSetDate: accessApi.applyAccessSetDate,
    onSlugInput: tenantsApi.onSlugInput,
    onCustomInstanceIdInput: tenantsApi.onCustomInstanceIdInput,
    onDomainModeChange: tenantsApi.onDomainModeChange,
    refreshPortDefaults: tenantsApi.refreshPortDefaults,
    loadLinks: linksApi.loadLinks,
    openLinkModal: linksApi.openLinkModal,
    saveLink: linksApi.saveLink,
    toggleLink: linksApi.toggleLink,
    deleteLink: linksApi.deleteLink,
    copyText,
    openLinkStats: linksApi.openLinkStats,
    closeLinkStats: linksApi.closeLinkStats,
    loadLinkTimeline: linksApi.loadLinkTimeline,
    renderLinkChart: linksApi.renderLinkChart,
    formatChartTime: linksApi.formatChartTime,
    loadLeads: leadsApi.loadLeads,
    updateLeadStatus: leadsApi.updateLeadStatus,
    formatDate,
    linkHumanClicks: linksApi.linkHumanClicks,
    linkRawClicks: linksApi.linkRawClicks,
    linkFormSubmissions: linksApi.linkFormSubmissions,
    linkCountryEntries: linksApi.linkCountryEntries,
    linkCountryCount: linksApi.linkCountryCount,
    linkActiveClass: linksApi.linkActiveClass,
    linkActiveLabel: linksApi.linkActiveLabel,
    leadEmailClass: leadsApi.leadEmailClass,
    formatInstagram,
    isTenantOnline: tenantsApi.isTenantOnline,
    tenantVersionLabel: tenantsApi.tenantVersionLabel,
    tenantNeedsProvision: tenantsApi.tenantNeedsProvision,
    chatTenantName: chatApi.chatTenantName,
    chatTenantDomain: chatApi.chatTenantDomain,
    saVersionLabel,
  };
}
