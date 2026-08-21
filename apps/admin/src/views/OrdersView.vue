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
          <v-col cols="12" sm="4" md="3" class="d-flex align-center">
            <v-checkbox
              v-model="includeArchived"
              label="Показати архівовані"
              density="compact"
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
              v-if="item.isArchived"
              color="grey"
              size="small"
              label
              class="mr-1"
            >
              Архів
            </v-chip>
            <v-chip
              :color="statusColor(item.status)"
              size="small"
              label
            >
              {{ statusLabel(item.status) }}
            </v-chip>
          </template>

          <template #item.kind="{ item }">
            <v-chip
              :color="kindColor(item.kind)"
              size="small"
              variant="tonal"
              label
            >
              {{ kindLabel(item.kind) }}
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
              v-if="item.keycrmOrderUrl"
              size="small"
              variant="text"
              color="primary"
              :href="item.keycrmOrderUrl"
              target="_blank"
              rel="noopener noreferrer"
              @click.stop
            >
              KeyCRM
            </v-btn>
            <v-btn
              v-if="canRetry(item)"
              size="small"
              variant="text"
              color="primary"
              :loading="syncingId === item.id"
              @click.stop="retryCrmSync(item.id)"
            >
              Відвантажити
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

                    <div
                      v-if="item.kind === 'booking' && item.appointmentServices?.length && canRetry(item)"
                      class="mt-4"
                    >
                      <h4 class="text-subtitle-2 mb-2">Майстри на послуги</h4>
                      <p class="text-caption text-medium-emphasis mb-2">
                        Різні майстри в один час — оберіть людину на кожен рядок, збережіть, потім відвантажте в CRM.
                      </p>
                      <div
                        v-for="(svc, i) in item.appointmentServices"
                        :key="`${item.id}-${svc.id}-${i}`"
                        class="d-flex align-center ga-2 mb-2"
                      >
                        <div class="text-body-2 flex-grow-1">{{ svc.name || 'Послуга' }}</div>
                        <v-select
                          :model-value="svc.masterId || null"
                          :items="masterOptions"
                          item-title="name"
                          item-value="id"
                          density="compact"
                          variant="outlined"
                          hide-details
                          label="Майстер"
                          style="max-width: 280px"
                          @update:model-value="(v: string) => setServiceMaster(item, i, v)"
                        />
                      </div>
                      <v-btn
                        size="small"
                        variant="tonal"
                        color="primary"
                        :loading="savingMastersId === item.id"
                        @click="saveBookingMasters(item)"
                      >
                        Зберегти майстрів
                      </v-btn>
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

                    <h4 class="text-subtitle-2 mb-2 mt-4">{{ item.crmProviderLabel || 'CRM' }}</h4>
                    <v-list density="compact">
                      <v-list-item>
                        <v-list-item-title>
                          {{ crmStatusLabel(item) }}
                        </v-list-item-title>
                        <v-list-item-subtitle v-if="item.crmRecordId && !item.keycrmOrderId">
                          ID в CRM: {{ item.crmRecordId }}
                        </v-list-item-subtitle>
                        <v-list-item-subtitle v-if="item.crmSyncedAt">
                          Синхронізовано: {{ formatDate(item.crmSyncedAt) }}
                        </v-list-item-subtitle>
                        <v-list-item-subtitle v-if="item.crmSyncError" class="text-error">
                          {{ item.crmSyncError }}
                        </v-list-item-subtitle>
                        <v-list-item-subtitle v-else-if="canRetry(item) && item.kind === 'booking'">
                          Запис ще не відвантажено в CRM — можна спробувати ще раз
                        </v-list-item-subtitle>
                        <v-list-item-subtitle v-else-if="canRetry(item)">
                          Замовлення ще не відвантажено в CRM — можна спробувати ще раз
                        </v-list-item-subtitle>
                      </v-list-item>
                    </v-list>
                    <div class="d-flex flex-wrap ga-2 mt-2">
                      <v-btn
                        v-if="item.keycrmOrderUrl"
                        size="small"
                        variant="tonal"
                        color="primary"
                        :href="item.keycrmOrderUrl"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Відкрити в KeyCRM
                      </v-btn>
                      <v-btn
                        v-if="canRetry(item)"
                        size="small"
                        variant="flat"
                        color="primary"
                        :loading="syncingId === item.id"
                        @click="retryCrmSync(item.id)"
                      >
                        Відвантажити в CRM
                      </v-btn>
                      <v-btn
                        v-if="canForceTimeConflict(item)"
                        size="small"
                        variant="tonal"
                        color="warning"
                        :loading="syncingId === item.id"
                        @click="retryCrmSyncForce(item)"
                      >
                        Все одно в CRM (force)
                      </v-btn>
                    </div>
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

