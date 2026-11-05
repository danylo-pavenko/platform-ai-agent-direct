<template>
  <v-container fluid class="page-shell">
    <div class="d-flex align-center ga-2 mb-4">
      <v-btn
        icon
        variant="text"
        class="tap-target"
        aria-label="До списку клієнтів"
        :to="{ name: 'clients' }"
      >
        <v-icon>mdi-arrow-left</v-icon>
      </v-btn>
      <div class="min-width-0">
        <h1 class="text-h6 text-md-h5 mb-0">{{ title }}</h1>
        <div v-if="subtitle" class="text-body-2 text-medium-emphasis text-truncate">
          {{ subtitle }}
        </div>
      </div>
    </div>

    <div v-if="loading" class="d-flex justify-center py-10">
      <v-progress-circular indeterminate color="primary" />
    </div>

    <v-alert v-else-if="error" type="error" variant="tonal">
      {{ error }}
    </v-alert>

    <template v-else-if="payload">
      <v-row class="mb-2">
        <v-col cols="6" sm="3">
          <v-card variant="tonal" class="pa-3">
            <div class="text-caption text-medium-emphasis">Діалоги</div>
            <div class="text-h6">{{ payload.insights.conversationCount }}</div>
            <div class="text-caption">відкритих {{ payload.insights.openConversationCount }}</div>
          </v-card>
        </v-col>
        <v-col cols="6" sm="3">
          <v-card variant="tonal" class="pa-3">
            <div class="text-caption text-medium-emphasis">Замовлення</div>
            <div class="text-h6">{{ payload.insights.orderCount }}</div>
            <div class="text-caption">підтверджених {{ payload.insights.confirmedOrderCount }}</div>
          </v-card>
        </v-col>
        <v-col cols="6" sm="3">
          <v-card variant="tonal" class="pa-3">
            <div class="text-caption text-medium-emphasis">Записи</div>
            <div class="text-h6">{{ payload.insights.appointmentCount }}</div>
            <div class="text-caption">історія нижче</div>
          </v-card>
        </v-col>
        <v-col cols="6" sm="3">
          <v-card variant="tonal" class="pa-3">
            <div class="text-caption text-medium-emphasis">CRM</div>
            <div class="text-h6">{{ payload.insights.crmLinked ? 'Так' : 'Ні' }}</div>
            <div class="text-caption">{{ payload.client.crmProvider || 'не привʼязано' }}</div>
          </v-card>
        </v-col>
      </v-row>

      <v-card class="mb-4">
        <v-card-text>
          <div class="text-subtitle-2 mb-2">Картка</div>
          <div class="text-body-2">Телефон: {{ payload.client.phone || '—' }}</div>
          <div class="text-body-2">Email: {{ payload.client.email || '—' }}</div>
          <div class="text-body-2">
            Instagram:
            {{ payload.client.igUsername ? `@${payload.client.igUsername.replace(/^@/, '')}` : '—' }}
          </div>
          <div class="text-body-2">Остання активність: {{ formatDate(payload.client.lastActivityAt) }}</div>
          <div v-if="payload.client.tags.length" class="d-flex flex-wrap ga-1 mt-2">
            <v-chip
              v-for="tag in payload.client.tags"
              :key="tag"
              size="small"
              label
            >
              {{ tag }}
            </v-chip>
          </div>
          <div v-if="payload.client.notes" class="text-body-2 mt-2">
            {{ payload.client.notes }}
          </div>
        </v-card-text>
      </v-card>

      <div class="text-subtitle-1 mb-2">Діалоги</div>
      <v-card class="mb-4">
        <v-card-text>
          <div v-if="payload.conversations.length === 0" class="text-medium-emphasis text-body-2">
            Діалогів немає
          </div>
          <div
            v-else-if="payload.insights.conversationCount > payload.conversations.length"
            class="text-caption text-medium-emphasis mb-2"
          >
            Останні {{ payload.conversations.length }} з {{ payload.insights.conversationCount }}
          </div>
          <MobileListCard
            v-for="row in payload.conversations"
            :key="row.id"
            :title="stateLabel(row.state)"
            :meta="`${row.messageCount} повід. · ${formatDate(row.lastMessageAt || row.createdAt)}`"
            @click="openConversation(row.id)"
          >
            <template #append>
              <v-icon icon="mdi-chevron-right" />
            </template>
          </MobileListCard>
        </v-card-text>
      </v-card>

      <div class="text-subtitle-1 mb-2">Замовлення</div>
      <v-card class="mb-4">
        <v-card-text>
          <div v-if="payload.orders.length === 0" class="text-medium-emphasis text-body-2">
            Замовлень немає
          </div>
          <div
            v-else-if="payload.insights.orderCount > payload.orders.length"
            class="text-caption text-medium-emphasis mb-2"
          >
            Останні {{ payload.orders.length }} з {{ payload.insights.orderCount }}
          </div>
          <MobileListCard
            v-for="row in payload.orders"
            :key="row.id"
            :title="`${kindLabel(row.kind)} · ${statusLabel(row.status)}`"
            :meta="`${shortId(row.id)} · ${money(row.quotedTotal)} · ${formatDate(row.createdAt)}`"
            @click="openConversation(row.conversationId)"
          >
            <template #chips>
              <v-chip v-if="row.isArchived" size="small" label>Архів</v-chip>
              <v-chip size="small" variant="tonal" label>{{ row.crmSyncStatus }}</v-chip>
            </template>
          </MobileListCard>
        </v-card-text>
      </v-card>

      <div class="text-subtitle-1 mb-2">Останні записи</div>
      <v-card>
        <v-card-text>
          <div v-if="payload.appointments.length === 0" class="text-medium-emphasis text-body-2">
            Записів немає
          </div>
          <div
            v-for="row in payload.appointments"
            :key="row.id"
            class="py-2"
          >
            <div class="text-body-2 font-weight-medium">
              {{ row.scheduledDate }} {{ row.scheduledTime }}
            </div>
            <div class="text-caption text-medium-emphasis">
              {{ row.servicesLabel || 'Послуга не вказана' }} · {{ row.status }}
            </div>
          </div>
        </v-card-text>
      </v-card>
    </template>
  </v-container>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import api from '@/api';
