<template>
  <v-card id="settings-altegio" class="mb-4">
    <v-card-title class="d-flex align-center">
      <v-icon start color="teal-darken-2">mdi-calendar-account</v-icon>
      Altegio CRM
    </v-card-title>
    <v-card-subtitle class="pb-2">
      Запис на послуги: майстри, ціни, графік, існуючі візити. Токени з кабінету Altegio
      (partner + user) і ID компанії. Послуги і записи — B2B v2; слоти — Online Booking.
    </v-card-subtitle>
    <v-card-text>
      <v-text-field
        v-model="altegio.partnerToken"
        label="Partner token"
        :type="showPartner ? 'text' : 'password'"
        :append-inner-icon="showPartner ? 'mdi-eye-off' : 'mdi-eye'"
        hint="Токен партнера з підключення в Altegio"
        persistent-hint
        class="mb-3"
        @click:append-inner="showPartner = !showPartner"
      />
      <v-text-field
        v-model="altegio.userToken"
        label="User token"
        :type="showUser ? 'text' : 'password'"
        :append-inner-icon="showUser ? 'mdi-eye-off' : 'mdi-eye'"
        hint="Токен користувача салону (User), не partner token"
        persistent-hint
        class="mb-3"
        @click:append-inner="showUser = !showUser"
      />
      <v-text-field
        v-model="altegio.locationId"
        label="ID компанії (location / company id)"
        hint="Числовий id локації в Altegio"
        persistent-hint
        class="mb-3"
      />
      <v-text-field
        v-model="altegio.webhookSecret"
        label="Секрет вебхука (опційно)"
        :type="showHook ? 'text' : 'password'"
        :append-inner-icon="showHook ? 'mdi-eye-off' : 'mdi-eye'"
        hint="Якщо заповнено, Altegio має слати його в ?token= або заголовку X-Webhook-Token"
        persistent-hint
        class="mb-3"
        @click:append-inner="showHook = !showHook"
      />
      <v-text-field
        v-model.number="altegio.syncIntervalMin"
        label="Інтервал синхронізації послуг (хв)"
        type="number"
        min="15"
        class="mb-3"
      />

      <v-alert type="info" variant="tonal" density="compact" class="mb-3 text-body-2">
        Колбек у Altegio: <code>POST https://&lt;api-домен-тенанта&gt;/webhooks/altegio</code>.
        Події запису: record create / update / delete. Без секрету в тілі має бути
        ваш partner token. Якщо Altegio його не шле — задайте секрет і додайте
        <code>?token=…</code> в URL колбека.
      </v-alert>

      <div class="d-flex flex-wrap align-center ga-2 mb-2">
        <v-btn
          color="teal-darken-2"
          variant="tonal"
          style="min-height: 44px"
          :loading="testLoading"
          :disabled="testLoading"
          prepend-icon="mdi-lan-check"
          @click="runConnectionTest"
        >
          Перевірити підключення
        </v-btn>
        <span class="text-caption text-medium-emphasis">
          GET компанії, майстрів і послуг. Краще спочатку зберегти інтеграції.
        </span>
      </div>

      <v-alert
        v-if="statusMessage"
        :type="statusOk ? 'success' : 'error'"
        variant="tonal"
        density="compact"
        class="text-body-2"
      >
        {{ statusMessage }}
      </v-alert>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import api from '@/api';

export interface AltegioIntegrationShape {
  partnerToken: string;
  userToken: string;
  locationId: string;
  webhookSecret: string;
  syncIntervalMin: number;
}

const altegio = defineModel<AltegioIntegrationShape>({ required: true });
const showPartner = ref(false);
const showUser = ref(false);
const showHook = ref(false);
const testLoading = ref(false);
const statusMessage = ref('');
const statusOk = ref(false);

const MASK = '••••••';

function credPayload() {
  const payload: Record<string, string> = {
    locationId: altegio.value.locationId.trim(),
  };
  const partner = altegio.value.partnerToken.trim();
  const user = altegio.value.userToken.trim();
  if (partner && partner !== MASK) payload.partnerToken = partner;
  if (user && user !== MASK) payload.userToken = user;
  return payload;
}

async function runConnectionTest() {
  testLoading.value = true;
  statusMessage.value = '';
  try {
    const { data } = await api.post<{ ok: boolean; message: string }>(
      '/settings/altegio/test',
      credPayload(),
      { validateStatus: (status) => status < 500 },
    );
    statusOk.value = data.ok;
    statusMessage.value = data.message;
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string; error?: string } } };
    statusOk.value = false;
    statusMessage.value =
      err.response?.data?.message ?? err.response?.data?.error ?? 'Не вдалося виконати перевірку';
  } finally {
    testLoading.value = false;
  }
}
</script>
