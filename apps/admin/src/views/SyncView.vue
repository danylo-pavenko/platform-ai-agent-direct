<template>
  <v-container fluid>
    <v-row class="mb-4" align="center">
      <v-col>
        <div class="page-title">Синхронізація</div>
        <div class="text-body-2 text-medium-emphasis">
          Каталог товарів, послуг і цін з підключених CRM. Деталі кожного run — джерело даних.
        </div>
      </v-col>
      <v-col cols="auto">
        <v-btn
          color="primary"
          :prepend-icon="isRunning ? 'mdi-progress-clock' : 'mdi-sync'"
          :loading="triggering"
          :disabled="isRunning"
          @click="triggerSync"
        >
          {{ isRunning ? 'Виконується…' : 'Синхронізувати зараз' }}
        </v-btn>
      </v-col>
    </v-row>

    <v-alert v-if="triggerSuccess" type="success" density="compact" class="mb-4" closable>
      {{ triggerSuccess }}
    </v-alert>
    <v-alert v-if="error" type="error" density="compact" class="mb-4" closable>
      {{ error }}
    </v-alert>
    <v-alert v-if="isRunning" type="info" density="compact" class="mb-4" variant="tonal">
      <div class="d-flex align-center ga-2">
        <v-progress-circular indeterminate size="16" width="2" />
        <span>Синхронізація триває з {{ formatDate(latestRun?.startedAt) }}. Сторінка оновлюється автоматично.</span>
      </div>
    </v-alert>

    <v-row v-if="latestOkRun" class="mb-4">
      <v-col cols="12" sm="6" md="3">
        <v-card variant="tonal" color="primary">
          <v-card-text>
            <div class="text-caption">Останній успішний run</div>
            <div class="text-h6">{{ providerLabel(latestOkRun.provider) }}</div>
            <div class="text-caption">{{ syncTypeLabel(latestOkRun.syncType) }}</div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col v-for="chip in latestSourceChips" :key="chip.label" cols="12" sm="6" md="3">
        <v-card variant="outlined">
          <v-card-text>
            <div class="text-caption text-medium-emphasis">{{ chip.label }}</div>
            <div class="text-h6">{{ chip.count ?? '—' }}</div>
            <div class="text-caption">{{ chip.provider }}</div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-card>
      <v-card-title>Останні синхронізації</v-card-title>
      <v-data-table
        :headers="headers"
        :items="runs"
        :loading="loading"
        hover
      >
        <template #item.status="{ item }">
          <v-chip
            :color="statusColor(item.status)"
            size="small"
            label
          >
            <v-progress-circular
              v-if="item.status === 'running'"
              indeterminate
              size="12"
              width="2"
              class="mr-2"
            />
            {{ statusLabel(item.status) }}
          </v-chip>
        </template>

        <template #item.provider="{ item }">
          <v-chip size="small" variant="tonal" :color="providerColor(item.provider)">
            {{ providerLabel(item.provider) }}
          </v-chip>
        </template>

        <template #item.syncType="{ item }">
          {{ syncTypeLabel(item.syncType) }}
        </template>

        <template #item.startedAt="{ item }">
          {{ formatDate(item.startedAt) }}
        </template>

        <template #item.finishedAt="{ item }">
          {{ formatDate(item.finishedAt) }}
        </template>

        <template #item.duration="{ item }">
          {{ calcDuration(item.startedAt, item.finishedAt) }}
        </template>

        <template #item.counts="{ item }">
          <template v-if="item.counts">
            <v-chip v-if="item.counts.categories != null" size="x-small" class="mr-1" variant="outlined">
              Категорій: {{ item.counts.categories }}
            </v-chip>
            <v-chip v-if="item.counts.products != null" size="x-small" class="mr-1" variant="outlined">
              Товарів: {{ item.counts.products }}
            </v-chip>
            <v-chip v-if="item.counts.offers != null" size="x-small" class="mr-1" variant="outlined">
              Варіантів: {{ item.counts.offers }}
            </v-chip>
            <v-chip v-if="item.counts.services != null" size="x-small" variant="outlined">
              Послуг: {{ item.counts.services }}
            </v-chip>
          </template>
          <span v-else class="text-grey">-</span>
        </template>

        <template #item.artifacts="{ item }">
          <span v-if="artifactSummary(item)" class="text-caption text-medium-emphasis">
            {{ artifactSummary(item) }}
          </span>
          <span v-else>-</span>
        </template>

        <template #item.errorMessage="{ item }">
          <span v-if="item.status === 'error' && item.errorMessage" class="text-red text-body-2">
            {{ item.errorMessage }}
          </span>
          <span v-else>-</span>
        </template>
      </v-data-table>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import api from '@/api';

interface SyncCounts {
  categories?: number;
  products?: number;
  offers?: number;
  services?: number;
}

interface SyncArtifacts {
  catalogPath?: string;
  servicesPath?: string;
  sources?: Record<string, { provider: string; count: number }>;
}

