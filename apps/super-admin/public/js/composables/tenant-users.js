import { BASE } from '../constants.js';

export function createTenantUsers(deps) {
  const { tenantUsersModal, authHeaders } = deps;

  function activeOwnerCount(users) {
    return (users || []).filter((u) => u.role === 'owner' && u.isActive).length;
  }

  function isLastActiveOwner(user) {
    return (
      user.role === 'owner' &&
      user.isActive &&
      activeOwnerCount(tenantUsersModal.users) <= 1
    );
  }

  async function openTenantUsersModal(t) {
    tenantUsersModal.open = true;
    tenantUsersModal.tenant = t;
    tenantUsersModal.users = [];
    tenantUsersModal.error = '';
    tenantUsersModal.loading = true;
    tenantUsersModal.savingId = null;
    try {
      const r = await fetch(`${BASE}/tenants/${t.id}/admin-users`, {
        headers: authHeaders(),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        tenantUsersModal.error = d.error || `HTTP ${r.status}`;
        return;
      }
      tenantUsersModal.users = Array.isArray(d.data) ? d.data : [];
    } catch (e) {
      tenantUsersModal.error = e.message || 'Failed to load users';
    } finally {
      tenantUsersModal.loading = false;
    }
  }

  function closeTenantUsersModal() {
    tenantUsersModal.open = false;
    tenantUsersModal.tenant = null;
    tenantUsersModal.users = [];
    tenantUsersModal.error = '';
    tenantUsersModal.savingId = null;
  }

  async function patchTenantUser(user, patch) {
    if (!tenantUsersModal.tenant) return;
    tenantUsersModal.error = '';
    tenantUsersModal.savingId = user.id;
    try {
      const r = await fetch(
        `${BASE}/tenants/${tenantUsersModal.tenant.id}/admin-users/${user.id}`,
        {
          method: 'PATCH',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(patch),
        },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        tenantUsersModal.error =
          d.code === 'LAST_OWNER'
            ? (d.error || 'Не можна залишити тенант без активного власника.')
            : (d.error || `HTTP ${r.status}`);
        return;
      }
      if (d.user) {
        const idx = tenantUsersModal.users.findIndex((u) => u.id === d.user.id);
        if (idx >= 0) tenantUsersModal.users[idx] = d.user;
      }
    } catch (e) {
      tenantUsersModal.error = e.message || 'Update failed';
    } finally {
      tenantUsersModal.savingId = null;
    }
  }

  async function setTenantUserRole(user, role) {
    if (role === user.role) return;
    if (user.role === 'owner' && role === 'manager' && isLastActiveOwner(user)) {
      tenantUsersModal.error = 'Не можна знизити роль останнього активного власника.';
      return;
    }
    await patchTenantUser(user, { role });
  }

  async function setTenantUserActive(user, isActive) {
    if (isActive === user.isActive) return;
    if (!isActive && isLastActiveOwner(user)) {
      tenantUsersModal.error = 'Не можна вимкнути останнього активного власника.';
      return;
    }
    await patchTenantUser(user, { isActive });
  }

  return {
    openTenantUsersModal,
    closeTenantUsersModal,
    setTenantUserRole,
    setTenantUserActive,
    isLastActiveOwner,
  };
}
