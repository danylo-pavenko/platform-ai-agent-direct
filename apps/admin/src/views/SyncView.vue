<template>
  <v-container fluid>
    <v-row class="mb-4" align="center">
      <v-col>
        <div class="page-title">Синхронізація</div>
        <div class="text-body-2 text-medium-emphasis">
          Каталог товарів, послуг, цін і майстрів з підключених CRM.
          Автозапуск раз на добу (~04:00) + ручний тригер. Деталі кожного run — джерело даних.
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
            <v-chip v-if="item.counts.services != null" size="x-small" class="mr-1" variant="outlined">
              Послуг: {{ item.counts.services }}
            </v-chip>
            <v-chip v-if="item.counts.masters != null" size="x-small" variant="outlined">
              Майстрів: {{ item.counts.masters }}
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

    <v-card class="mt-4">
      <v-card-title class="d-flex flex-wrap align-center ga-2 py-3">
        <span>Послуги та ціни</span>
        <v-chip v-if="servicesCount > 0" size="small" variant="tonal">
          {{ servicesCount }}
        </v-chip>
        <v-spacer />
        <span v-if="servicesSyncedAt" class="text-caption text-medium-emphasis font-weight-regular">
          Знімок sync · {{ formatDate(servicesSyncedAt) }}
        </span>
      </v-card-title>
      <v-card-subtitle class="pb-2">
        Знімок після синхронізації (services.json): ціни по рівнях майстрів з CRM (positions), не live API.
      </v-card-subtitle>

      <v-card-text v-if="servicesCount > 0 || servicesSearch" class="pt-0">
        <v-text-field
          v-model="servicesSearch"
          density="compact"
          variant="outlined"
          hide-details
          clearable
          prepend-inner-icon="mdi-magnify"
          placeholder="Пошук за назвою, категорією, грейдом або ID"
          class="mb-3"
          style="max-width: 420px"
        />
        <v-data-table
          :headers="serviceHeaders"
          :items="filteredServices"
          :loading="servicesLoading"
          :items-per-page="25"
          hover
          density="compact"
        >
          <template #item.provider="{ item }">
            <v-chip size="x-small" variant="tonal" :color="providerColor(item.provider)">
              {{ providerLabel(item.provider) }}
            </v-chip>
          </template>
          <template #item.durationMin="{ item }">
            {{ item.durationMin }} хв
          </template>
          <template #item.price="{ item }">
            <div>
              <div>{{ formatServicePriceDisplay(item) }}</div>
              <div
                v-if="formatServiceGradeBreakdown(item)"
                class="text-caption text-medium-emphasis"
              >
                {{ formatServiceGradeBreakdown(item) }}
              </div>
              <div
                v-else-if="!item.priceRows?.length"
                class="text-caption text-medium-emphasis"
              >
                Пересинхронізуйте, щоб побачити грейди
              </div>
              <div
                v-if="uniqueBranchCount(item) > 0"
                class="text-caption text-medium-emphasis"
              >
                ({{ uniqueBranchCount(item) }} філ.)
              </div>
            </div>
          </template>
          <template #item.categoryName="{ item }">
            {{ item.categoryName || '—' }}
          </template>
          <template #item.id="{ item }">
            <div class="d-flex align-center ga-1">
              <code class="text-caption">{{ item.id }}</code>
              <v-btn
                size="x-small"
                variant="text"
                icon="mdi-content-copy"
                @click="copyText(item.id)"
              />
            </div>
          </template>
          <template #no-data>
            <div class="text-medium-emphasis py-4">
              Нічого не знайдено за запитом «{{ servicesSearch }}».
            </div>
          </template>
        </v-data-table>
      </v-card-text>

      <v-card-text v-else-if="servicesLoading" class="d-flex align-center ga-2 py-6">
        <v-progress-circular indeterminate size="20" width="2" />
        <span class="text-body-2 text-medium-emphasis">Завантаження знімка послуг…</span>
      </v-card-text>

      <v-card-text v-else>
        <div class="text-body-2 text-medium-emphasis mb-3">
          Ще немає знімка послуг — запустіть синхронізацію після підключення BeautyPro або CleverBOX.
        </div>
        <v-btn
          color="primary"
          variant="tonal"
          prepend-icon="mdi-sync"
          :loading="triggering"
          :disabled="isRunning"
          @click="triggerSync"
        >
          Синхронізувати зараз
        </v-btn>
      </v-card-text>
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
  masters?: number;
}

