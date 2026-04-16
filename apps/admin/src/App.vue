<template>
  <v-app>
    <v-navigation-drawer v-if="authStore.isAuthenticated" app permanent>
      <v-list-item
        prepend-icon="mdi-shield-crown"
        title="Status Blessed"
        subtitle="Admin Panel"
      />
      <v-divider />
      <v-list density="compact" nav>
        <v-list-item
          prepend-icon="mdi-chat"
          title="Розмови"
          :to="{ name: 'conversations' }"
        />
        <v-list-item
          prepend-icon="mdi-text-box-edit"
          title="Промпти"
          :to="{ name: 'prompts' }"
        />
        <v-list-item
          prepend-icon="mdi-cog"
          title="Налаштування"
          :to="{ name: 'settings' }"
        />
        <v-list-item
          prepend-icon="mdi-package-variant"
          title="Замовлення"
          :to="{ name: 'orders' }"
        />
        <v-list-item
          prepend-icon="mdi-sync"
          title="Синхронізація"
          :to="{ name: 'sync' }"
        />
      </v-list>
      <template #append>
        <div class="pa-2">
          <v-btn block variant="outlined" @click="authStore.logout()">
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
import { useAuthStore } from '@/stores/auth';

const authStore = useAuthStore();
</script>
