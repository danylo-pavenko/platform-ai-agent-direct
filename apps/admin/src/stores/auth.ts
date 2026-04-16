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
    token.value = data.token;
    user.value = data.user;
    localStorage.setItem('token', data.token);
    router.push({ name: 'conversations' });
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

  return { token, user, isAuthenticated, login, fetchUser, logout };
});
