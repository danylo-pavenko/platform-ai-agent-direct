<template>
  <v-container fluid class="conversations-page pa-4 pa-md-6 page-shell">
    <PageHeader
      title="Розмови"
      subtitle="Діалоги з Instagram та статус обробки"
    >
      <template #actions>
        <div
          class="refresh-timer d-inline-flex align-center ga-1 text-caption text-medium-emphasis"
          :title="refreshInFlight ? 'Оновлення…' : `Автооновлення кожні ${REFRESH_INTERVAL_SEC} с`"
        >
          <v-icon
            size="16"
            :icon="refreshInFlight ? 'mdi-loading' : 'mdi-timer-outline'"
            :class="{ 'refresh-timer__spin': refreshInFlight }"
          />
          <span v-if="refreshInFlight">Оновлення…</span>
          <span v-else>через {{ secondsUntilRefresh }} с</span>
        </div>
      </template>
    </PageHeader>

    <v-card class="conversations-card" elevation="0" border rounded="xl">
      <v-card-text class="pa-4 pa-md-5">
        <v-row dense class="filters-row mb-3">
          <v-col cols="12" sm="5" md="4" lg="3">
            <v-select
              v-model="stateFilter"
              :items="stateOptions"
              item-title="title"
              item-value="value"
              label="Статус"
              :density="density"
              variant="outlined"
              hide-details
              class="filter-field"
            />
          </v-col>
          <v-col cols="12" sm="7" md="5" lg="4">
            <v-text-field
              v-model="search"
              label="Пошук за імʼям, @username або IGSID"
              prepend-inner-icon="mdi-magnify"
              :density="density"
              variant="outlined"
              hide-details
              clearable
              class="filter-field"
              @click:clear="search = ''"
            />
          </v-col>
        </v-row>

        <ResponsiveDataList
          :loading="loading"
          :empty="!loading && conversations.length === 0"
          empty-text="Немає розмов"
          :show-pagination="!mdAndUp && total > 0"
          :page="page"
          :items-per-page="limit"
          :items-length="total"
          @update:page="page = $event"
        >
          <template #table>
            <v-data-table-server
              :headers="headers"
              :items="conversations"
              :items-length="total"
              :items-per-page="limit"
              :page="page"
              :loading="loading"
              hover
              density="comfortable"
              @update:page="page = $event"
              @update:items-per-page="limit = $event"
              @click:row="(_: unknown, row: { item: Conversation }) => goToConversation(row.item)"
              class="conversations-table cursor-pointer"
            >
              <template #item.id="{ item }">
                <span class="conv-id">{{ item.id?.substring(0, 8) }}</span>
              </template>

              <template #item.client="{ item }">
                <div class="client-cell d-flex align-center ga-3 py-1">
                  <v-avatar size="40" class="client-avatar" rounded="lg">
                    <span class="text-caption font-weight-medium">{{ clientInitials(item) }}</span>
                  </v-avatar>
                  <div class="client-cell-text min-w-0">
                    <div class="client-primary text-body-2 font-weight-medium text-truncate">
                      {{ clientPrimaryName(item) }}
                    </div>
                    <div class="client-secondary text-caption text-medium-emphasis text-truncate">
                      {{ clientSecondaryLine(item) || '—' }}
                    </div>
                    <div v-if="item.hasManagerReply" class="mt-1">
                      <v-chip
                        color="orange-darken-2"
                        size="x-small"
                        variant="tonal"
                        prepend-icon="mdi-account-voice"
                        class="manager-chip"
                      >
                        Менеджер відповів
                      </v-chip>
                    </div>
                  </div>
                </div>
              </template>

              <template #item.channel="{ item }">
                <div class="channel-cell d-inline-flex align-center ga-1 text-body-2">
                  <v-icon size="18" class="channel-icon">mdi-instagram</v-icon>
                  <span>{{ channelLabel(item.channel) }}</span>
                </div>
              </template>

              <template #item.state="{ item }">
                <div class="d-flex flex-column ga-1">
                  <v-chip
                    :color="stateColor(item.state)"
                    size="small"
                    label
                    class="state-chip font-weight-medium"
                  >
                    {{ stateLabel(item.state) }}
                  </v-chip>
                  <div
                    v-if="item.state === 'handoff' && item.assigneeLabel"
                    class="text-caption text-medium-emphasis"
                  >
                    {{ item.assigneeLabel }}
                  </div>
                </div>
              </template>

              <template #item.lastMessageAt="{ item }">
                <div class="time-cell">
                  <div class="time-primary text-body-2">{{ formatRelative(item.lastMessageAt) }}</div>
                  <div class="time-secondary text-caption text-medium-emphasis">
                    {{ formatAbsolute(item.lastMessageAt) }}
                  </div>
                </div>
              </template>
            </v-data-table-server>
          </template>

          <template #cards>
            <MobileListCard
              v-for="item in conversations"
              :key="item.id"
              @click="goToConversation(item)"
            >
              <template #prepend>
                <v-avatar size="44" class="client-avatar" rounded="lg">
                  <span class="text-caption font-weight-medium">{{ clientInitials(item) }}</span>
                </v-avatar>
              </template>
              <template #title>{{ clientPrimaryName(item) }}</template>
              <template #meta>
                {{ formatRelative(item.lastMessageAt) }}
                <span v-if="clientSecondaryLine(item)"> · {{ clientSecondaryLine(item) }}</span>
              </template>
              <template #chips>
                <v-chip :color="stateColor(item.state)" size="small" label>
                  {{ stateLabel(item.state) }}
                </v-chip>
                <v-chip size="small" variant="tonal" prepend-icon="mdi-instagram">
                  {{ channelLabel(item.channel) }}
                </v-chip>
                <v-chip
                  v-if="item.hasManagerReply"
                  color="orange-darken-2"
                  size="small"
                  variant="tonal"
                  prepend-icon="mdi-account-voice"
                >
                  Менеджер
                </v-chip>
              </template>
              <template #append>
                <v-icon color="medium-emphasis">mdi-chevron-right</v-icon>
              </template>
            </MobileListCard>
          </template>
        </ResponsiveDataList>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useDisplay } from 'vuetify';
