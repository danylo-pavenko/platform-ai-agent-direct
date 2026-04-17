<template>
  <v-app>
    <!-- Mobile app bar -->
    <v-app-bar v-if="authStore.isAuthenticated" class="d-md-none" flat>
      <v-app-bar-nav-icon @click="drawer = !drawer" />
      <v-app-bar-title>Status Blessed</v-app-bar-title>
    </v-app-bar>

    <!-- Navigation drawer: permanent on desktop, togglable on mobile -->
    <v-navigation-drawer
      v-if="authStore.isAuthenticated"
      v-model="drawer"
      :permanent="!mobile"
      app
    >
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
          @click="onNavClick"
        />
        <v-list-item
          prepend-icon="mdi-text-box-edit"
          title="Промпти"
          :to="{ name: 'prompts' }"
          @click="onNavClick"
        />
        <v-list-item
          prepend-icon="mdi-cog"
          title="Налаштування"
          :to="{ name: 'settings' }"
          @click="onNavClick"
        />
        <v-list-item
          prepend-icon="mdi-package-variant"
          title="Замовлення"
          :to="{ name: 'orders' }"
          @click="onNavClick"
        />
        <v-list-item
          prepend-icon="mdi-robot"
          title="Навчання агента"
          :to="{ name: 'teach' }"
          @click="onNavClick"
        />
        <v-list-item
          prepend-icon="mdi-flask-outline"
          title="Пісочниця"
          :to="{ name: 'sandbox' }"
          @click="onNavClick"
        />
        <v-list-item
          prepend-icon="mdi-sync"
          title="Синхронізація"
          :to="{ name: 'sync' }"
          @click="onNavClick"
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
import { ref } from 'vue';
import { useDisplay } from 'vuetify';
import { useAuthStore } from '@/stores/auth';

const authStore = useAuthStore();
const { mobile } = useDisplay();
const drawer = ref(true);

function onNavClick() {
  if (mobile.value) drawer.value = false;
}
</script>
