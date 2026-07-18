<template>
  <v-card id="settings-beautypro" class="mb-4">
    <v-card-title class="d-flex align-center">
      <v-icon start color="pink-darken-2">mdi-spa</v-icon>
      BeautyPro (AI Helps)
    </v-card-title>
    <v-card-subtitle class="pb-2">
      Beauty Pro / Fitness Pro / Denta Pro — послуги, локації та онлайн-запис.
      Потрібен тариф Ultimate і Grant access у Marketplace.
    </v-card-subtitle>
    <v-card-text>
      <v-alert
        v-if="beautypro.authStatus === 'pending'"
        type="warning"
        variant="tonal"
        density="compact"
        class="mb-3"
      >
        Доступ очікує підтвердження: BeautyPro → Settings → Marketplace → Grant access.
      </v-alert>
      <v-alert
        v-else-if="beautypro.authStatus === 'granted'"
        type="success"
        variant="tonal"
        density="compact"
        class="mb-3"
      >
        Доступ до бази надано
        <span v-if="beautypro.tokenExpiresAt">
          · token до {{ formatExpiry(beautypro.tokenExpiresAt) }}
        </span>
      </v-alert>
      <v-alert
        v-else-if="beautypro.authStatus === 'refused'"
        type="error"
        variant="tonal"
        density="compact"
        class="mb-3"
      >
        Доступ відхилено — зверніться до власника бази BeautyPro.
      </v-alert>

      <v-text-field
        v-model="beautypro.applicationId"
        label="Application ID"
        hint="Видає AI Helps після реєстрації інтеграції"
        persistent-hint
        class="mb-3"
      />
      <v-text-field
        v-model="beautypro.applicationSecret"
        label="Application Secret"
        :type="showSecret ? 'text' : 'password'"
        :append-inner-icon="showSecret ? 'mdi-eye-off' : 'mdi-eye'"
        hint="Секрет інтеграції (маскиться після збереження)"
        persistent-hint
        class="mb-3"
        @click:append-inner="showSecret = !showSecret"
      />
      <v-text-field
        v-model="beautypro.databaseCode"
        label="Database code"
        hint="Код бази клієнта в BeautyPro"
        persistent-hint
        class="mb-3"
      />
      <v-text-field
        v-model="beautypro.defaultLocationId"
        label="Default location UUID"
        hint="Опційно: локація за замовчуванням"
        persistent-hint
        class="mb-3"
      />
      <v-text-field
        v-model.number="beautypro.syncIntervalMin"
        label="Інтервал синхронізації послуг (хв)"
        type="number"
        min="15"
        class="mb-2"
      />
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { ref } from 'vue';

export interface BeautyproIntegrationShape {
  applicationId: string;
  applicationSecret: string;
  databaseCode: string;
  defaultLocationId: string;
  syncIntervalMin: number;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: string;
  apiServer: number;
  authStatus: 'pending' | 'granted' | 'refused' | '';
}

const beautypro = defineModel<BeautyproIntegrationShape>({ required: true });
const showSecret = ref(false);

function formatExpiry(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString('uk-UA');
}
</script>
