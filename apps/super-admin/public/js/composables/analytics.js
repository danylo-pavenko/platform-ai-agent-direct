import { BASE } from '../constants.js';

const ALERT_LABELS = {
  claude_auth: 'Claude auth',
  claude_quota: 'Claude quota',
  high_claude_drop: 'Високий drop Claude',
  low_accept_rate: 'Низький accept',
  no_active_prompt: 'Немає промпта',
  bot_failures: 'Bot failures',
  admin_never_logged_in: 'Адмін не логінився',
  admin_inactive: 'Адмінка без логіну 14д+',
};

export function createAnalytics(deps) {
  const { analytics, analyticsFilter, authHeaders, logout } = deps;

  function pct(v) {
    if (v == null || Number.isNaN(v)) return '—';
    return `${Math.round(v * 100)}%`;
  }

  function num(v) {
    if (v == null) return '—';
    return String(v);
  }

  function alertLabel(code) {
    return ALERT_LABELS[code] || code;
  }

  function formatWhen(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleString('uk-UA', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }

  function relativeAge(iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return '';
    const h = Math.floor(ms / 3_600_000);
    if (h < 24) return `${h}г тому`;
    const d = Math.floor(h / 24);
    return `${d}д тому`;
  }

  function rowAlerts(row) {
    if (!row?.ok) return ['offline'];
    return Array.isArray(row.analytics?.alerts) ? row.analytics.alerts : [];
  }

  function rowHealthClass(row) {
    const alerts = rowAlerts(row);
    if (!row?.ok || alerts.includes('claude_auth') || alerts.includes('high_claude_drop')) {
      return 'an-bad';
    }
    if (
      alerts.length ||
      row.platformBehind ||
      alerts.includes('admin_inactive') ||
      alerts.includes('admin_never_logged_in')
    ) {
      return 'an-warn';
    }
    return 'an-ok';
  }

  async function loadFleetAnalytics() {
    analytics.loading = true;
    analytics.error = '';
    try {
      const qs = new URLSearchParams({ period: analyticsFilter.period || '7d' });
      const r = await fetch(`${BASE}/analytics/fleet?${qs}`, { headers: authHeaders() });
      if (r.status === 401) {
        logout();
        return;
      }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        analytics.error = d.error || `HTTP ${r.status}`;
        analytics.rows = [];
        analytics.summary = null;
        return;
      }
      const d = await r.json();
      analytics.summary = d.summary || null;
      analytics.rows = d.tenants || [];
      analytics.generatedAt = d.generatedAt || null;
    } catch (e) {
      analytics.error = e.message || 'Network error';
      analytics.rows = [];
      analytics.summary = null;
    } finally {
      analytics.loading = false;
    }
  }

  async function openAnalyticsDetail(row) {
    if (!row?.tenantId) return;
    analytics.detailOpen = true;
    analytics.detailLoading = true;
    analytics.detail = null;
    analytics.detailError = '';
    try {
      const qs = new URLSearchParams({ period: analyticsFilter.period || '7d' });
      const r = await fetch(`${BASE}/analytics/tenants/${row.tenantId}?${qs}`, {
        headers: authHeaders(),
      });
      if (r.status === 401) {
        logout();
        return;
      }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        analytics.detailError = d.error || `HTTP ${r.status}`;
        return;
      }
      const d = await r.json();
      analytics.detail = d.tenant || null;
    } catch (e) {
      analytics.detailError = e.message || 'Network error';
    } finally {
      analytics.detailLoading = false;
    }
  }

  function closeAnalyticsDetail() {
    analytics.detailOpen = false;
    analytics.detail = null;
    analytics.detailError = '';
  }

  return {
    pct,
    num,
    alertLabel,
    formatWhen,
    relativeAge,
    rowAlerts,
    rowHealthClass,
    loadFleetAnalytics,
    openAnalyticsDetail,
    closeAnalyticsDetail,
  };
}
