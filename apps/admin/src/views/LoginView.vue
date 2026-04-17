<template>
  <div class="login-page">
    <div class="login-card">
      <!-- Logo -->
      <div class="login-header">
        <div class="login-logo">
          <v-icon size="24" color="white">mdi-shield-crown</v-icon>
        </div>
        <h1 class="login-title">Status Blessed</h1>
        <p class="login-subtitle">Увійдіть в панель управління</p>
      </div>

      <!-- Form -->
      <v-form @submit.prevent="handleLogin" class="login-form">
        <div class="field-group">
          <label class="field-label">Логін</label>
          <v-text-field
            v-model="username"
            placeholder="admin"
            :disabled="loading"
            hide-details="auto"
            autofocus
          />
        </div>

        <div class="field-group">
          <label class="field-label">Пароль</label>
          <v-text-field
            v-model="password"
            placeholder="Введіть пароль"
            type="password"
            :disabled="loading"
            hide-details="auto"
          />
        </div>

        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">
          {{ error }}
        </v-alert>

        <v-btn
          type="submit"
          color="primary"
          block
          size="large"
          :loading="loading"
        >
          Увійти
        </v-btn>
      </v-form>

      <div class="login-footer">
        AI Sales Agent Platform
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '@/stores/auth';

const authStore = useAuthStore();
const username = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');

async function handleLogin() {
  error.value = '';
  loading.value = true;
  try {
    await authStore.login(username.value, password.value);
  } catch {
    error.value = 'Невірний логін або пароль';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #f8f9fb 0%, #eef0f5 100%);
  padding: 20px;
}

.login-card {
  width: 100%;
  max-width: 400px;
  background: #fff;
  border-radius: 16px;
  border: 1px solid #e3e8ee;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
  padding: 40px 36px;
}

.login-header {
  text-align: center;
  margin-bottom: 32px;
}

.login-logo {
  width: 48px;
  height: 48px;
  border-radius: 14px;
  background: linear-gradient(135deg, #635bff 0%, #8b83ff 100%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}

.login-title {
  font-size: 22px;
  font-weight: 700;
  color: #0a2540;
  letter-spacing: -0.02em;
  margin: 0;
}

.login-subtitle {
  font-size: 14px;
  color: #596773;
  margin: 6px 0 0;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 13px;
  font-weight: 600;
  color: #0a2540;
}

.login-footer {
  text-align: center;
  margin-top: 24px;
  font-size: 12px;
  color: #97a4b1;
}

@media (max-width: 480px) {
  .login-card {
    padding: 32px 24px;
  }
}
</style>
