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
          :disabled="busy"
          prepend-icon="mdi-lan-check"
          @click="runConnectionTest(false)"
        >
          Перевірити підключення
        </v-btn>
        <v-btn
          color="grey-darken-2"
          variant="outlined"
          :loading="testLoading && debugMode"
          :disabled="busy"
          prepend-icon="mdi-bug"
          @click="runConnectionTest(true)"
        >
          DEBUG
        </v-btn>
        <span class="text-caption text-medium-emphasis">
          Auth → Grant → GET /locations. Краще спочатку Зберегти інтеграції.
        </span>
      </div>

      <div class="d-flex flex-wrap align-center ga-2 mb-2">
        <v-btn
          size="small"
          variant="tonal"
          :loading="probeLoading === 'services'"
          :disabled="busy"
          prepend-icon="mdi-content-cut"
          @click="runProbe(['services'], false)"
        >
          Послуги + ціни
        </v-btn>
        <v-btn
          size="small"
          variant="tonal"
          :loading="probeLoading === 'employees'"
          :disabled="busy"
          prepend-icon="mdi-account-tie"
          @click="runProbe(['employees'], false)"
        >
          Майстри
        </v-btn>
        <v-btn
          size="small"
          variant="tonal"
          :loading="probeLoading === 'all'"
          :disabled="busy"
          prepend-icon="mdi-database-search"
          @click="runProbe(['locations', 'services', 'employees'], true)"
        >
          Усе (+ DEBUG)
        </v-btn>
      </div>

      <v-alert
        v-if="statusMessage"
        :type="statusOk ? 'success' : statusPending ? 'warning' : 'error'"
        variant="tonal"
        density="compact"
        closable
        class="mt-2"
        @click:close="clearStatus"
      >
        {{ statusMessage }}
      </v-alert>

      <v-card
        v-if="locationsList.length"
        variant="outlined"
        class="mt-3"
      >
        <v-card-title class="text-subtitle-2 d-flex align-center py-3">
          <v-icon start size="small">mdi-map-marker-multiple</v-icon>
          Локації ({{ locationsList.length }})
          <v-spacer />
          <span class="text-caption text-medium-emphasis font-weight-regular">
            Підставити / скопіювати UUID
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
                  @click="copyText(loc.id)"
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
      </v-card>

      <v-card
        v-if="servicesList.length"
        variant="outlined"
        class="mt-3"
      >
        <v-card-title class="text-subtitle-2 d-flex align-center py-3">
          <v-icon start size="small">mdi-content-cut</v-icon>
          Послуги ({{ servicesList.length }})
        </v-card-title>
        <v-table density="compact" class="text-caption">
          <thead>
            <tr>
              <th>Назва</th>
              <th>Категорія</th>
              <th>Хв</th>
              <th>Ціна</th>
              <th>ID</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in servicesList" :key="s.id">
              <td>{{ s.name }}</td>
              <td>{{ s.categoryName || '—' }}</td>
              <td>{{ s.durationMin }}</td>
              <td>
                {{ s.price }}
                <span
                  v-if="s.locationPrices?.length"
                  class="text-medium-emphasis"
                >
                  ({{ s.locationPrices.length }} лок.)
                </span>
              </td>
              <td><code class="beautypro-loc-id">{{ s.id }}</code></td>
              <td>
                <v-btn
                  size="x-small"
                  variant="text"
                  icon="mdi-content-copy"
                  @click="copyText(s.id)"
                />
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card>

      <v-card
        v-if="employeesList.length"
        variant="outlined"
        class="mt-3"
      >
        <v-card-title class="text-subtitle-2 d-flex align-center py-3">
          <v-icon start size="small">mdi-account-tie</v-icon>
          Майстри ({{ employeesList.length }})
        </v-card-title>
        <v-list density="compact" class="py-0">
          <v-list-item
            v-for="e in employeesList"
            :key="e.id"
            :title="e.name"
            :subtitle="e.id"
          >
            <template #append>
              <v-chip
                v-if="e.public === false"
                size="x-small"
                variant="tonal"
                class="mr-2"
              >
                private
              </v-chip>
              <code class="text-caption beautypro-loc-id mr-1">{{ e.id }}</code>
              <v-btn
                size="x-small"
                variant="text"
                icon="mdi-content-copy"
                @click="copyText(e.id)"
              />
            </template>
          </v-list-item>
        </v-list>
      </v-card>

      <v-card-text v-if="copiedHint" class="text-caption text-success px-0 pb-0">
        Скопійовано: {{ copiedHint }}
      </v-card-text>

      <v-card
        v-if="debugPayload"
        variant="outlined"
        class="mt-3 beautypro-debug"
      >
        <v-card-title class="text-subtitle-1 d-flex align-center flex-wrap ga-2 py-3">
          <v-icon start size="small">mdi-bug</v-icon>
          DEBUG · BeautyPro API
          <v-chip
            v-if="debugPayload.failedAtStage"
            size="small"
            color="warning"
            variant="tonal"
          >
            failed @ {{ debugPayload.failedAtStage }}
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
            {{ debugPayload.checkedAt }}
            <template v-if="'applicationId' in debugPayload">
              · app {{ (debugPayload as BeautyproTestDebug).applicationId }}
              · db {{ (debugPayload as BeautyproTestDebug).databaseCode }}
            </template>
            <template v-if="'datasets' in debugPayload">
              · datasets {{ ((debugPayload as BeautyproProbeDebug).datasets || []).join(', ') }}
            </template>
            · tokens redacted
          </div>

          <v-timeline density="compact" side="end" truncate-line="both" class="mb-2">
            <v-timeline-item
              v-for="(step, idx) in debugPayload.steps"
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
            <pre class="beautypro-debug__pre mt-2">{{ formatJson(debugPayload) }}</pre>
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

