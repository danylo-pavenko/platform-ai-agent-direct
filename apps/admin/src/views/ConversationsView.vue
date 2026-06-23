<template>
  <v-container fluid class="conversations-page pa-4 pa-md-6">
    <header class="page-header mb-6">
      <div class="page-header-text">
        <h1 class="page-title">Розмови</h1>
        <p class="page-subtitle text-medium-emphasis">
          Діалоги з Instagram та статус обробки
        </p>
      </div>
    </header>

    <v-card class="conversations-card" elevation="0" border rounded="xl">
      <v-card-text class="pa-4 pa-md-5">
        <v-row dense class="filters-row mb-1">
          <v-col cols="12" sm="5" md="4" lg="3">
            <v-select
              v-model="stateFilter"
              :items="stateOptions"
              item-title="title"
              item-value="value"
              label="Статус"
              density="comfortable"
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
              density="comfortable"
              variant="outlined"
              hide-details
              clearable
              class="filter-field"
              @click:clear="search = ''"
            />
          </v-col>
        </v-row>

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
            <v-chip
              :color="stateColor(item.state)"
              size="small"
              label
              class="state-chip font-weight-medium"
            >
              {{ stateLabel(item.state) }}
            </v-chip>
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
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import api from '@/api';

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
}

const router = useRouter();
const route = useRoute();

const conversations = ref<Conversation[]>([]);
const total = ref(0);
const page = ref(1);
const limit = ref(20);
const loading = ref(false);
const stateFilter = ref('');
const search = ref('');

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
  const c = item.client;
  if (!c) return 'Клієнт';
  return (
    c.displayName ||
    c.igFullName ||
    (c.igUsername ? `@${c.igUsername}` : null) ||
    c.igUserId ||
    'Клієнт'
  );
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
    return (letters[0][0] + letters[1][0]).toUpperCase().slice(0, 2);
  }
  if (letters.length === 1 && letters[0].length >= 2) {
    return letters[0].slice(0, 2).toUpperCase();
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

async function fetchConversations() {
  loading.value = true;
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
    conversations.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

watch([page, limit], () => {
  fetchConversations();
});

watch([stateFilter, search], () => {
  page.value = 1;
  fetchConversations();
});

const validStates = ['bot', 'handoff', 'closed', 'paused'] as const;

onMounted(() => {
  const q = route.query.state;
  if (typeof q === 'string' && (validStates as readonly string[]).includes(q)) {
    stateFilter.value = q;
  }
  fetchConversations();
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
</style>