import api from '@/api';
import PageHeader from '@/components/PageHeader.vue';
import MobileListCard from '@/components/MobileListCard.vue';
import ResponsiveDataList from '@/components/ResponsiveDataList.vue';
import { useTouchDensity } from '@/composables/useTouchDensity';
import { adminClientPrimaryName } from '@/lib/client-label';

const REFRESH_INTERVAL_SEC = 15;

interface Client {
  igUserId?: string;
  displayName?: string;
  igFullName?: string;
  igUsername?: string;
}

interface Conversation {
  id: string;
  client: Client;
  channel: string;
  state: string;
  lastMessageAt: string;
  hasManagerReply?: boolean;
  assigneeLabel?: string | null;
}

const router = useRouter();
const route = useRoute();
const { mdAndUp } = useDisplay();
const { density } = useTouchDensity();

const conversations = ref<Conversation[]>([]);
const total = ref(0);
const page = ref(1);
const limit = ref(20);
const loading = ref(false);
const stateFilter = ref('');
const search = ref('');
const secondsUntilRefresh = ref(REFRESH_INTERVAL_SEC);
const refreshInFlight = ref(false);

let tickTimer: ReturnType<typeof setInterval> | null = null;

const stateOptions = [
  { title: 'Усі', value: '' },
  { title: 'Бот', value: 'bot' },
  { title: 'Менеджер', value: 'handoff' },
  { title: 'Закрито', value: 'closed' },
  { title: 'Пауза', value: 'paused' },
];

const headers = [
  { title: 'ID', key: 'id', sortable: false, width: '100px' },
  { title: 'Клієнт', key: 'client', sortable: false, minWidth: '220px' },
  { title: 'Канал', key: 'channel', sortable: false, width: '140px' },
  { title: 'Статус', key: 'state', sortable: false, width: '130px' },
  { title: 'Активність', key: 'lastMessageAt', sortable: false, width: '168px' },
];

function stateColor(state: string): string {
  const colors: Record<string, string> = {
    bot: 'primary',
    handoff: 'orange-darken-2',
    closed: 'grey-darken-1',
    paused: 'purple-darken-1',
  };
  return colors[state] || 'grey';
}

function stateLabel(state: string): string {
  const labels: Record<string, string> = {
    bot: 'Бот',
    handoff: 'Менеджер',
    closed: 'Закрито',
    paused: 'Бот вимкнено',
  };
  return labels[state] ?? state;
}

function channelLabel(ch: string): string {
  if (ch === 'ig') return 'Instagram';
  return ch?.toUpperCase() ?? '—';
}

function clientPrimaryName(item: Conversation): string {
  return adminClientPrimaryName(item.client);
}

function clientSecondaryLine(item: Conversation): string {
  const c = item.client;
  if (!c) return '';
  const primary = clientPrimaryName(item);
  const parts: string[] = [];
  if (c.igUsername) {
    const at = `@${c.igUsername}`;
    if (primary !== at) parts.push(at);
  }
  if (c.igUserId) parts.push(`IGSID ${c.igUserId}`);
  return parts.join(' · ');
}

