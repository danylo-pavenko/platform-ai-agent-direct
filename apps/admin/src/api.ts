import axios from 'axios';
import router from './router';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const data = error.response?.data;
    // Platform access revoked mid-session (subscription expired or
    // super-admin block): remember why, log out — the login page shows
    // a "payment problem, contact platform admin" banner.
    if (
      error.response?.status === 403 &&
      (data?.code === 'ACCESS_EXPIRED' || data?.code === 'ACCESS_SUSPENDED')
    ) {
      localStorage.setItem(
        'access_block',
        JSON.stringify({ code: data.code, accessExpiresAt: data.accessExpiresAt ?? null }),
      );
      import('@/stores/auth').then(({ useAuthStore }) => {
        useAuthStore().logout();
      }).catch(() => {
        localStorage.removeItem('token');
        router.push({ name: 'login' });
      });
    }
    if (error.response?.status === 401) {
      // Lazy import to avoid circular dependency auth store → api → auth store
      import('@/stores/auth').then(({ useAuthStore }) => {
        useAuthStore().logout();
      }).catch(() => {
        localStorage.removeItem('token');
        router.push({ name: 'login' });
      });
    }
    return Promise.reject(error);
  },
);

export default api;
