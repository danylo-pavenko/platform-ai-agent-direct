import { createRouter, createWebHistory } from 'vue-router';

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
      redirect: '/conversations',
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
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
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
    },
    {
      path: '/teach',
      name: 'teach',
      component: () => import('@/views/TeachChat.vue'),
    },
  ],
});

router.beforeEach((to) => {
  const token = localStorage.getItem('token');
  if (!to.meta.guest && !token) {
    return { name: 'login' };
  }
  if (to.meta.guest && token) {
    return { name: 'conversations' };
  }
});

export default router;
