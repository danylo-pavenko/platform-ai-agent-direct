<template>
  <v-app>
    <!-- Mobile app bar -->
    <v-app-bar v-if="authStore.isAuthenticated" class="d-md-none" flat height="56">
      <v-app-bar-nav-icon @click="drawer = !drawer" />
      <v-app-bar-title>{{ brandName }}</v-app-bar-title>
    </v-app-bar>

    <!-- Navigation drawer -->
    <v-navigation-drawer
      v-if="authStore.isAuthenticated"
      v-model="drawer"
      :permanent="!mobile"
      :width="240"
      app
    >
      <!-- Brand header -->
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

      <!-- Section: Main -->
      <div class="nav-section-label">Головне</div>
      <v-list density="compact" nav class="px-2">
        <v-list-item
          prepend-icon="mdi-view-dashboard-outline"
          title="Дашборд"
          :to="{ name: 'dashboard' }"
          @click="onNavClick"
        />
        <v-list-item
          prepend-icon="mdi-message-text-outline"
          title="Розмови"
          :to="{ name: 'conversations' }"
          @click="onNavClick"
        />
        <v-list-item
          prepend-icon="mdi-package-variant-closed"
          title="Замовлення"
          :to="{ name: 'orders' }"
          @click="onNavClick"
        />
      </v-list>

      <!-- Section: AI -->
      <div class="nav-section-label">AI агент</div>
      <v-list density="compact" nav class="px-2">
        <v-list-item
          prepend-icon="mdi-text-box-edit-outline"
          title="Промпти"
          :to="{ name: 'prompts' }"
          @click="onNavClick"
        />
        <v-list-item
          prepend-icon="mdi-brain"
          title="Навчання агента"
          :to="{ name: 'teach' }"
          @click="onNavClick"
        />
        <v-list-item
          prepend-icon="mdi-flask-outline"
          title="Тестування агента"
          :to="{ name: 'sandbox' }"
          @click="onNavClick"
        />
      </v-list>

      <!-- Section: System -->
      <div class="nav-section-label">Система</div>
      <v-list density="compact" nav class="px-2">
        <v-list-item
          prepend-icon="mdi-sync"
          title="Синхронізація"
          :to="{ name: 'sync' }"
          @click="onNavClick"
        />
        <v-list-item
          prepend-icon="mdi-cog-outline"
          title="Налаштування"
          :to="{ name: 'settings' }"
          @click="onNavClick"
        />
      </v-list>

      <template #append>
        <v-divider class="mx-3" />
        <div class="pa-3">
          <v-btn
            block
            variant="tonal"
            color="secondary"
            size="small"
            prepend-icon="mdi-logout"
            @click="authStore.logout()"
          >
            Вийти
          </v-btn>
        </div>
      </template>
    </v-navigation-drawer>

    <v-main>
      <router-view />
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useDisplay } from 'vuetify';
import { useAuthStore } from '@/stores/auth';

const authStore = useAuthStore();
const { mobile } = useDisplay();
const drawer = ref(true);
const brandName = 'Status Blessed';

function onNavClick() {
  if (mobile.value) drawer.value = false;
}
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
</style>
