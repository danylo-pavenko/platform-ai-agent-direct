<template>
  <v-container fluid>
    <v-row class="mb-4" align="center">
      <v-col>
        <div class="page-title">Розмови</div>
      </v-col>
    </v-row>

    <v-card>
      <v-card-text>
        <v-row dense class="mb-2">
          <v-col cols="12" sm="4" md="3">
            <v-select
              v-model="stateFilter"
              :items="stateOptions"
              item-title="title"
              item-value="value"
              label="Статус"
              density="compact"
              variant="outlined"
              hide-details
            />
          </v-col>
          <v-col cols="12" sm="8" md="5">
            <v-text-field
              v-model="search"
              label="Пошук"
              prepend-inner-icon="mdi-magnify"
              density="compact"
              variant="outlined"
              hide-details
              clearable
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
          @update:page="page = $event"
          @update:items-per-page="limit = $event"
          @click:row="(_: any, row: any) => goToConversation(row.item)"
          class="cursor-pointer"
        >
          <template #item.id="{ item }">
            <code>{{ item.id?.substring(0, 8) }}</code>
          </template>

          <template #item.client="{ item }">
            {{ item.client?.displayName || item.client?.igUserId || '—' }}
          </template>

          <template #item.state="{ item }">
            <v-chip
              :color="stateColor(item.state)"
              size="small"
              label
            >
              {{ item.state }}
            </v-chip>
          </template>

          <template #item.lastMessageAt="{ item }">
            {{ formatDate(item.lastMessageAt) }}
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
}

interface Conversation {
  id: string;
  client: Client;
  channel: string;
  state: string;
  lastMessageAt: string;
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
  { title: 'Всі', value: '' },
  { title: 'Бот', value: 'bot' },
  { title: 'Менеджер', value: 'handoff' },
  { title: 'Закрито', value: 'closed' },
];

const headers = [
  { title: 'ID', key: 'id', sortable: false, width: '120px' },
  { title: 'Клієнт', key: 'client', sortable: false },
  { title: 'Канал', key: 'channel', sortable: false, width: '120px' },
  { title: 'Статус', key: 'state', sortable: false, width: '130px' },
  { title: 'Останнє повідомлення', key: 'lastMessageAt', sortable: false, width: '200px' },
];

function stateColor(state: string): string {
  const colors: Record<string, string> = {
    bot: 'blue',
    handoff: 'orange',
    closed: 'grey',
    paused: 'purple',
  };
  return colors[state] || 'grey';
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('uk-UA');
}

function goToConversation(item: Conversation) {
  router.push({ name: 'conversation-detail', params: { id: item.id } });
}

async function fetchConversations() {
  loading.value = true;
  try {
    const params: Record<string, any> = {
      page: page.value,
      limit: limit.value,
    };
    if (stateFilter.value) params.state = stateFilter.value;
    if (search.value) params.search = search.value;

    const { data } = await api.get('/conversations', { params });
    conversations.value = data.data;
    total.value = data.total;
  } catch (e) {
    console.error('Failed to fetch conversations', e);
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
.cursor-pointer :deep(tbody tr) {
  cursor: pointer;
}
</style>
