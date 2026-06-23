import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import api from '@/api';
import router from '@/router';

interface User {
  id: string;
  username: string;
  role: string;
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem('token'));
  const user = ref<User | null>(null);

  const isAuthenticated = computed(() => !!token.value);

  async function login(username: string, password: string) {
    const { data } = await api.post('/auth/login', { username, password });
    setSession(data.token, data.user);
    router.push({ name: 'dashboard' });
  }

  function setSession(newToken: string, newUser: User) {
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

  async function fetchUser() {
    if (!token.value) return;
    try {
      const { data } = await api.get('/auth/me');
      user.value = data.user;
    } catch {
      logout();
    }
  }

  function logout() {
    token.value = null;
    user.value = null;
    localStorage.removeItem('token');
    router.push({ name: 'login' });
  }

  return { token, user, isAuthenticated, login, changePassword, fetchUser, logout };
});
