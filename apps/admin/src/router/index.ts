import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { guest: true },
    },
    {
      path: '/',
      redirect: '/dashboard',
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: () => import('@/views/DashboardView.vue'),
    },
    {
      path: '/insights',
      name: 'insights',
      component: () => import('@/views/InsightsView.vue'),
      meta: { roles: ['owner'] },
    },
    {
      path: '/conversations',
      name: 'conversations',
      component: () => import('@/views/ConversationsView.vue'),
    },
    {
      path: '/conversations/:id',
      name: 'conversation-detail',
      component: () => import('@/views/ConversationDetail.vue'),
      props: true,
    },
    {
      path: '/prompts',
      name: 'prompts',
      component: () => import('@/views/PromptsView.vue'),
      meta: { roles: ['owner'] },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
    },
    {
      path: '/users',
      name: 'users',
      component: () => import('@/views/UsersView.vue'),
      meta: { roles: ['owner'] },
    },
    {
      path: '/orders',
      name: 'orders',
      component: () => import('@/views/OrdersView.vue'),
    },
    {
      path: '/sync',
      name: 'sync',
      component: () => import('@/views/SyncView.vue'),
      meta: { roles: ['owner'] },
    },
    {
      path: '/teach',
      name: 'teach',
      component: () => import('@/views/TeachChat.vue'),
      meta: { roles: ['owner'] },
    },
    {
      path: '/sandbox',
      name: 'sandbox',
      component: () => import('@/views/SandboxView.vue'),
    },
    {
      path: '/crm-fields',
      name: 'crm-fields',
      component: () => import('@/views/CrmFieldsView.vue'),
      meta: { roles: ['owner'] },
    },
  ],
});

router.beforeEach(async (to) => {
  const token = localStorage.getItem('token');
  if (!to.meta.guest && !token) {
    return { name: 'login' };
  }
  if (to.meta.guest && token) {
    return { name: 'dashboard' };
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
