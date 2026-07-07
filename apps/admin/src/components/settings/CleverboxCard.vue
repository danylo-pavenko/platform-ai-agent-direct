<template>
  <v-card id="settings-cleverbox" class="mb-4">
    <v-card-title class="d-flex align-center">
      <v-icon start color="deep-purple">mdi-calendar-clock</v-icon>
      CleverBOX CRM
    </v-card-title>
    <v-card-subtitle class="pb-2">
      Запис на послуги, філії та каталог послуг для салонів краси / SPA.
    </v-card-subtitle>
    <v-card-text>
      <v-text-field
        v-model="cleverbox.apiToken"
        label="API token"
        :type="showToken ? 'text' : 'password'"
        :append-inner-icon="showToken ? 'mdi-eye-off' : 'mdi-eye'"
        hint="CleverBOX → Налаштування → API"
        persistent-hint
        class="mb-3"
        @click:append-inner="showToken = !showToken"
      />
      <v-text-field
        v-model="cleverbox.defaultBranchId"
        label="Default salon_id (філія)"
        hint="CRM id філії за замовчуванням для слотів"
        persistent-hint
        class="mb-3"
      />
      <v-text-field
        v-model.number="cleverbox.syncIntervalMin"
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

export interface CleverboxIntegrationShape {
  apiToken: string;
  defaultBranchId: string;
  syncIntervalMin: number;
}

const cleverbox = defineModel<CleverboxIntegrationShape>({ required: true });
const showToken = ref(false);
</script>
