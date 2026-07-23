import { BASE } from '../constants.js';
import { isoToLocalInput } from '../utils.js';

export function createAccess(deps) {
  const { accessModal, tenants, headers } = deps;

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

  return {
    accessLabel,
    accessClass,
    openAccessModal,
    applyAccessAction,
    applyAccessExtend,
    applyAccessSetDate,
  };
}
