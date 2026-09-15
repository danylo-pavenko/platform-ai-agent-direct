import { BASE } from '../constants.js';

/**
 * Meta webhook inbox — live proof Meta → hub → tenant (or unmatched).
 */
export function createWebhookInbox(deps) {
  const {
    webhookInbox,
    webhookInboxDetail,
    authHeaders,
    logout,
  } = deps;

  let pollTimer = null;

  function statusBadgeClass(status) {
    if (status === 'forwarded' || status === 'verify_ok') return 'badge-active';
    if (status === 'partial') return 'badge-provisioned';
    if (
      status === 'unmatched' ||
      status === 'forward_error' ||
      status === 'hmac_skip' ||
      status === 'verify_fail' ||
      status === 'no_body'
    ) {
      return 'badge-suspended';
    }
    return 'badge-provisioned';
  }

  function formatCandidateIds(ids) {
    if (!Array.isArray(ids) || !ids.length) return '—';
    return ids.slice(0, 4).join(', ') + (ids.length > 4 ? ` +${ids.length - 4}` : '');
  }

  function formatForwardSummary(results) {
    if (!Array.isArray(results) || !results.length) return '—';
    const ok = results.filter((r) => r.ok).length;
    const fail = results.filter((r) => !r.ok && !r.skippedReason).length;
    const skip = results.filter((r) => r.skippedReason).length;
    const instances = results.map((r) => r.instanceId).filter(Boolean).slice(0, 3);
    const parts = [];
    if (ok) parts.push(`${ok} ok`);
    if (fail) parts.push(`${fail} fail`);
    if (skip) parts.push(`${skip} hmac-skip`);
    if (instances.length) parts.push(instances.join(', '));
    return parts.join(' · ') || '—';
  }

  function previewText(row) {
    const previews = row?.entrySummary?.previews;
    if (!Array.isArray(previews) || !previews.length) return '';
    const first = previews.find((p) => p.text) || previews[0];
    return first?.text || '';
  }

  async function loadWebhookInbox() {
    webhookInbox.loading = true;
    webhookInbox.error = '';
    try {
      const qs = new URLSearchParams();
      qs.set('limit', String(webhookInbox.limit || 50));
      if (webhookInbox.filterStatus) qs.set('status', webhookInbox.filterStatus);
      if (webhookInbox.filterQ) qs.set('q', webhookInbox.filterQ);
      const r = await fetch(`${BASE}/webhook-inbox?${qs}`, { headers: authHeaders() });
      if (r.status === 401) { logout(); return; }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        webhookInbox.error = d.error || `HTTP ${r.status}`;
        webhookInbox.rows = [];
        return;
      }
      webhookInbox.rows = Array.isArray(d.data) ? d.data : [];
      webhookInbox.total = d.total ?? webhookInbox.rows.length;
    } catch (e) {
      webhookInbox.error = e.message || 'Load failed';
      webhookInbox.rows = [];
    } finally {
      webhookInbox.loading = false;
    }
  }

  async function openWebhookInboxDetail(row) {
    webhookInboxDetail.open = true;
    webhookInboxDetail.loading = true;
    webhookInboxDetail.error = '';
    webhookInboxDetail.row = row;
    try {
      const r = await fetch(`${BASE}/webhook-inbox/${row.id}`, { headers: authHeaders() });
      if (r.status === 401) { logout(); return; }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        webhookInboxDetail.error = d.error || `HTTP ${r.status}`;
        return;
      }
      webhookInboxDetail.row = d;
    } catch (e) {
      webhookInboxDetail.error = e.message || 'Load failed';
    } finally {
      webhookInboxDetail.loading = false;
    }
  }

  function closeWebhookInboxDetail() {
    webhookInboxDetail.open = false;
    webhookInboxDetail.row = null;
    webhookInboxDetail.error = '';
  }

  async function clearWebhookInbox() {
    if (!confirm('Очистити весь Webhook Inbox?')) return;
    try {
      const r = await fetch(`${BASE}/webhook-inbox`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (r.status === 401) { logout(); return; }
      closeWebhookInboxDetail();
      await loadWebhookInbox();
    } catch (e) {
      alert(e.message || 'Clear failed');
    }
  }

  function startWebhookInboxPoll() {
    stopWebhookInboxPoll();
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void loadWebhookInbox();
    }, 5000);
  }

  function stopWebhookInboxPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  return {
    statusBadgeClass,
    formatCandidateIds,
    formatForwardSummary,
    previewText,
    loadWebhookInbox,
    openWebhookInboxDetail,
    closeWebhookInboxDetail,
    clearWebhookInbox,
    startWebhookInboxPoll,
    stopWebhookInboxPoll,
  };
}