interface SyncRun {
  id: string;
  status: 'running' | 'ok' | 'error';
  provider?: string;
  syncType?: string;
  startedAt: string;
  finishedAt?: string | null;
  counts?: SyncCounts;
  artifacts?: SyncArtifacts;
  errorMessage?: string | null;
}

const runs = ref<SyncRun[]>([]);
const loading = ref(false);
const triggering = ref(false);
const error = ref('');
const triggerSuccess = ref('');

const POLL_INTERVAL_MS = 3_000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const headers = [
  { title: 'Статус', key: 'status', width: '120px', sortable: false },
  { title: 'CRM', key: 'provider', width: '110px', sortable: false },
  { title: 'Тип', key: 'syncType', width: '100px', sortable: false },
  { title: 'Початок', key: 'startedAt', width: '160px', sortable: false },
  { title: 'Завершення', key: 'finishedAt', width: '160px', sortable: false },
  { title: 'Тривалість', key: 'duration', width: '110px', sortable: false },
  { title: 'Кількість', key: 'counts', sortable: false },
  { title: 'Файли', key: 'artifacts', sortable: false },
  { title: 'Помилка', key: 'errorMessage', sortable: false },
];

const latestRun = computed<SyncRun | null>(() => runs.value[0] ?? null);
const isRunning = computed(() => latestRun.value?.status === 'running');
const latestOkRun = computed(() => runs.value.find((r) => r.status === 'ok') ?? null);

const latestSourceChips = computed(() => {
  const run = latestOkRun.value;
  if (!run?.artifacts?.sources) {
    if (!run?.counts) return [];
    const chips: Array<{ label: string; count: number; provider: string }> = [];
    if (run.counts.products != null) {
      chips.push({ label: 'Товари', count: run.counts.products, provider: providerLabel(run.provider) });
    }
    if (run.counts.services != null) {
      chips.push({ label: 'Послуги', count: run.counts.services, provider: providerLabel(run.provider) });
    }
    return chips;
  }
  return Object.entries(run.artifacts.sources).map(([key, src]) => ({
    label: sourceLabel(key),
    count: src.count,
    provider: providerLabel(src.provider),
  }));
});

function sourceLabel(key: string): string {
  const map: Record<string, string> = {
    categories: 'Категорії',
    products: 'Товари',
    offers: 'Варіанти',
    services: 'Послуги',
    branches: 'Філії',
  };
  return map[key] ?? key;
}

function providerLabel(p?: string): string {
  if (!p) return '—';
  if (p === 'keycrm') return 'KeyCRM';
  if (p === 'cleverbox') return 'CleverBOX';
  return p;
}

function providerColor(p?: string): string {
  if (p === 'cleverbox') return 'deep-purple';
  if (p === 'keycrm') return 'green-darken-1';
  return 'grey';
}

function syncTypeLabel(t?: string): string {
  if (!t) return 'каталог';
  const map: Record<string, string> = {
    catalog: 'Каталог товарів',
    services: 'Послуги',
    branches: 'Філії',
    full: 'Повна',
  };
  return map[t] ?? t;
}

function artifactSummary(item: SyncRun): string {
  const parts: string[] = [];
  if (item.artifacts?.catalogPath) parts.push('catalog.txt');
  if (item.artifacts?.servicesPath) parts.push('services-live.txt');
  return parts.join(', ');
}

function formatDate(dateStr?: string | null): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('uk-UA');
}

function calcDuration(start?: string | null, end?: string | null): string {
  if (!start || !end) return '-';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms} мс`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes} хв ${remainingSeconds} с`;
}

function statusLabel(status: SyncRun['status']): string {
  switch (status) {
    case 'running': return 'В процесі';
    case 'ok':      return 'Успішно';
    case 'error':   return 'Помилка';
    default:        return status;
  }
}

function statusColor(status: SyncRun['status']): string {
  switch (status) {
    case 'running': return 'blue';
    case 'ok':      return 'green';
    case 'error':   return 'red';
    default:        return 'grey';
  }
}

async function fetchSyncStatus(showLoader = true) {
  if (showLoader) loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/sync/status');
    runs.value = Array.isArray(data?.runs) ? data.runs : [];
  } catch {
    error.value = 'Не вдалося завантажити статус синхронізації';
  } finally {
    if (showLoader) loading.value = false;
  }
}

async function triggerSync() {
  triggering.value = true;
  error.value = '';
  triggerSuccess.value = '';
  try {
    const { data } = await api.post('/sync/trigger');
    triggerSuccess.value = data.message || 'Синхронізацію запущено';
    await fetchSyncStatus(false);
  } catch (e: any) {
    if (e.response?.status === 409) {
      error.value = `Синхронізація вже виконується (з ${formatDate(e.response.data?.startedAt)})`;
      await fetchSyncStatus(false);
    } else {
      error.value = 'Не вдалося запустити синхронізацію';
    }
  } finally {
    triggering.value = false;
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    fetchSyncStatus(false);
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

watch(isRunning, (running) => {
  if (running) startPolling();
  else stopPolling();
});

onMounted(() => {
  fetchSyncStatus();
});

onUnmounted(() => {
  stopPolling();
});
</script>
