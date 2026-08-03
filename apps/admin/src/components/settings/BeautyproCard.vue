<template>
  <v-card id="settings-beautypro" class="mb-4">
    <v-card-title class="d-flex align-center">
      <v-icon start color="pink-darken-2">mdi-spa</v-icon>
      BeautyPro (AI Helps)
    </v-card-title>
    <v-card-subtitle class="pb-2">
      Beauty Pro / Fitness Pro / Denta Pro — послуги, локації та онлайн-запис.
      Потрібен тариф Ultimate і Grant access у Marketplace.
      Тестова й бойова база — один API (`api.aihelps.com`), різниться лише database code.
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
        <span v-if="beautypro.apiServer">
          · API server {{ beautypro.apiServer }}
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
        hint="Код бази (тестової або бойової) — той самий API host"
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
        class="mb-3"
      />

      <div class="d-flex flex-wrap align-center ga-2 mb-2">
        <v-btn
          color="pink-darken-2"
          variant="tonal"
          :loading="testLoading"
          :disabled="testLoading"
          prepend-icon="mdi-lan-check"
          @click="runConnectionTest"
        >
          Перевірити підключення
        </v-btn>
        <span class="text-caption text-medium-emphasis">
          Auth → Grant → GET /locations. Краще спочатку Зберегти інтеграції.
        </span>
      </div>

      <v-alert
        v-if="testResult"
        :type="testResult.ok ? 'success' : testResult.status === 'pending' ? 'warning' : 'error'"
        variant="tonal"
        density="compact"
        closable
        class="mt-2"
        @click:close="testResult = null"
      >
        {{ testResult.message }}
        <ul
          v-if="testResult.locationsPreview?.length"
          class="text-caption mt-2 mb-0 pl-4"
        >
          <li v-for="loc in testResult.locationsPreview" :key="loc.id">
            {{ loc.name }}
            <span class="text-medium-emphasis">· {{ loc.id }}</span>
          </li>
        </ul>
      </v-alert>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import api from '@/api';

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

interface BeautyproTestResponse {
  ok: boolean;
  status: 'granted' | 'pending' | 'refused' | 'error';
  message: string;
  server?: number;
  expiresAt?: string;
  database?: string;
  locationCount?: number;
  locationsPreview?: Array<{ id: string; name: string }>;
  persisted?: boolean;
}

const beautypro = defineModel<BeautyproIntegrationShape>({ required: true });
const showSecret = ref(false);
const testLoading = ref(false);
const testResult = ref<BeautyproTestResponse | null>(null);

const emit = defineEmits<{
  tested: [result: BeautyproTestResponse];
}>();

function formatExpiry(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString('uk-UA');
}

async function runConnectionTest() {
  testLoading.value = true;
  testResult.value = null;
  try {
    const payload: Record<string, string> = {
      applicationId: beautypro.value.applicationId.trim(),
      databaseCode: beautypro.value.databaseCode.trim(),
    };
    const secret = beautypro.value.applicationSecret.trim();
    if (secret && secret !== '••••••') {
      payload.applicationSecret = secret;
    }

    const { data } = await api.post<BeautyproTestResponse>(
      '/settings/beautypro/test',
      payload,
    );
    testResult.value = data;
    if (data.ok && data.persisted) {
      beautypro.value.authStatus = 'granted';
      if (data.expiresAt) beautypro.value.tokenExpiresAt = data.expiresAt;
      if (data.server) beautypro.value.apiServer = data.server;
    } else if (data.status === 'pending' || data.status === 'refused') {
      beautypro.value.authStatus = data.status;
    }
    emit('tested', data);
  } catch (e: unknown) {
    const err = e as { response?: { data?: BeautyproTestResponse & { error?: string } } };
    const data = err.response?.data;
    testResult.value = {
      ok: false,
      status: data?.status ?? 'error',
      message: data?.message ?? data?.error ?? 'Не вдалося виконати перевірку',
      locationsPreview: data?.locationsPreview,
    };
  } finally {
    testLoading.value = false;
  }
}
</script>