interface BeautyproServiceRow {
  id: string;
  name: string;
  durationMin: number;
  categoryName?: string;
  price: number;
  locationPrices?: Array<{ locationId: string; price: number }>;
}

interface BeautyproEmployeeRow {
  id: string;
  name: string;
  public?: boolean;
  archive?: boolean;
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

interface BeautyproTestDebug {
  checkedAt: string;
  failedAtStage: string | null;
  applicationId: string;
  databaseCode: string;
  secretSource: 'override' | 'saved' | 'missing';
  matchesSavedCredentials: boolean;
  steps: BeautyproDebugStep[];
}

interface BeautyproProbeDebug {
  checkedAt: string;
  failedAtStage: string | null;
  datasets: Array<'locations' | 'services' | 'employees'>;
  steps: BeautyproDebugStep[];
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
  debug?: BeautyproTestDebug;
}

interface BeautyproProbeResponse {
  ok: boolean;
  status: 'granted' | 'pending' | 'refused' | 'error';
  message: string;
  server?: number;
  locations?: BeautyproLocationRow[];
  services?: BeautyproServiceRow[];
  employees?: BeautyproEmployeeRow[];
  debug?: BeautyproProbeDebug;
}

const beautypro = defineModel<BeautyproIntegrationShape>({ required: true });
const showSecret = ref(false);
const testLoading = ref(false);
const debugMode = ref(false);
const probeLoading = ref<'services' | 'employees' | 'all' | ''>('');
const statusMessage = ref('');
const statusOk = ref(false);
const statusPending = ref(false);
const locationsList = ref<BeautyproLocationRow[]>([]);
const servicesList = ref<BeautyproServiceRow[]>([]);
const employeesList = ref<BeautyproEmployeeRow[]>([]);
const debugPayload = ref<BeautyproTestDebug | BeautyproProbeDebug | null>(null);
const copyDone = ref(false);
const copiedHint = ref('');

const emit = defineEmits<{
  tested: [result: BeautyproTestResponse];
}>();

const busy = computed(() => testLoading.value || Boolean(probeLoading.value));

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

function clearStatus() {
  statusMessage.value = '';
  statusOk.value = false;
  statusPending.value = false;
}

function credPayload(): Record<string, string> {
  const payload: Record<string, string> = {
    applicationId: beautypro.value.applicationId.trim(),
    databaseCode: beautypro.value.databaseCode.trim(),
  };
  const secret = beautypro.value.applicationSecret.trim();
  if (secret && secret !== '••••••') {
    payload.applicationSecret = secret;
  }
  return payload;
}

function applyAuthFromResult(data: BeautyproTestResponse | BeautyproProbeResponse) {
  if (data.ok && 'persisted' in data && data.persisted) {
    beautypro.value.authStatus = 'granted';
    if (data.expiresAt) beautypro.value.tokenExpiresAt = data.expiresAt;
    if (data.server) beautypro.value.apiServer = data.server;
  } else if (data.status === 'pending' || data.status === 'refused') {
    beautypro.value.authStatus = data.status;
  } else if (data.ok) {
    beautypro.value.authStatus = 'granted';
    if (data.server) beautypro.value.apiServer = data.server;
  }
}

async function copyText(id: string) {
  try {
    await navigator.clipboard.writeText(id);
    copiedHint.value = id;
    setTimeout(() => {
      if (copiedHint.value === id) copiedHint.value = '';
    }, 2000);
  } catch {
    // ignore
  }
}

function useAsDefaultLocation(id: string) {
  beautypro.value.defaultLocationId = id;
  void copyText(id);
}

async function copyDebugReport() {
  if (!debugPayload.value) return;
  const report = {
    summary: statusMessage.value,
    locations: locationsList.value,
    services: servicesList.value,
    employees: employeesList.value,
    debug: debugPayload.value,
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    copyDone.value = true;
    setTimeout(() => {
      copyDone.value = false;
    }, 2000);
  } catch {
    // ignore
  }
}

async function runConnectionTest(withDebug: boolean) {
  testLoading.value = true;
  debugMode.value = withDebug;
  clearStatus();
  locationsList.value = [];
  servicesList.value = [];
  employeesList.value = [];
  debugPayload.value = null;
  copyDone.value = false;
  try {
    const { data } = await api.post<BeautyproTestResponse>(
      '/settings/beautypro/test',
      { ...credPayload(), debug: withDebug },
      { validateStatus: (s) => s < 500 },
    );
    statusMessage.value = data.message;
    statusOk.value = data.ok;
    statusPending.value = data.status === 'pending';
    locationsList.value = data.locations?.length
      ? data.locations
      : (data.locationsPreview ?? []);
    debugPayload.value = data.debug ?? null;
    applyAuthFromResult(data);
    emit('tested', data);
  } catch (e: unknown) {
    const err = e as { response?: { data?: BeautyproTestResponse & { error?: string } } };
    const data = err.response?.data;
    statusMessage.value = data?.message ?? data?.error ?? 'Не вдалося виконати перевірку';
    statusOk.value = false;
    statusPending.value = data?.status === 'pending';
    locationsList.value = data?.locations ?? data?.locationsPreview ?? [];
    debugPayload.value = data?.debug ?? null;
  } finally {
    testLoading.value = false;
  }
}

async function runProbe(
  datasets: Array<'locations' | 'services' | 'employees'>,
  withDebug: boolean,
) {
  probeLoading.value =
    datasets.length > 1 ? 'all' : datasets[0] === 'employees' ? 'employees' : 'services';
  clearStatus();
  if (datasets.includes('locations')) locationsList.value = [];
  if (datasets.includes('services')) servicesList.value = [];
  if (datasets.includes('employees')) employeesList.value = [];
  if (withDebug) debugPayload.value = null;
  copyDone.value = false;
  try {
    const { data } = await api.post<BeautyproProbeResponse>(
      '/settings/beautypro/probe',
      { ...credPayload(), datasets, debug: withDebug },
      { validateStatus: (s) => s < 500 },
    );
    statusMessage.value = data.message;
    statusOk.value = data.ok;
    statusPending.value = data.status === 'pending';
    if (data.locations) locationsList.value = data.locations;
    if (data.services) servicesList.value = data.services;
    if (data.employees) employeesList.value = data.employees;
    if (data.debug) debugPayload.value = data.debug;
    applyAuthFromResult(data);
  } catch (e: unknown) {
    const err = e as { response?: { data?: BeautyproProbeResponse & { error?: string } } };
    const data = err.response?.data;
    statusMessage.value = data?.message ?? data?.error ?? 'Не вдалося виконати probe';
    statusOk.value = false;
    statusPending.value = data?.status === 'pending';
    if (data?.locations) locationsList.value = data.locations;
    if (data?.services) servicesList.value = data.services;
    if (data?.employees) employeesList.value = data.employees;
    if (data?.debug) debugPayload.value = data.debug;
  } finally {
    probeLoading.value = '';
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
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.75;
  display: inline-block;
  vertical-align: bottom;
}
.text-break {
  word-break: break-all;
}
</style>
