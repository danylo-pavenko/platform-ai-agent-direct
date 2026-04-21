<template>
  <v-container fluid>
    <v-row class="mb-4" align="center">
      <v-col>
        <div class="page-title">Синхронізація</div>
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
            <v-chip size="x-small" class="mr-1" variant="outlined">
              Категорій: {{ item.counts.categories ?? '-' }}
            </v-chip>
            <v-chip size="x-small" class="mr-1" variant="outlined">
              Товарів: {{ item.counts.products ?? '-' }}
            </v-chip>
            <v-chip size="x-small" variant="outlined">
              Варіантів: {{ item.counts.offers ?? '-' }}
            </v-chip>
          </template>
          <span v-else class="text-grey">-</span>
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
}

interface SyncRun {
  id: string;
  status: 'running' | 'ok' | 'error';
  startedAt: string;
  finishedAt?: string | null;
  counts?: SyncCounts;
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
  { title: 'Статус', key: 'status', width: '130px', sortable: false },
  { title: 'Початок', key: 'startedAt', width: '180px', sortable: false },
  { title: 'Завершення', key: 'finishedAt', width: '180px', sortable: false },
  { title: 'Тривалість', key: 'duration', width: '120px', sortable: false },
  { title: 'Кількість', key: 'counts', sortable: false },
  { title: 'Помилка', key: 'errorMessage', sortable: false },
];

const latestRun = computed<SyncRun | null>(() => runs.value[0] ?? null);
const isRunning = computed(() => latestRun.value?.status === 'running');

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

// ── Polling ────────────────────────────────────────────────────────────────
// Only poll while the latest run is still 'running'. Once it flips to
// ok/error we stop, so the tab goes quiet when nothing's happening.

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
