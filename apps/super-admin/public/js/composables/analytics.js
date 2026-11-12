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

  let fleetRefreshGen = 0;
  let detailRefreshGen = 0;

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

  function applyFleetPayload(d) {
    analytics.summary = d.summary || null;
    analytics.rows = d.tenants || [];
    analytics.generatedAt = d.generatedAt || null;
    analytics.source = d.source || null;
    analytics.stale = !!d.stale;
  }

  async function refreshFleetLive(gen) {
    analytics.refreshing = true;
    analytics.error = '';
    try {
      const qs = new URLSearchParams({ period: analyticsFilter.period || '7d' });
      const r = await fetch(`${BASE}/analytics/fleet/refresh?${qs}`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (gen !== fleetRefreshGen) return;
      if (r.status === 401) {
        logout();
        return;
      }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        // Keep cached rows visible; only show error if we have nothing.
        if (!analytics.rows.length) {
          analytics.error = d.error || `HTTP ${r.status}`;
        }
        return;
      }
      const d = await r.json();
      if (gen !== fleetRefreshGen) return;
      applyFleetPayload(d);
      analytics.error = '';
    } catch (e) {
      if (gen !== fleetRefreshGen) return;
      if (!analytics.rows.length) {
        analytics.error = e.message || 'Network error';
      }
    } finally {
      if (gen === fleetRefreshGen) analytics.refreshing = false;
    }
  }

  /** Cache-first paint, then live refresh in background. */
  async function loadFleetAnalytics() {
    const gen = ++fleetRefreshGen;
    analytics.loading = true;
    analytics.error = '';
    try {
      const qs = new URLSearchParams({ period: analyticsFilter.period || '7d' });
      const r = await fetch(`${BASE}/analytics/fleet?${qs}`, { headers: authHeaders() });
      if (gen !== fleetRefreshGen) return;
      if (r.status === 401) {
        logout();
        return;
      }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        analytics.error = d.error || `HTTP ${r.status}`;
      } else {
        const d = await r.json();
        if (gen !== fleetRefreshGen) return;
        applyFleetPayload(d);
      }
    } catch (e) {
      if (gen !== fleetRefreshGen) return;
      analytics.error = e.message || 'Network error';
    } finally {
      if (gen === fleetRefreshGen) analytics.loading = false;
    }

    // Always refresh live after cache (even if cache was empty).
    if (gen === fleetRefreshGen) {
      void refreshFleetLive(gen);
    }
  }

  async function openAnalyticsDetail(row) {
    if (!row?.tenantId) return;
    const gen = ++detailRefreshGen;
    analytics.detailOpen = true;
    analytics.detailLoading = true;
    analytics.detail = row.ok ? row : null;
    analytics.detailError = '';
    analytics.detailRefreshing = false;

    try {
      const qs = new URLSearchParams({ period: analyticsFilter.period || '7d' });
      const r = await fetch(`${BASE}/analytics/tenants/${row.tenantId}?${qs}`, {
        headers: authHeaders(),
      });
      if (gen !== detailRefreshGen) return;
      if (r.status === 401) {
        logout();
        return;
      }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        if (!analytics.detail) analytics.detailError = d.error || `HTTP ${r.status}`;
      } else {
        const d = await r.json();
        if (gen !== detailRefreshGen) return;
        analytics.detail = d.tenant || null;
      }
    } catch (e) {
      if (gen !== detailRefreshGen) return;
      if (!analytics.detail) analytics.detailError = e.message || 'Network error';
    } finally {
      if (gen === detailRefreshGen) analytics.detailLoading = false;
    }

    // Background live refresh for this tenant
    if (gen !== detailRefreshGen) return;
    analytics.detailRefreshing = true;
    try {
      const qs = new URLSearchParams({ period: analyticsFilter.period || '7d' });
      const r = await fetch(`${BASE}/analytics/tenants/${row.tenantId}/refresh?${qs}`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (gen !== detailRefreshGen) return;
      if (r.status === 401) {
        logout();
        return;
      }
      if (r.ok) {
        const d = await r.json();
        if (gen !== detailRefreshGen) return;
        analytics.detail = d.tenant || null;
        analytics.detailError = '';
      }
    } catch {
      // keep cached detail
    } finally {
      if (gen === detailRefreshGen) analytics.detailRefreshing = false;
    }
  }

  function closeAnalyticsDetail() {
    detailRefreshGen += 1;
    analytics.detailOpen = false;
    analytics.detail = null;
    analytics.detailError = '';
    analytics.detailRefreshing = false;
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