function clientInitials(item: Conversation): string {
  const name = clientPrimaryName(item);
  const letters = name.replace(/@/g, '').trim().split(/\s+/).filter(Boolean);
  if (letters.length >= 2) {
    return (letters[0]![0]! + letters[1]![0]!).toUpperCase().slice(0, 2);
  }
  if (letters.length === 1 && letters[0]!.length >= 2) {
    return letters[0]!.slice(0, 2).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase() || '?';
}

function formatRelative(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return 'щойно';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Щойно';
  if (mins < 60) return `${mins} хв тому`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} год тому`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} дн тому`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} тиж тому`;
  return formatAbsolute(dateStr);
}

function formatAbsolute(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function goToConversation(item: Conversation) {
  router.push({ name: 'conversation-detail', params: { id: item.id } });
}

function resetRefreshCountdown() {
  secondsUntilRefresh.value = REFRESH_INTERVAL_SEC;
}

async function fetchConversations(opts?: { silent?: boolean }) {
  const silent = opts?.silent === true;
  if (!silent) loading.value = true;
  try {
    const params: Record<string, unknown> = {
      page: page.value,
      limit: limit.value,
    };
    if (stateFilter.value) params.state = stateFilter.value;
    if (search.value) params.search = search.value;

    const { data } = await api.get('/conversations', { params });
    conversations.value = Array.isArray(data?.data) ? data.data : [];
    total.value = data?.total ?? 0;
  } catch {
    if (!silent) {
      conversations.value = [];
      total.value = 0;
    }
  } finally {
    if (!silent) loading.value = false;
    resetRefreshCountdown();
  }
}

async function runSilentRefresh() {
  if (refreshInFlight.value || loading.value || document.hidden) return;
  refreshInFlight.value = true;
  try {
    await fetchConversations({ silent: true });
  } finally {
    refreshInFlight.value = false;
    resetRefreshCountdown();
  }
}

function onVisibilityChange() {
  if (document.hidden) return;
  void runSilentRefresh();
}

function stopAutoRefresh() {
  if (tickTimer != null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  document.removeEventListener('visibilitychange', onVisibilityChange);
}

function startAutoRefresh() {
  stopAutoRefresh();
  resetRefreshCountdown();
  tickTimer = setInterval(() => {
    if (document.hidden || refreshInFlight.value || loading.value) return;
    if (secondsUntilRefresh.value <= 1) {
      void runSilentRefresh();
      return;
    }
    secondsUntilRefresh.value -= 1;
  }, 1000);
  document.addEventListener('visibilitychange', onVisibilityChange);
}

watch([page, limit], () => {
  void fetchConversations();
});

watch([stateFilter, search], () => {
  page.value = 1;
  void fetchConversations();
});

const validStates = ['bot', 'handoff', 'closed', 'paused'] as const;

onMounted(() => {
  const q = route.query.state;
  if (typeof q === 'string' && (validStates as readonly string[]).includes(q)) {
    stateFilter.value = q;
  }
  void fetchConversations().then(() => {
    startAutoRefresh();
  });
});

onUnmounted(() => {
  stopAutoRefresh();
});
</script>

<style scoped>
.conversations-page {
  max-width: 1280px;
  margin-inline: auto;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.page-title {
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.25;
  margin: 0;
}

.page-subtitle {
  margin: 4px 0 0;
  font-size: 0.875rem;
  line-height: 1.4;
}

.conversations-card {
  background: rgb(var(--v-theme-surface));
  border-color: rgba(var(--v-border-color), var(--v-border-opacity)) !important;
}

.filters-row {
  max-width: 720px;
}

.filter-field :deep(.v-field) {
  border-radius: 12px;
}

.conversations-table :deep(tbody tr) {
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.conversations-table :deep(tbody tr:hover) {
  background: rgba(var(--v-theme-primary), 0.04) !important;
}

.conv-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.8125rem;
  color: rgb(var(--v-theme-on-surface-variant));
  letter-spacing: 0.02em;
}

.client-avatar {
  background: linear-gradient(
    135deg,
    rgba(233, 30, 99, 0.2) 0%,
    rgba(156, 39, 176, 0.16) 100%
  ) !important;
  color: #880e4f !important;
  flex-shrink: 0;
}

.client-cell-text {
  min-width: 0;
}

.manager-chip {
  height: 22px !important;
}

.channel-icon {
  color: #e4405f;
  opacity: 0.95;
}

.time-cell {
  line-height: 1.35;
}

.time-primary {
  font-variant-numeric: tabular-nums;
}

.time-secondary {
  font-variant-numeric: tabular-nums;
}

.state-chip {
  text-transform: none;
  letter-spacing: 0.01em;
}

.refresh-timer {
  min-height: var(--tap-min, 44px);
  padding: 0 4px;
  user-select: none;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.refresh-timer__spin {
  animation: refresh-timer-spin 0.8s linear infinite;
}

@keyframes refresh-timer-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 600px) {
  .refresh-timer {
    font-size: 12px;
  }
}
</style>
