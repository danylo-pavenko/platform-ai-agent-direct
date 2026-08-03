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
        label="Default location UUID (опційно)"
        clearable
        hint="Можна лишити порожнім — імпорт/sync підтягне всі локації. Після успішної перевірки оберіть зі списку нижче."
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
          :loading="testLoading && !debugMode"
          :disabled="testLoading"
          prepend-icon="mdi-lan-check"
          @click="runConnectionTest(false)"
        >
          Перевірити підключення
        </v-btn>
        <v-btn
          color="grey-darken-2"
          variant="outlined"
          :loading="testLoading && debugMode"
          :disabled="testLoading"
          prepend-icon="mdi-bug"
          @click="runConnectionTest(true)"
        >
          DEBUG
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
        @click:close="clearTestResult"
      >
        {{ testResult.message }}
      </v-alert>

      <v-card
        v-if="locationsList.length"
        variant="outlined"
        class="mt-3"
      >
        <v-card-title class="text-subtitle-2 d-flex align-center py-3">
          <v-icon start size="small">mdi-map-marker-multiple</v-icon>
          Локації з API ({{ locationsList.length }})
          <v-spacer />
          <span class="text-caption text-medium-emphasis font-weight-regular">
            Натисніть «Підставити» або скопіюйте UUID
          </span>
        </v-card-title>
        <v-list density="compact" class="py-0">
          <v-list-item
            v-for="loc in locationsList"
            :key="loc.id"
            :title="loc.name"
            :subtitle="loc.address || loc.id"
          >
            <template #append>
              <div class="d-flex align-center ga-1">
                <code class="text-caption beautypro-loc-id">{{ loc.id }}</code>
                <v-btn
                  size="x-small"
                  variant="text"
                  icon="mdi-content-copy"
                  :title="'Копіювати ' + loc.id"
                  @click="copyLocationId(loc.id)"
                />
                <v-btn
                  size="small"
                  variant="tonal"
                  color="pink-darken-2"
                  @click="useAsDefaultLocation(loc.id)"
                >
                  Підставити
                </v-btn>
              </div>
            </template>
          </v-list-item>
        </v-list>
        <v-card-text v-if="copiedLocationId" class="text-caption text-success pt-0">
          Скопійовано: {{ copiedLocationId }}
        </v-card-text>
      </v-card>

      <v-card
        v-if="testResult?.debug"
        variant="outlined"
        class="mt-3 beautypro-debug"
      >
        <v-card-title class="text-subtitle-1 d-flex align-center flex-wrap ga-2 py-3">
          <v-icon start size="small">mdi-bug</v-icon>
          DEBUG · BeautyPro API
          <v-chip
            v-if="testResult.debug.failedAtStage"
            size="small"
            color="warning"
            variant="tonal"
          >
            failed @ {{ testResult.debug.failedAtStage }}
          </v-chip>
          <v-chip
            v-else
            size="small"
            color="success"
            variant="tonal"
          >
            all stages ok
          </v-chip>
          <v-spacer />
          <v-btn
            size="small"
            variant="text"
            prepend-icon="mdi-content-copy"
            :disabled="copyDone"
            @click="copyDebugReport"
          >
            {{ copyDone ? 'Скопійовано' : 'Копіювати для підтримки' }}
          </v-btn>
        </v-card-title>
        <v-card-text class="pt-0">
          <div class="text-caption text-medium-emphasis mb-3">
            {{ testResult.debug.checkedAt }}
            · app {{ testResult.debug.applicationId }}
            · db {{ testResult.debug.databaseCode }}
            · secret: {{ testResult.debug.secretSource }}
            · matchesSaved: {{ testResult.debug.matchesSavedCredentials }}
            · tokens redacted
          </div>

          <v-timeline density="compact" side="end" truncate-line="both" class="mb-2">
            <v-timeline-item
              v-for="(step, idx) in testResult.debug.steps"
              :key="`${step.stage}-${idx}`"
              :dot-color="step.ok ? 'success' : 'error'"
              size="x-small"
            >
              <div class="d-flex align-center flex-wrap ga-2 mb-1">
                <strong class="text-body-2">{{ step.stage }}</strong>
                <v-chip size="x-small" variant="tonal">{{ step.method }}</v-chip>
                <v-chip
                  v-if="step.httpStatus != null"
                  size="x-small"
                  :color="step.httpStatus < 400 ? 'success' : 'error'"
                  variant="tonal"
                >
                  HTTP {{ step.httpStatus }}
                </v-chip>
                <span v-if="step.durationMs != null" class="text-caption text-medium-emphasis">
                  {{ step.durationMs }} ms
                </span>
              </div>
              <div class="text-caption text-medium-emphasis text-break mb-1">
                {{ step.url }}
              </div>
              <div v-if="step.note" class="text-caption mb-1">{{ step.note }}</div>
              <div v-if="step.error" class="text-caption text-error mb-1">{{ step.error }}</div>
              <pre
                v-if="step.response !== undefined"
                class="beautypro-debug__pre"
              >{{ formatJson(step.response) }}</pre>
            </v-timeline-item>
          </v-timeline>

          <details class="mt-2">
            <summary class="text-caption cursor-pointer">Повний JSON dump</summary>
            <pre class="beautypro-debug__pre mt-2">{{ formatJson(testResult.debug) }}</pre>
          </details>
        </v-card-text>
      </v-card>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
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

