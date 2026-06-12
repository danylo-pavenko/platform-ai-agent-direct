<template>
  <v-container fluid>
    <v-row class="mb-4" align="center">
      <v-col>
        <div class="page-title">Замовлення</div>
      </v-col>
    </v-row>

    <v-card>
      <v-card-text>
        <v-row dense class="mb-2">
          <v-col cols="12" sm="4" md="3">
            <v-select
              v-model="statusFilter"
              :items="statusOptions"
              item-title="title"
              item-value="value"
              label="Статус"
              density="compact"
              variant="outlined"
              hide-details
            />
          </v-col>
        </v-row>

        <v-data-table-server
          :headers="headers"
          :items="orders"
          :items-length="total"
          :items-per-page="limit"
          :page="page"
          :loading="loading"
          hover
          item-value="id"
          show-expand
          @update:page="page = $event"
          @update:items-per-page="limit = $event"
        >
          <template #item.id="{ item }">
            <code>{{ item.id?.substring(0, 8) }}</code>
          </template>

          <template #item.status="{ item }">
            <v-chip
              :color="statusColor(item.status)"
              size="small"
              label
            >
              {{ statusLabel(item.status) }}
            </v-chip>
          </template>

          <template #item.crmSyncStatus="{ item }">
            <v-chip
              :color="crmStatusColor(item)"
              size="small"
              variant="tonal"
              label
            >
              {{ crmStatusLabel(item) }}
            </v-chip>
          </template>

          <template #item.total="{ item }">
            {{ item.total ? `${item.total} ₴` : '—' }}
          </template>

          <template #item.createdAt="{ item }">
            {{ formatDate(item.createdAt) }}
          </template>

          <template #item.actions="{ item }">
            <v-btn
              v-if="canRetryCrm(item)"
              size="small"
              variant="text"
              color="primary"
              :loading="syncingId === item.id"
              @click.stop="retryCrmSync(item.id)"
            >
              CRM
            </v-btn>
            <v-btn
              v-if="item.conversationId"
              size="small"
              variant="text"
              :to="`/conversations/${item.conversationId}`"
              @click.stop
            >
              Діалог
            </v-btn>
          </template>

          <template #expanded-row="{ columns, item }">
            <tr>
              <td :colspan="columns.length" class="pa-4">
                <v-row>
                  <v-col cols="12" md="7">
                    <h4 class="text-subtitle-2 mb-2">Товари</h4>
                    <v-table density="compact">
                      <thead>
                        <tr>
                          <th>Назва</th>
                          <th>Варіант</th>
                          <th>Кількість</th>
                          <th>Ціна</th>
                          <th>Сума</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="(lineItem, i) in (item.items || [])" :key="i">
                          <td>{{ lineItem.name }}</td>
                          <td>{{ lineItem.variant || '—' }}</td>
                          <td>{{ lineItem.qty ?? 1 }}</td>
                          <td>{{ lineItem.price }} ₴</td>
                          <td>{{ (lineItem.price * (lineItem.qty ?? 1)) }} ₴</td>
                        </tr>
                        <tr v-if="!item.items?.length">
                          <td colspan="5" class="text-center text-grey">Немає товарів</td>
                        </tr>
                      </tbody>
                    </v-table>

                    <div v-if="item.note" class="mt-3 text-body-2">
                      <strong>Нотатка:</strong> {{ item.note }}
                    </div>
                  </v-col>

                  <v-col cols="12" md="5">
                    <h4 class="text-subtitle-2 mb-2">Контактна інформація</h4>
                    <v-list density="compact">
                      <v-list-item>
                        <template #prepend>
                          <v-icon size="small">mdi-account</v-icon>
                        </template>
                        <v-list-item-title>{{ item.customerName || '—' }}</v-list-item-title>
                        <v-list-item-subtitle>Ім'я</v-list-item-subtitle>
                      </v-list-item>
                      <v-list-item>
                        <template #prepend>
                          <v-icon size="small">mdi-phone</v-icon>
                        </template>
                        <v-list-item-title>{{ item.phone || '—' }}</v-list-item-title>
                        <v-list-item-subtitle>Телефон</v-list-item-subtitle>
                      </v-list-item>
                      <v-list-item>
                        <template #prepend>
                          <v-icon size="small">mdi-map-marker</v-icon>
                        </template>
                        <v-list-item-title>{{ item.city || '—' }}</v-list-item-title>
                        <v-list-item-subtitle>Місто</v-list-item-subtitle>
                      </v-list-item>
                      <v-list-item>
                        <template #prepend>
                          <v-icon size="small">mdi-truck</v-icon>
                        </template>
                        <v-list-item-title>{{ item.npBranch || '—' }}</v-list-item-title>
                        <v-list-item-subtitle>Відділення НП</v-list-item-subtitle>
                      </v-list-item>
                      <v-list-item>
                        <template #prepend>
                          <v-icon size="small">mdi-credit-card</v-icon>
                        </template>
                        <v-list-item-title>{{ paymentLabel(item.paymentMethod) }}</v-list-item-title>
                        <v-list-item-subtitle>Спосіб оплати</v-list-item-subtitle>
                      </v-list-item>
                    </v-list>

                    <h4 class="text-subtitle-2 mb-2 mt-4">KeyCRM</h4>
                    <v-list density="compact">
                      <v-list-item>
                        <v-list-item-title>
                          <template v-if="item.keycrmOrderId">
                            Замовлення #{{ item.keycrmOrderId }}
                          </template>
                          <template v-else>
                            {{ crmStatusLabel(item) }}
                          </template>
                        </v-list-item-title>
                        <v-list-item-subtitle v-if="item.crmSyncedAt">
                          Синхронізовано: {{ formatDate(item.crmSyncedAt) }}
                        </v-list-item-subtitle>
                        <v-list-item-subtitle v-if="item.crmSyncError" class="text-error">
                          {{ item.crmSyncError }}
                        </v-list-item-subtitle>
                      </v-list-item>
                    </v-list>
                  </v-col>
                </v-row>
              </td>
            </tr>
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <v-snackbar v-model="snackbar" :color="snackbarColor" timeout="4000">
      {{ snackbarText }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import api from '@/api';

interface OrderItem {
  name: string;
  variant?: string;
  qty: number;
  price: number;
}

interface Order {
  id: string;
  client?: string;
  conversationId?: string;
  status: string;
  customerName: string;
  phone: string;
  city: string;
  npBranch: string;
  paymentMethod: string;
  note?: string | null;
  total?: number;
  items?: OrderItem[];
  keycrmOrderId?: string | null;
  crmSyncStatus?: string;
  crmSyncError?: string | null;
  crmSyncedAt?: string | null;
  createdAt: string;
}

const orders = ref<Order[]>([]);
const total = ref(0);
const page = ref(1);
const limit = ref(20);
const loading = ref(false);
const statusFilter = ref('');
const syncingId = ref<string | null>(null);
const snackbar = ref(false);
const snackbarText = ref('');
const snackbarColor = ref<'success' | 'error'>('success');

const statusOptions = [
  { title: 'Всі', value: '' },
  { title: 'Чернетка', value: 'draft' },
  { title: 'Подано', value: 'submitted' },
  { title: 'Підтверджено', value: 'confirmed' },
  { title: 'Скасовано', value: 'cancelled' },
];

const headers = [
  { title: 'ID', key: 'id', sortable: false, width: '100px' },
  { title: 'Клієнт', key: 'client', sortable: false },
  { title: 'Статус', key: 'status', sortable: false, width: '120px' },
  { title: 'CRM', key: 'crmSyncStatus', sortable: false, width: '120px' },
  { title: "Ім'я", key: 'customerName', sortable: false },
  { title: 'Місто', key: 'city', sortable: false },
  { title: 'Сума', key: 'total', sortable: false, width: '100px' },
  { title: 'Дата', key: 'createdAt', sortable: false, width: '160px' },
  { title: '', key: 'actions', sortable: false, width: '140px' },
];

function statusColor(status: string): string {
  const colors: Record<string, string> = {
    draft: 'grey',
    submitted: 'blue',
    confirmed: 'green',
    cancelled: 'red',
  };
  return colors[status] || 'grey';
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

function paymentLabel(method: string): string {
  const labels: Record<string, string> = {
    card: 'Картка',
    transfer: 'Переказ',
    cod: 'Накладений платіж',
  };
  return labels[method] || method;
}

function crmStatusLabel(item: Order): string {
  if (item.keycrmOrderId) return `KeyCRM #${item.keycrmOrderId}`;
  const labels: Record<string, string> = {
    pending: 'Очікує CRM',
    synced: 'У CRM',
    failed: 'Помилка CRM',
    skipped: 'Без CRM',
  };
  return labels[item.crmSyncStatus ?? ''] ?? item.crmSyncStatus ?? '—';
}

function crmStatusColor(item: Order): string {
  if (item.keycrmOrderId || item.crmSyncStatus === 'synced') return 'success';
  if (item.crmSyncStatus === 'failed') return 'error';
  if (item.crmSyncStatus === 'pending') return 'warning';
  return 'grey';
}

function canRetryCrm(item: Order): boolean {
  return !item.keycrmOrderId && item.crmSyncStatus !== 'skipped';
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('uk-UA');
}

async function fetchOrders() {
  loading.value = true;
  try {
    const params: Record<string, string | number> = {
      page: page.value,
      limit: limit.value,
    };
    if (statusFilter.value) params.status = statusFilter.value;

    const { data } = await api.get('/orders', { params });
    orders.value = Array.isArray(data?.data) ? data.data : [];
    total.value = data?.total ?? 0;
  } catch (e) {
    console.error('Failed to fetch orders', e);
  } finally {
    loading.value = false;
  }
}

async function retryCrmSync(orderId: string) {
  syncingId.value = orderId;
  try {
    const { data } = await api.post(`/orders/${orderId}/sync-crm`);
    snackbarText.value = data?.keycrmOrderId
      ? `Синхронізовано: KeyCRM #${data.keycrmOrderId}`
      : 'Синхронізацію виконано';
    snackbarColor.value = 'success';
    snackbar.value = true;
    await fetchOrders();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } } };
    snackbarText.value = err.response?.data?.error ?? 'Не вдалося синхронізувати з CRM';
    snackbarColor.value = 'error';
    snackbar.value = true;
  } finally {
    syncingId.value = null;
  }
}

watch([page, limit], () => {
  fetchOrders();
});

watch(statusFilter, () => {
  page.value = 1;
  fetchOrders();
});

onMounted(() => {
  fetchOrders();
});
</script>
