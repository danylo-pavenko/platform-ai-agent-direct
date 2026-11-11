<template>
  <v-container fluid class="page-shell">
    <PageHeader
      title="Клієнти"
      subtitle="Картки людей, їхні діалоги та замовлення"
    />

    <v-card>
      <v-card-text>
        <v-text-field
          v-model="searchInput"
          label="Пошук"
          placeholder="Імʼя, телефон, @instagram або номер замовлення"
          prepend-inner-icon="mdi-magnify"
          :density="density"
          variant="outlined"
          hide-details
          clearable
          class="mb-4"
          @click:clear="searchInput = ''"
        />

        <v-alert v-if="loadError" type="error" variant="tonal" class="mb-4">
          {{ loadError }}
        </v-alert>

        <ResponsiveDataList
          :loading="loading"
          :empty="!loading && clients.length === 0"
          :empty-text="search ? 'Нікого не знайдено' : 'Клієнтів ще немає'"
          :show-pagination="!mdAndUp && total > 0"
          :page="page"
          :items-per-page="limit"
          :items-length="total"
          @update:page="page = $event"
        >
          <template #table>
            <v-data-table-server
              :headers="headers"
              :items="clients"
              :items-length="total"
              :items-per-page="limit"
              :page="page"
              :loading="loading"
              hover
              item-value="id"
              @update:page="page = $event"
              @update:items-per-page="limit = $event"
              @click:row="(_: unknown, row: { item: ClientRow }) => openClient(row.item.id)"
            >
              <template #item.name="{ item }">
                <div class="font-weight-medium">{{ primaryName(item) }}</div>
                <div v-if="profileTitle(item)" class="text-caption text-medium-emphasis">
                  {{ profileTitle(item) }}
                </div>
              </template>
              <template #item.contact="{ item }">
                <div>{{ item.phone || '—' }}</div>
                <div v-if="item.igUsername" class="text-caption text-medium-emphasis">
                  @{{ item.igUsername.replace(/^@/, '') }}
                </div>
              </template>
              <template #item.conversationCount="{ item }">
                {{ item.conversationCount }}
              </template>
              <template #item.orderCount="{ item }">
                {{ item.orderCount }}
              </template>
              <template #item.crm="{ item }">
                <v-chip
                  v-if="item.crmLinked"
                  size="small"
                  color="primary"
                  variant="tonal"
                  label
                >
                  {{ item.crmProvider || 'не привʼязано' }}
                </v-chip>
                <span v-else class="text-medium-emphasis">—</span>
              </template>
              <template #item.lastActivityAt="{ item }">
                {{ formatDate(item.lastActivityAt) }}
              </template>
            </v-data-table-server>
          </template>

          <template #cards>
            <MobileListCard
              v-for="item in clients"
              :key="item.id"
              :title="primaryName(item)"
              @click="openClient(item.id)"
            >
              <template #meta>
                <div>{{ item.phone || 'Телефон не вказано' }}</div>
                <div v-if="item.igUsername">@{{ item.igUsername.replace(/^@/, '') }}</div>
                <div class="mt-1">
                  {{ item.conversationCount }} діал. · {{ item.orderCount }} зам.
                  · {{ formatDate(item.lastActivityAt) }}
                </div>
              </template>
              <template #chips>
                <v-chip
                  v-if="item.crmLinked"
                  size="small"
                  color="primary"
                  variant="tonal"
                  label
                >
                  {{ item.crmProvider || 'не привʼязано' }}
                </v-chip>
              </template>
              <template #append>
                <v-icon icon="mdi-chevron-right" />
              </template>
            </MobileListCard>
          </template>
        </ResponsiveDataList>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useDisplay } from 'vuetify';
import { useRouter } from 'vue-router';
import api from '@/api';
import PageHeader from '@/components/PageHeader.vue';
import ResponsiveDataList from '@/components/ResponsiveDataList.vue';
import MobileListCard from '@/components/MobileListCard.vue';
import { useTouchDensity } from '@/composables/useTouchDensity';
import { adminClientPrimaryName, adminIgProfileTitle } from '@/lib/client-label';

type ClientRow = {
  id: string;
  displayName: string | null;
  igFullName: string | null;
  igUsername: string | null;
  phone: string | null;
  email: string | null;
  tags: string[];
  crmLinked: boolean;
  crmProvider: string | null;
  lastActivityAt: string;
  createdAt: string;
  conversationCount: number;
  orderCount: number;
};

const router = useRouter();
const { mdAndUp } = useDisplay();
const { density } = useTouchDensity();

const clients = ref<ClientRow[]>([]);
const total = ref(0);
const page = ref(1);
const limit = ref(20);
const loading = ref(false);
const loadError = ref('');
const searchInput = ref('');
const search = ref('');
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const headers = [
  { title: "Ім'я", key: 'name', sortable: false },
  { title: 'Контакт', key: 'contact', sortable: false },
  { title: 'Діалоги', key: 'conversationCount', sortable: false, width: '110px' },
  { title: 'Замовлення', key: 'orderCount', sortable: false, width: '120px' },
  { title: 'CRM', key: 'crm', sortable: false, width: '120px' },
  { title: 'Активність', key: 'lastActivityAt', sortable: false, width: '180px' },
];

function primaryName(item: ClientRow): string {
  return adminClientPrimaryName(item);
}

function profileTitle(item: ClientRow): string | null {
  return adminIgProfileTitle(item);
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('uk-UA');
}

function openClient(id: string) {
  void router.push({ name: 'client-detail', params: { id } });
}

async function fetchClients() {
  loading.value = true;
  loadError.value = '';
  try {
    const { data } = await api.get('/clients', {
      params: {
        page: page.value,
        limit: limit.value,
        search: search.value || undefined,
      },
    });
    clients.value = data.data ?? [];
    total.value = data.total ?? 0;
  } catch {
    clients.value = [];
    total.value = 0;
    loadError.value = 'Не вдалося завантажити клієнтів';
  } finally {
    loading.value = false;
  }
}

watch(searchInput, (value) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    search.value = (value ?? '').trim();
    page.value = 1;
  }, 300);
});

watch([page, limit, search], () => {
  void fetchClients();
}, { immediate: true });

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
});
</script>
