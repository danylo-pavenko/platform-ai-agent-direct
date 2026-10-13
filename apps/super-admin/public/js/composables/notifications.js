import { BASE } from '../constants.js';

const POLL_MS = 60_000;

/**
 * Sticky in-app notification stack (new landing leads).
 * Toasts stay until the user hits × (or dismiss-all); they survive page switches.
 */
export function createNotifications(deps) {
  const { notifications, auth, authHeaders, logout, goPage } = deps;

  let pollTimer = null;

  function authHdr() {
    return authHeaders();
  }

  async function loadNotifications() {
    if (!auth.token) return;
    try {
      const r = await fetch(`${BASE}/notifications`, { headers: authHdr() });
      if (r.status === 401) {
        logout();
        return;
      }
      if (!r.ok) return;
      const d = await r.json();
      const list = Array.isArray(d.notifications) ? d.notifications : [];
      // Keep local order stable: newest on top; merge without flicker of dismissed.
      notifications.items = list;
      notifications.unreadCount = d.unreadCount ?? list.length;
    } catch (e) {
      console.error('loadNotifications failed:', e);
    }
  }

  async function dismissNotification(id) {
    const prev = notifications.items.slice();
    notifications.items = notifications.items.filter((n) => n.id !== id);
    notifications.unreadCount = notifications.items.length;
    try {
      const r = await fetch(`${BASE}/notifications/${encodeURIComponent(id)}/dismiss`, {
        method: 'POST',
        headers: { ...authHdr(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (r.status === 401) {
        logout();
        return;
      }
      if (!r.ok) {
        notifications.items = prev;
        notifications.unreadCount = prev.length;
      }
    } catch {
      notifications.items = prev;
      notifications.unreadCount = prev.length;
    }
  }

  async function dismissAllNotifications() {
    const prev = notifications.items.slice();
    notifications.items = [];
    notifications.unreadCount = 0;
    try {
      const r = await fetch(`${BASE}/notifications/dismiss-all`, {
        method: 'POST',
        headers: { ...authHdr(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (r.status === 401) {
        logout();
        return;
      }
      if (!r.ok) {
        notifications.items = prev;
        notifications.unreadCount = prev.length;
      }
    } catch {
      notifications.items = prev;
      notifications.unreadCount = prev.length;
    }
  }

  function openNotification(n) {
    if (n?.type === 'lead') {
      goPage('leads');
    }
  }

  function startNotificationPoll() {
    stopNotificationPoll();
    void loadNotifications();
    pollTimer = setInterval(() => {
      void loadNotifications();
    }, POLL_MS);
  }

  function stopNotificationPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function onVisibility() {
    if (document.visibilityState === 'visible' && auth.token) {
      void loadNotifications();
    }
  }

  function bindVisibility() {
    document.addEventListener('visibilitychange', onVisibility);
  }

  function unbindVisibility() {
    document.removeEventListener('visibilitychange', onVisibility);
  }

  return {
    loadNotifications,
    dismissNotification,
    dismissAllNotifications,
    openNotification,
    startNotificationPoll,
    stopNotificationPoll,
    bindVisibility,
    unbindVisibility,
  };
}
