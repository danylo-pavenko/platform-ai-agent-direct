import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { safeReturnPath } from '@/lib/return-path';

declare module 'vue-router' {
  interface RouteMeta {
    guest?: boolean;
    roles?: string[];
    title?: string;
    /** Hide mobile bottom nav (chat / fullscreen agent UIs). */
    hideBottomNav?: boolean;
  }
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { guest: true, title: 'Вхід', hideBottomNav: true },
    },
    {
      path: '/',
      redirect: '/dashboard',
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: () => import('@/views/DashboardView.vue'),
      meta: { title: 'Дашборд' },
    },
    {
      path: '/insights',
      name: 'insights',
      component: () => import('@/views/InsightsView.vue'),
      meta: { roles: ['owner'], title: 'AI-помічник', hideBottomNav: true },
    },
    {
      path: '/conversations',
      name: 'conversations',
      component: () => import('@/views/ConversationsView.vue'),
      meta: { title: 'Розмови' },
    },
    {
      path: '/conversations/:id',
      name: 'conversation-detail',
      component: () => import('@/views/ConversationDetail.vue'),
      props: true,
      meta: { title: 'Діалог', hideBottomNav: true },
    },
    {
      path: '/prompts',
      name: 'prompts',
      component: () => import('@/views/PromptsView.vue'),
      meta: { roles: ['owner'], title: 'Промпти' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
      meta: { title: 'Налаштування' },
    },
    {
      path: '/users',
      name: 'users',
      component: () => import('@/views/UsersView.vue'),
      meta: { roles: ['owner'], title: 'Користувачі' },
    },
    {
      path: '/clients',
      name: 'clients',
      component: () => import('@/views/ClientsView.vue'),
      meta: { title: 'Клієнти' },
    },
    {
      path: '/clients/:id',
      name: 'client-detail',
      component: () => import('@/views/ClientDetailView.vue'),
      props: true,
      meta: { title: 'Клієнт', hideBottomNav: true },
    },
    {
      path: '/orders',
      name: 'orders',
      component: () => import('@/views/OrdersView.vue'),
      meta: { title: 'Замовлення' },
    },
    {
      path: '/sync',
      name: 'sync',
      component: () => import('@/views/SyncView.vue'),
      meta: { roles: ['owner'], title: 'Синхронізація' },
    },
    {
      path: '/teach',
      name: 'teach',
      component: () => import('@/views/TeachChat.vue'),
      meta: { roles: ['owner'], title: 'Навчання агента', hideBottomNav: true },
    },
    {
      path: '/sandbox',
      name: 'sandbox',
      component: () => import('@/views/SandboxView.vue'),
      meta: { title: 'Тестування агента', hideBottomNav: true },
    },
    {
      path: '/events',
      name: 'events',
      component: () => import('@/views/EventsView.vue'),
      meta: { title: 'Події' },
    },
    {
      path: '/crm-fields',
      name: 'crm-fields',
      component: () => import('@/views/CrmFieldsView.vue'),
      meta: { roles: ['owner'], title: 'CRM-поля' },
    },
  ],
});

router.beforeEach(async (to) => {
  const token = localStorage.getItem('token');
  if (!to.meta.guest && !token) {
    const redirect = to.matched.length ? safeReturnPath(to.fullPath) : null;
    return redirect ? { name: 'login', query: { redirect } } : { name: 'login' };
  }
  if (to.meta.guest && token) {
    const redirect = safeReturnPath(to.query.redirect);
    if (!redirect) return { name: 'dashboard' };
    const resolved = router.resolve(redirect);
    if (!resolved.matched.length || resolved.meta.guest) return { name: 'dashboard' };
    return redirect;
  }

  const roles = to.meta.roles as string[] | undefined;
  if (roles?.length && token) {
    const auth = useAuthStore();
    if (!auth.user) {
      await auth.fetchUser();
    }
    const role = auth.user?.role;
    if (!role || !roles.includes(role)) {
      return { name: 'dashboard' };
    }
  }
});

export default router;