interface AppointmentServiceLine {
  id: string;
  name?: string;
  price?: number;
  durationMin: number;
  masterId?: string;
}

interface Order {
  id: string;
  client?: string;
  conversationId?: string;
  status: string;
  kind?: string;
  customerName: string;
  phone: string;
  city?: string | null;
  npBranch?: string | null;
  paymentMethod?: string | null;
  note?: string | null;
  total?: number;
  items?: OrderItem[];
  keycrmOrderId?: string | null;
  keycrmOrderUrl?: string | null;
  crmSyncStatus?: string;
  crmSyncError?: string | null;
  crmSyncedAt?: string | null;
  crmProvider?: string | null;
  crmProviderLabel?: string | null;
  crmRecordId?: string | null;
  appointmentId?: string | null;
  appointmentServices?: AppointmentServiceLine[];
  canRetryCrm?: boolean;
  isArchived?: boolean;
  archivedAt?: string | null;
  createdAt: string;
}

const orders = ref<Order[]>([]);
const total = ref(0);
const page = ref(1);
const limit = ref(20);
const loading = ref(false);
const statusFilter = ref('');
const includeArchived = ref(false);
const syncingId = ref<string | null>(null);
const savingMastersId = ref<string | null>(null);
const masterOptions = ref<Array<{ id: string; name: string }>>([]);
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
  { title: 'Тип', key: 'kind', sortable: false, width: '110px' },
  { title: 'Статус', key: 'status', sortable: false, width: '120px' },
  { title: 'CRM', key: 'crmSyncStatus', sortable: false, width: '120px' },
  { title: "Ім'я", key: 'customerName', sortable: false },
  { title: 'Місто', key: 'city', sortable: false },
  { title: 'Сума', key: 'total', sortable: false, width: '100px' },
  { title: 'Дата', key: 'createdAt', sortable: false, width: '160px' },
  { title: '', key: 'actions', sortable: false, width: '260px' },
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

function paymentLabel(method: string | null | undefined): string {
  if (!method) return '—';
  const labels: Record<string, string> = {
    card: 'Картка',
    transfer: 'Переказ',
    cod: 'Накладений платіж',
  };
  return labels[method] || method;
}

function kindLabel(kind: string | null | undefined): string {
  const labels: Record<string, string> = {
    product: 'Товар',
    service: 'Послуга',
    callback: 'Дзвінок',
    other: 'Інше',
    booking: 'Запис',
  };
  return labels[kind ?? 'product'] ?? kind ?? 'Товар';
}

function kindColor(kind: string | null | undefined): string {
  const colors: Record<string, string> = {
    product: 'primary',
    service: 'teal',
    callback: 'orange',
    other: 'grey',
    booking: 'pink-darken-2',
  };
  return colors[kind ?? 'product'] ?? 'grey';
}

function crmStatusLabel(item: Order): string {
  const provider = item.crmProviderLabel || 'CRM';
  if (item.crmRecordId && item.crmProvider === 'keycrm') {
    return `${provider} #${item.crmRecordId}`;
  }
  if (item.keycrmOrderId) return `KeyCRM #${item.keycrmOrderId}`;
  const labels: Record<string, string> = {
    pending: 'Очікує CRM',
    synced: `У ${provider}`,
    failed: 'Помилка CRM',
    skipped: 'Без CRM',
  };
  return labels[item.crmSyncStatus ?? ''] ?? item.crmSyncStatus ?? '—';
}

