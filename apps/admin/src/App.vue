<template>
  <v-app>
    <!-- Mobile app bar -->
    <v-app-bar
      v-if="showAppBar"
      app
      flat
      height="56"
    >
      <v-app-bar-nav-icon
        v-if="!showBottomNav"
        class="tap-target"
        @click="drawer = !drawer"
      />
      <v-app-bar-title>{{ pageTitle }}</v-app-bar-title>
    </v-app-bar>

    <!-- Navigation drawer: permanent on desktop; temporary “Ще” on mobile -->
    <v-navigation-drawer
      v-if="authStore.isAuthenticated && route.name !== 'login'"
      v-model="drawer"
      :permanent="!mobile"
      :temporary="mobile"
      :width="mobile ? 280 : 240"
      app
    >
      <div class="sidebar-brand pa-4 pb-3">
        <div class="d-flex align-center ga-3">
          <div class="brand-icon">
            <v-icon size="20" color="white">mdi-shield-crown</v-icon>
          </div>
          <div>
            <div class="brand-name">{{ brandName }}</div>
            <div class="brand-label">AI Agent</div>
          </div>
        </div>
      </div>

      <v-divider class="mx-3" />

      <!-- Desktop: full nav. Mobile drawer: secondary items only (“Ще”). -->
      <template v-if="!mobile">
        <div class="nav-section-label">Головне</div>
        <v-list density="comfortable" nav class="px-2">
          <v-list-item
            prepend-icon="mdi-view-dashboard-outline"
            title="Дашборд"
            :to="{ name: 'dashboard' }"
          />
          <v-list-item
            v-if="authStore.isOwner"
            prepend-icon="mdi-chart-timeline-variant-shimmer"
            title="AI-помічник"
            :to="{ name: 'insights' }"
          />
          <v-list-item
            prepend-icon="mdi-message-text-outline"
            title="Розмови"
            :to="{ name: 'conversations' }"
          />
          <v-list-item
            prepend-icon="mdi-package-variant-closed"
            title="Замовлення"
            :to="{ name: 'orders' }"
          />
        </v-list>

        <div class="nav-section-label">AI агент</div>
        <v-list density="comfortable" nav class="px-2">
          <v-list-item
            v-if="authStore.isOwner"
            prepend-icon="mdi-text-box-edit-outline"
            title="Промпти"
            :to="{ name: 'prompts' }"
          />
          <v-list-item
            v-if="authStore.isOwner"
            prepend-icon="mdi-brain"
            title="Навчання агента"
            subtitle="Редагує промпт"
            :to="{ name: 'teach' }"
          />
          <v-list-item
            prepend-icon="mdi-flask-outline"
            title="Тестування агента"
            subtitle="Симуляція чату з клієнтом"
            :to="{ name: 'sandbox' }"
          />
        </v-list>

        <div class="nav-section-label">Система</div>
        <v-list density="comfortable" nav class="px-2">
          <v-list-item
            v-if="authStore.isOwner"
            prepend-icon="mdi-account-group-outline"
            title="Користувачі"
            :to="{ name: 'users' }"
          />
          <v-list-item
            v-if="authStore.isOwner"
            prepend-icon="mdi-sync"
            title="Синхронізація"
            :to="{ name: 'sync' }"
          />
          <v-list-item
            v-if="authStore.isOwner"
            prepend-icon="mdi-format-list-bulleted-type"
            title="CRM-поля клієнта"
            :to="{ name: 'crm-fields' }"
          />
          <v-list-item
            prepend-icon="mdi-cog-outline"
            title="Налаштування"
            :to="{ name: 'settings' }"
          />
        </v-list>
      </template>

      <template v-else>
        <div class="nav-section-label">Ще</div>
        <v-list density="comfortable" nav class="px-2">
          <v-list-item
            v-if="authStore.isOwner"
            prepend-icon="mdi-chart-timeline-variant-shimmer"
            title="AI-помічник"
            :to="{ name: 'insights' }"
            @click="onNavClick"
          />
          <v-list-item
            v-if="authStore.isOwner"
            prepend-icon="mdi-text-box-edit-outline"
            title="Промпти"
            :to="{ name: 'prompts' }"
            @click="onNavClick"
          />
          <v-list-item
            v-if="authStore.isOwner"
            prepend-icon="mdi-brain"
            title="Навчання агента"
            subtitle="Редагує промпт"
            :to="{ name: 'teach' }"
            @click="onNavClick"
          />
          <v-list-item
            prepend-icon="mdi-flask-outline"
            title="Тестування агента"
            subtitle="Симуляція чату"
            :to="{ name: 'sandbox' }"
            @click="onNavClick"
          />
          <v-list-item
            v-if="authStore.isOwner"
            prepend-icon="mdi-account-group-outline"
            title="Користувачі"
            :to="{ name: 'users' }"
            @click="onNavClick"
          />
          <v-list-item
            v-if="authStore.isOwner"
            prepend-icon="mdi-sync"
            title="Синхронізація"
            :to="{ name: 'sync' }"
            @click="onNavClick"
          />
          <v-list-item
            v-if="authStore.isOwner"
            prepend-icon="mdi-format-list-bulleted-type"
            title="CRM-поля клієнта"
            :to="{ name: 'crm-fields' }"
            @click="onNavClick"
          />
          <v-list-item
            prepend-icon="mdi-cog-outline"
            title="Налаштування"
            :to="{ name: 'settings' }"
            @click="onNavClick"
          />
        </v-list>
      </template>

      <template #append>
        <v-divider class="mx-3" />
        <div class="pa-3 pb-1">
          <v-btn
            block
            variant="tonal"
            color="secondary"
            prepend-icon="mdi-logout"
            class="tap-target"
            @click="authStore.logout()"
          >
            Вийти
          </v-btn>
        </div>
        <div class="sidebar-version px-3 pb-2">
          {{ versionLabel }}
        </div>
        <div class="sidebar-legal pa-3 pt-1">
          <a href="https://direct-ai-agents.com/data-deletion" target="_blank" rel="noopener" class="legal-link">
            Видалення даних
          </a>
          <span class="legal-sep">·</span>
          <a href="https://direct-ai-agents.com/privacy-policy" target="_blank" rel="noopener" class="legal-link">
            Приватність
          </a>
        </div>
      </template>
    </v-navigation-drawer>

    <v-main :class="{ 'bottom-nav-pad': showBottomNav }">
      <router-view />
    </v-main>

    <v-bottom-navigation
      v-if="showBottomNav"
      app
      grow
      height="56"
      class="admin-bottom-nav"
      :model-value="bottomNavValue"
      @update:model-value="onBottomNav"
    >
      <v-btn value="conversations" :to="{ name: 'conversations' }">
        <v-icon>mdi-message-text-outline</v-icon>
        <span>Розмови</span>
      </v-btn>
      <v-btn value="orders" :to="{ name: 'orders' }">
        <v-icon>mdi-package-variant-closed</v-icon>
        <span>Замовлення</span>
      </v-btn>
      <v-btn value="dashboard" :to="{ name: 'dashboard' }">
        <v-icon>mdi-view-dashboard-outline</v-icon>
        <span>Дашборд</span>
      </v-btn>
      <v-btn value="more" @click.prevent="openMore">
        <v-icon>mdi-menu</v-icon>
        <span>Ще</span>
      </v-btn>
    </v-bottom-navigation>
  </v-app>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue';
