import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import api from '@/api';
import router from '@/router';
import { safeReturnPath } from '@/lib/return-path';

/** Explicit «Вийти» must not send the next login back to the previous page. */
let suppressReturn = false;

export interface AuthUser {
  id: string;
  username: string;
  role: string;
  displayName?: string | null;
  tgUserId?: string | null;
  tgUsername?: string | null;
  isActive?: boolean;
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem('token'));
  const user = ref<AuthUser | null>(null);

  const isAuthenticated = computed(() => !!token.value);
  const isOwner = computed(() => user.value?.role === 'owner');
  const isManager = computed(() => user.value?.role === 'manager');

  function returnTarget(raw: unknown): RouteLocationRaw {
    const path = safeReturnPath(raw);
    if (!path) return { name: 'dashboard' };
    const resolved = router.resolve(path);
    if (!resolved.matched.length || resolved.meta.guest) return { name: 'dashboard' };
    return path;
  }

  async function login(username: string, password: string) {
    const { data } = await api.post('/auth/login', { username, password });
    setSession(data.token, data.user);
    suppressReturn = false;
    const redirect = router.currentRoute.value.query.redirect;
    await router.replace(returnTarget(redirect));
  }

  function setSession(newToken: string, newUser: AuthUser) {
    token.value = newToken;
    user.value = newUser;
    localStorage.setItem('token', newToken);
  }

  async function changePassword(
    currentPassword: string,
    newPassword: string,
    confirmPassword: string,
  ) {
    const { data } = await api.post('/auth/change-password', {
      currentPassword,
      newPassword,
      confirmPassword,
    });
    setSession(data.token, data.user);
    return data;
  }

  async function updateProfile(displayName: string | null) {
    const { data } = await api.patch('/auth/me', { displayName });
    user.value = data.user;
    return data.user;
  }

  async function fetchUser() {
    if (!token.value) return;
    try {
      const { data } = await api.get('/auth/me');
      user.value = data.user;
    } catch {
      logout();
    }
  }

  function logout(options?: { remember?: boolean }) {
    if (options?.remember === false) suppressReturn = true;
    const current = router.currentRoute.value;
    const returnTo =
      options?.remember !== false && !suppressReturn
        ? safeReturnPath(current.fullPath)
        : null;
    token.value = null;
    user.value = null;
    localStorage.removeItem('token');
    if (current.name === 'login') return;
    if (returnTo) {
      void router.replace({ name: 'login', query: { redirect: returnTo } });
      return;
    }
    void router.replace({ name: 'login' });
  }

  return {
    token,
    user,
    isAuthenticated,
    isOwner,
    isManager,
    login,
    changePassword,
    updateProfile,
    fetchUser,
    logout,
  };
});
