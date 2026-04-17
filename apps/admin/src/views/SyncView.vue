<template>
  <v-container fluid>
    <v-row class="mb-4" align="center">
      <v-col>
        <div class="page-title">Синхронізація</div>
      </v-col>
      <v-col cols="auto">
        <v-btn
          color="primary"
          prepend-icon="mdi-sync"
          :loading="triggering"
          @click="triggerSync"
        >
          Синхронізувати зараз
        </v-btn>
      </v-col>
    </v-row>

    <v-alert v-if="triggerSuccess" type="success" density="compact" class="mb-4" closable>
      {{ triggerSuccess }}
    </v-alert>
    <v-alert v-if="error" type="error" density="compact" class="mb-4" closable>
      {{ error }}
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
            :color="item.status === 'ok' ? 'green' : 'red'"
            size="small"
            label
          >
            {{ item.status === 'ok' ? 'Успішно' : 'Помилка' }}
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
              Категорій: {{ item.counts.categories ?? '—' }}
            </v-chip>
            <v-chip size="x-small" class="mr-1" variant="outlined">
              Товарів: {{ item.counts.products ?? '—' }}
            </v-chip>
            <v-chip size="x-small" variant="outlined">
              Варіантів: {{ item.counts.offers ?? '—' }}
            </v-chip>
          </template>
          <span v-else class="text-grey">—</span>
        </template>

        <template #item.errorMessage="{ item }">
          <span v-if="item.status === 'error' && item.errorMessage" class="text-red text-body-2">
            {{ item.errorMessage }}
          </span>
          <span v-else>—</span>
        </template>
      </v-data-table>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import api from '@/api';

interface SyncCounts {
  categories?: number;
  products?: number;
  offers?: number;
}

interface SyncRun {
  id: string;
  status: 'ok' | 'error';
  startedAt: string;
  finishedAt?: string;
  counts?: SyncCounts;
  errorMessage?: string;
}

const runs = ref<SyncRun[]>([]);
const loading = ref(false);
const triggering = ref(false);
const error = ref('');
const triggerSuccess = ref('');

const headers = [
  { title: 'Статус', key: 'status', width: '110px', sortable: false },
  { title: 'Початок', key: 'startedAt', width: '180px', sortable: false },
  { title: 'Завершення', key: 'finishedAt', width: '180px', sortable: false },
  { title: 'Тривалість', key: 'duration', width: '120px', sortable: false },
  { title: 'Кількість', key: 'counts', sortable: false },
  { title: 'Помилка', key: 'errorMessage', sortable: false },
];

function formatDate(dateStr?: string): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('uk-UA');
}

function calcDuration(start?: string, end?: string): string {
  if (!start || !end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms} мс`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes} хв ${remainingSeconds} с`;
}

async function fetchSyncStatus() {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/sync/status');
    runs.value = (data.runs || []).slice(0, 20);
  } catch (e) {
    error.value = 'Не вдалося завантажити статус синхронізації';
  } finally {
    loading.value = false;
  }
}

async function triggerSync() {
  triggering.value = true;
  error.value = '';
  triggerSuccess.value = '';
  try {
    const { data } = await api.post('/sync/trigger');
    triggerSuccess.value = data.message || 'Синхронізацію запущено';
    // Refresh the list after a short delay to let the sync start
    setTimeout(() => {
      fetchSyncStatus();
    }, 2000);
  } catch (e) {
    error.value = 'Не вдалося запустити синхронізацію';
  } finally {
    triggering.value = false;
  }
}

onMounted(() => {
  fetchSyncStatus();
});
</script>
