import { BASE } from '../constants.js';

export function createLeads(deps) {
  const { leads, leadsSummary, leadsFilter, authHeaders, headers, logout } = deps;

  function leadEmailClass(l) { return l.emailSent ? 'badge-active' : 'badge-suspended'; }

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

  return { leadEmailClass, loadLeads, updateLeadStatus };
}