interface BeautyproLocationRow {
  id: string;
  name: string;
  address?: string;
}

interface BeautyproDebugStep {
  stage: string;
  ok: boolean;
  method: string;
  url: string;
  httpStatus?: number;
  durationMs?: number;
  response?: unknown;
  error?: string;
  note?: string;
}

interface BeautyproTestResponse {
  ok: boolean;
  status: 'granted' | 'pending' | 'refused' | 'error';
  message: string;
  server?: number;
  expiresAt?: string;
  database?: string;
  locationCount?: number;
  locations?: BeautyproLocationRow[];
  locationsPreview?: BeautyproLocationRow[];
  persisted?: boolean;
  debug?: {
    checkedAt: string;
    failedAtStage: string | null;
    applicationId: string;
    databaseCode: string;
    secretSource: 'override' | 'saved' | 'missing';
    matchesSavedCredentials: boolean;
    steps: BeautyproDebugStep[];
  };
}

const beautypro = defineModel<BeautyproIntegrationShape>({ required: true });
const showSecret = ref(false);
const testLoading = ref(false);
const debugMode = ref(false);
const testResult = ref<BeautyproTestResponse | null>(null);
const copyDone = ref(false);
const copiedLocationId = ref('');

const emit = defineEmits<{
  tested: [result: BeautyproTestResponse];
}>();

const locationsList = computed(() => {
  const data = testResult.value;
  if (!data) return [] as BeautyproLocationRow[];
  return data.locations?.length ? data.locations : (data.locationsPreview ?? []);
});

function formatExpiry(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString('uk-UA');
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function clearTestResult() {
  testResult.value = null;
  copyDone.value = false;
  copiedLocationId.value = '';
}

function applyAuthFromResult(data: BeautyproTestResponse) {
  if (data.ok && data.persisted) {
    beautypro.value.authStatus = 'granted';
    if (data.expiresAt) beautypro.value.tokenExpiresAt = data.expiresAt;
    if (data.server) beautypro.value.apiServer = data.server;
  } else if (data.status === 'pending' || data.status === 'refused') {
    beautypro.value.authStatus = data.status;
  }
}

async function copyLocationId(id: string) {
  try {
    await navigator.clipboard.writeText(id);
    copiedLocationId.value = id;
    setTimeout(() => {
      if (copiedLocationId.value === id) copiedLocationId.value = '';
    }, 2000);
  } catch {
    // ignore
  }
}

function useAsDefaultLocation(id: string) {
  beautypro.value.defaultLocationId = id;
  void copyLocationId(id);
}

async function copyDebugReport() {
  if (!testResult.value?.debug) return;
  const report = {
    summary: testResult.value.message,
    status: testResult.value.status,
    ok: testResult.value.ok,
    locations: locationsList.value,
    debug: testResult.value.debug,
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    copyDone.value = true;
    setTimeout(() => {
      copyDone.value = false;
    }, 2000);
  } catch {
    // ignore clipboard errors
  }
}

async function runConnectionTest(withDebug: boolean) {
  testLoading.value = true;
  debugMode.value = withDebug;
  testResult.value = null;
  copyDone.value = false;
  copiedLocationId.value = '';
  try {
    const payload: Record<string, string | boolean> = {
      applicationId: beautypro.value.applicationId.trim(),
      databaseCode: beautypro.value.databaseCode.trim(),
      debug: withDebug,
    };
    const secret = beautypro.value.applicationSecret.trim();
    if (secret && secret !== '••••••') {
      payload.applicationSecret = secret;
    }

    const { data } = await api.post<BeautyproTestResponse>(
      '/settings/beautypro/test',
      payload,
      { validateStatus: (s) => s < 500 },
    );
    testResult.value = data;
    applyAuthFromResult(data);
    emit('tested', data);
  } catch (e: unknown) {
    const err = e as { response?: { data?: BeautyproTestResponse & { error?: string } } };
    const data = err.response?.data;
    testResult.value = {
      ok: false,
      status: data?.status ?? 'error',
      message: data?.message ?? data?.error ?? 'Не вдалося виконати перевірку',
      locations: data?.locations,
      locationsPreview: data?.locationsPreview,
      debug: data?.debug,
    };
  } finally {
    testLoading.value = false;
  }
}
</script>

<style scoped>
.beautypro-debug__pre {
  margin: 0;
  padding: 8px 10px;
  max-height: 280px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.35;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.04);
  white-space: pre-wrap;
  word-break: break-word;
}
.beautypro-loc-id {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.75;
}
.text-break {
  word-break: break-all;
}
</style>