function crmStatusColor(item: Order): string {
  if (item.crmRecordId || item.keycrmOrderId || item.crmSyncStatus === 'synced') return 'success';
  if (item.crmSyncStatus === 'failed') return 'error';
  if (item.crmSyncStatus === 'pending') return 'warning';
  return 'grey';
}

function canRetry(item: Order): boolean {
  if (typeof item.canRetryCrm === 'boolean') return item.canRetryCrm;
  return !item.keycrmOrderId && !item.crmRecordId && item.crmSyncStatus !== 'synced';
}

/** BeautyPro TIME_CONFLICT on previous sync — admin may POST ?force=true. */
function canForceTimeConflict(item: Order): boolean {
  if (item.kind !== 'booking' || !canRetry(item)) return false;
  const err = (item.crmSyncError ?? '').toUpperCase();
  return err.includes('TIME_CONFLICT') || err.includes('TIME CONFLICT');
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
    if (includeArchived.value) params.includeArchived = 'true';

    const { data } = await api.get('/orders', { params });
    orders.value = Array.isArray(data?.data) ? data.data : [];
    total.value = data?.total ?? 0;
  } catch (e) {
    console.error('Failed to fetch orders', e);
  } finally {
    loading.value = false;
  }
}

function setServiceMaster(item: Order, index: number, masterId: string) {
  const lines = item.appointmentServices;
  if (!lines?.[index]) return;
  lines[index] = { ...lines[index]!, masterId };
}

async function saveBookingMasters(item: Order) {
  if (!item.appointmentServices?.length) return;
  savingMastersId.value = item.id;
  try {
    const payload = item.appointmentServices
      .map((svc, index) => ({
        index,
        serviceId: svc.id,
        masterId: svc.masterId,
      }))
      .filter((row) => Boolean(row.masterId));
    if (payload.length === 0) {
      snackbarText.value = 'Оберіть майстра хоча б на одну послугу';
      snackbarColor.value = 'error';
      snackbar.value = true;
      return;
    }
    await api.patch(`/orders/${item.id}/booking-services`, {
      services: payload,
    });
    snackbarText.value = 'Майстрів збережено. Можна відвантажити в CRM.';
    snackbarColor.value = 'success';
    snackbar.value = true;
    await fetchOrders();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } } };
    snackbarText.value = err.response?.data?.error ?? 'Не вдалося зберегти майстрів';
    snackbarColor.value = 'error';
    snackbar.value = true;
  } finally {
    savingMastersId.value = null;
  }
}

async function fetchBookingMasters() {
  try {
    const { data } = await api.get('/orders/booking-masters');
    masterOptions.value = Array.isArray(data?.data) ? data.data : [];
  } catch (e) {
    console.error('Failed to fetch booking masters', e);
  }
}

async function retryCrmSync(orderId: string, opts?: { forceTimeConflict?: boolean }) {
  syncingId.value = orderId;
  try {
    const { data } = await api.post(
      `/orders/${orderId}/sync-crm`,
      opts?.forceTimeConflict ? { forceTimeConflict: true } : {},
    );
    snackbarText.value = data?.message
      ?? (data?.crmRecordId
        ? `Синхронізовано: ${data.crmRecordId}`
        : 'Синхронізацію виконано');
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

async function retryCrmSyncForce(item: Order) {
  const ok = window.confirm(
    'Записати в BeautyPro з ігноруванням TIME_CONFLICT?\n\n'
      + 'Слот може перетинатися з іншим записом або виходити за графік майстра. '
      + 'Використовуйте лише якщо в CRM свідомо хочете force=true.',
  );
  if (!ok) return;
  await retryCrmSync(item.id, { forceTimeConflict: true });
}

watch([page, limit], () => {
  fetchOrders();
});

watch(statusFilter, () => {
  page.value = 1;
  fetchOrders();
});

watch(includeArchived, () => {
  page.value = 1;
  fetchOrders();
});

onMounted(() => {
  fetchOrders();
  fetchBookingMasters();
});
</script>
