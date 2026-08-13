import { BASE } from '../constants.js';

/**
 * Restart a tenant's PM2 apps (api/bot/sync) via SA → supervisor proxy.
 */
export function createPm2Restart(deps) {
  const { pm2Restart, authHeaders } = deps;

  async function restartTenantPm2(t) {
    if (!t?.id) return;
    if (pm2Restart.loading === t.id) return;

    const ok = confirm(
      `Перезапустити PM2 додатки для «${t.name}» (${String(t.instanceId || '').toUpperCase()}-api/bot/sync)?\n\n` +
        'Підхопить зміни з БД та .env (--update-env). API перезапуститься через ~1 с.',
    );
    if (!ok) return;

    pm2Restart.loading = t.id;
    try {
      const r = await fetch(`${BASE}/tenants/${t.id}/pm2-restart`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = d.error || d.detail?.error || `HTTP ${r.status}`;
        const extra =
          d.code === 'COOLDOWN' && (d.cooldownMsRemaining || d.detail?.cooldownMsRemaining)
            ? ` (ще ~${Math.ceil((d.cooldownMsRemaining || d.detail.cooldownMsRemaining) / 1000)} с)`
            : d.code
              ? ` [${d.code}]`
              : '';
        alert(`PM2 restart failed: ${msg}${extra}`);
        return;
      }
      const restarted = Array.isArray(d.restarted) ? d.restarted.join(', ') : '';
      const deferred = Array.isArray(d.deferred) ? d.deferred.join(', ') : '';
      alert(
        `PM2 restart OK (${d.prefix || t.instanceId})\n` +
          (restarted ? `Restarted: ${restarted}\n` : '') +
          (deferred ? `Deferred: ${deferred}` : ''),
      );
    } catch (e) {
      alert(`PM2 restart failed: ${e.message || e}`);
    } finally {
      pm2Restart.loading = null;
    }
  }

  return { restartTenantPm2 };
}