interface SyncArtifacts {
  catalogPath?: string;
  servicesPath?: string;
  mastersPath?: string;
  sources?: Record<string, { provider?: string; count?: number; error?: string; skipped?: boolean }>;
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

interface SyncedService {
  id: string;
  name: string;
  price: number;
  durationMin: number;
  categoryName?: string;
  provider: string;
  branchPrices?: Array<{ branchId: string; branchName: string; price: number }>;
  priceRows?: Array<{
    branchId: string;
    positionId?: string;
    positionName?: string;
    price: number;
  }>;
}

const runs = ref<SyncRun[]>([]);
const loading = ref(false);
const triggering = ref(false);
const error = ref('');
const triggerSuccess = ref('');

const services = ref<SyncedService[]>([]);
const servicesCount = ref(0);
const servicesSyncedAt = ref<string | null>(null);
const servicesLoading = ref(false);
const servicesSearch = ref('');

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

const serviceHeaders = [
  { title: 'Назва', key: 'name', sortable: true },
  { title: 'Категорія', key: 'categoryName', sortable: true },
  { title: 'Тривалість', key: 'durationMin', width: '110px', sortable: true },
  { title: 'Ціна', key: 'price', width: '280px', sortable: true },
  { title: 'CRM', key: 'provider', width: '120px', sortable: true },
  { title: 'ID', key: 'id', width: '200px', sortable: false },
];

const latestRun = computed<SyncRun | null>(() => runs.value[0] ?? null);
const isRunning = computed(() => latestRun.value?.status === 'running');
const latestOkRun = computed(() => runs.value.find((r) => r.status === 'ok') ?? null);

const filteredServices = computed(() => {
  const q = servicesSearch.value.trim().toLowerCase();
  if (!q) return services.value;
  return services.value.filter((s) => {
    const grades = (s.priceRows ?? [])
      .map((r) => r.positionName ?? '')
      .join(' ');
    const hay = [s.name, s.categoryName ?? '', s.id, s.provider, grades]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
});

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
    if (run.counts.masters != null) {
      chips.push({ label: 'Майстри', count: run.counts.masters, provider: providerLabel(run.provider) });
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
    masters: 'Майстри',
    branches: 'Філії',
  };
  return map[key] ?? key;
}

function providerLabel(p?: string): string {
  if (!p) return '—';
  if (p === 'keycrm') return 'KeyCRM';
  if (p === 'cleverbox') return 'CleverBOX';
  if (p === 'beautypro') return 'BeautyPro';
  return p;
}

function providerColor(p?: string): string {
  if (p === 'cleverbox') return 'deep-purple';
  if (p === 'beautypro') return 'pink-darken-2';
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
  if (item.artifacts?.mastersPath) parts.push('masters-live.txt');
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

async function fetchServices(showLoader = true) {
  if (showLoader) servicesLoading.value = true;
  try {
    const { data } = await api.get('/sync/services');
    services.value = Array.isArray(data?.services) ? data.services : [];
    servicesCount.value = typeof data?.count === 'number' ? data.count : services.value.length;
    servicesSyncedAt.value = typeof data?.syncedAt === 'string' ? data.syncedAt : null;
  } catch {
    // Keep previous snapshot visible; status error is more important on this page.
  } finally {
    if (showLoader) servicesLoading.value = false;
  }
}

function formatPrice(price: number): string {
  if (!Number.isFinite(price)) return '—';
  return `${price} ₴`;
}

function uniqueBranchCount(item: SyncedService): number {
  const ids = new Set<string>();
  for (const row of item.priceRows ?? []) {
    if (row.branchId) ids.add(row.branchId);
  }
  if (ids.size > 0) return ids.size;
  for (const b of item.branchPrices ?? []) {
    if (b.branchId) ids.add(b.branchId);
  }
  return ids.size;
}

function formatServicePriceDisplay(item: SyncedService): string {
  const fromRows = (item.priceRows ?? [])
    .map((r) => r.price)
    .filter((p) => typeof p === 'number' && p > 0);
  if (fromRows.length > 0) {
    const min = Math.min(...fromRows);
    const max = Math.max(...fromRows);
    return min === max ? formatPrice(min) : `${min}–${max} ₴`;
  }
  return formatPrice(item.price);
}

function formatServiceGradeBreakdown(item: SyncedService): string {
  const byName = new Map<string, number>();
  for (const row of item.priceRows ?? []) {
    const name = row.positionName?.trim();
    if (!name || !(row.price > 0)) continue;
    const prev = byName.get(name);
    if (prev == null || row.price > prev) byName.set(name, row.price);
  }
  if (byName.size === 0) return '';
  return [...byName.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], 'uk'))
    .map(([name, price]) => `${name}: ${price}`)
    .join('; ');
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
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

watch(isRunning, (running, wasRunning) => {
  if (running) startPolling();
  else {
    stopPolling();
    // Reload services once when a run finishes (running → idle).
    if (wasRunning) fetchServices(false);
  }
});

onMounted(async () => {
  await Promise.all([fetchSyncStatus(), fetchServices()]);
  if (isRunning.value) startPolling();
});

onUnmounted(() => {
  stopPolling();
});
</script>
