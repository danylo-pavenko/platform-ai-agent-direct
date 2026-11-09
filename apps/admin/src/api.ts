import axios from 'axios';
import router from './router';
import { safeReturnPath } from './lib/return-path';

function isLoginAttempt(url: string | undefined): boolean {
  return typeof url === 'string' && url.includes('/auth/login');
}

function replaceWithLogin() {
  const current = router.currentRoute.value;
  if (current.name === 'login') return;
  const redirect = safeReturnPath(current.fullPath);
  void router.replace(
    redirect ? { name: 'login', query: { redirect } } : { name: 'login' },
  );
}

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
        replaceWithLogin();
      });
    }
    if (error.response?.status === 401 && !isLoginAttempt(error.config?.url)) {
      // Lazy import to avoid circular dependency auth store → api → auth store.
      // A wrong password is also 401 and must not wipe the saved return path.
      import('@/stores/auth').then(({ useAuthStore }) => {
        useAuthStore().logout();
      }).catch(() => {
        localStorage.removeItem('token');
        replaceWithLogin();
      });
    }
    return Promise.reject(error);
  },
);

export default api;