import { useDisplay } from 'vuetify';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { formatPlatformVersion } from '@/lib/platform-version';

const authStore = useAuthStore();
const { mobile } = useDisplay();
const route = useRoute();
const router = useRouter();
/** Closed on mobile so bottom nav / hamburger owns nav; open permanently on desktop. */
const drawer = ref(!mobile.value);
const brandName = import.meta.env.VITE_BRAND_NAME || 'AI Agent';
const versionLabel = formatPlatformVersion();

const primaryBottomRoutes = new Set(['conversations', 'orders', 'dashboard']);

const showAppBar = computed(
  () =>
    authStore.isAuthenticated &&
    mobile.value &&
    route.name !== 'login',
);

const showBottomNav = computed(
  () =>
    authStore.isAuthenticated &&
    mobile.value &&
    route.name !== 'login' &&
    !route.meta.hideBottomNav,
);

const pageTitle = computed(() => {
  const t = route.meta.title;
  return typeof t === 'string' && t ? t : brandName;
});

const bottomNavValue = computed(() => {
  const name = String(route.name ?? '');
  if (primaryBottomRoutes.has(name)) return name;
  return 'more';
});

watch(mobile, (isMobile) => {
  drawer.value = !isMobile;
});

function onNavClick() {
  if (mobile.value) drawer.value = false;
}

function openMore() {
  drawer.value = true;
}

function onBottomNav(value: unknown) {
  if (value === 'more') {
    openMore();
    return;
  }
  if (typeof value === 'string' && primaryBottomRoutes.has(value)) {
    void router.push({ name: value });
  }
}

onMounted(() => {
  if (authStore.isAuthenticated) {
    void authStore.fetchUser();
  }
});
</script>

<style scoped>
.sidebar-brand {
  min-height: 64px;
}

.brand-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: linear-gradient(145deg, #0a2540 0%, #1b3a5c 50%, #635bff 130%);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: 0 2px 8px rgba(10, 37, 64, 0.2);
}

.brand-name {
  font-size: 14px;
  font-weight: 700;
  color: #0a2540;
  letter-spacing: -0.01em;
  line-height: 1.2;
}

.brand-label {
  font-size: 11px;
  font-weight: 500;
  color: #596773;
  letter-spacing: 0.02em;
}

.nav-section-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #97a4b1;
  padding: 16px 20px 6px;
}

.sidebar-legal {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.sidebar-version {
  font-size: 10px;
  font-weight: 500;
  color: #97a4b1;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
}

.legal-link {
  font-size: 10px;
  color: #97a4b1;
  text-decoration: none;
  letter-spacing: 0.02em;
}

.legal-link:hover {
  color: #596773;
}

.legal-sep {
  font-size: 10px;
  color: #c8d0d8;
}

.admin-bottom-nav {
  border-top: 1px solid var(--color-border, #e6ebf1);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
</style>