import MobileListCard from '@/components/MobileListCard.vue';
import { adminClientPrimaryName, adminIgProfileTitle } from '@/lib/client-label';

const props = defineProps<{ id: string }>();
const router = useRouter();

type Payload = {
  client: {
    id: string;
    displayName: string | null;
    igFullName: string | null;
    igUsername: string | null;
    phone: string | null;
    email: string | null;
    notes: string | null;
    tags: string[];
    crmProvider: string | null;
    lastActivityAt: string;
  };
  insights: {
    conversationCount: number;
    openConversationCount: number;
    orderCount: number;
    confirmedOrderCount: number;
    appointmentCount: number;
    crmLinked: boolean;
  };
  conversations: Array<{
    id: string;
    state: string;
    lastMessageAt: string | null;
    createdAt: string;
    messageCount: number;
  }>;
  orders: Array<{
    id: string;
    kind: string;
    status: string;
    quotedTotal: number | null;
    createdAt: string;
    conversationId: string;
    crmSyncStatus: string;
    isArchived: boolean;
  }>;
  appointments: Array<{
    id: string;
    status: string;
    scheduledDate: string;
    scheduledTime: string;
    servicesLabel: string;
  }>;
};

const payload = ref<Payload | null>(null);
const loading = ref(true);
const error = ref('');

const title = computed(() => adminClientPrimaryName(payload.value?.client));
const subtitle = computed(() => adminIgProfileTitle(payload.value?.client));

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('uk-UA');
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function money(value: number | null): string {
  return value == null ? '—' : `${value} ₴`;
}

function stateLabel(state: string): string {
  const labels: Record<string, string> = {
    bot: 'Бот',
    handoff: 'Менеджер',
    paused: 'Пауза',
    closed: 'Закрито',
  };
  return labels[state] || state;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: 'Чернетка',
    submitted: 'Подано',
    confirmed: 'Підтверджено',
    cancelled: 'Скасовано',
  };
  return labels[status] || status;
}

function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    product: 'Товар',
    service: 'Послуга',
    callback: 'Дзвінок',
    other: 'Інше',
    booking: 'Запис',
  };
  return labels[kind] || kind;
}

function openConversation(id: string) {
  void router.push({ name: 'conversation-detail', params: { id } });
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get(`/clients/${props.id}`);
    payload.value = data;
  } catch {
    payload.value = null;
    error.value = 'Не вдалося відкрити картку клієнта';
  } finally {
    loading.value = false;
  }
}

watch(() => props.id, () => {
  void load();
}, { immediate: true });
</script>
