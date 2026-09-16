<template>
  <v-container fluid class="page-shell">
    <PageHeader title="Замовлення" />

    <v-card>
      <v-card-text>
        <v-row dense class="mb-3">
          <v-col cols="12" sm="4" md="3">
            <v-select
              v-model="statusFilter"
              :items="statusOptions"
              item-title="title"
              item-value="value"
              label="Статус"
              :density="density"
              variant="outlined"
              hide-details
            />
          </v-col>
          <v-col cols="12" sm="4" md="3" class="d-flex align-center">
            <v-checkbox
              v-model="includeArchived"
              label="Показати архівовані"
              :density="density"
              hide-details
            />
          </v-col>
        </v-row>

        <ResponsiveDataList
          :loading="loading"
          :empty="!loading && orders.length === 0"
          empty-text="Немає замовлень"
          :show-pagination="!mdAndUp && total > 0"
          :page="page"
          :items-per-page="limit"
          :items-length="total"
          @update:page="page = $event"
        >
          <template #table>
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
                    <OrderDetailPanel
                      :item="item"
                      :master-options="masterOptions"
                      :syncing-id="syncingId"
                      :saving-masters-id="savingMastersId"
                      :mobile="false"
                      @set-master="(i, v) => setServiceMaster(item, i, v)"
                      @save-masters="saveBookingMasters(item)"
                      @retry="retryCrmSync(item.id)"
                      @retry-force="retryCrmSyncForce(item)"
                    />
                  </td>
                </tr>
              </template>
            </v-data-table-server>
          </template>

          <template #cards>
            <MobileListCard
              v-for="item in orders"
              :key="item.id"
              @click="toggleExpanded(item.id)"
            >
              <template #title>
                {{ item.customerName || 'Клієнт' }}
                <span class="text-medium-emphasis font-weight-regular"> · {{ item.id?.substring(0, 8) }}</span>
              </template>
              <template #meta>
                {{ formatDate(item.createdAt) }}
                <span v-if="item.total"> · {{ item.total }} ₴</span>
                <span v-if="item.phone"> · {{ item.phone }}</span>
              </template>
              <template #chips>
                <v-chip v-if="item.isArchived" color="grey" size="small" label>Архів</v-chip>
                <v-chip :color="statusColor(item.status)" size="small" label>
                  {{ statusLabel(item.status) }}
                </v-chip>
                <v-chip :color="kindColor(item.kind)" size="small" variant="tonal" label>
                  {{ kindLabel(item.kind) }}
                </v-chip>
                <v-chip :color="crmStatusColor(item)" size="small" variant="tonal" label>
                  {{ crmStatusLabel(item) }}
                </v-chip>
              </template>
              <template #actions>
                <v-btn
                  v-if="item.conversationId"
                  size="small"
                  variant="tonal"
                  :to="`/conversations/${item.conversationId}`"
                  @click.stop
                >
                  Діалог
                </v-btn>
                <v-btn
                  v-if="canRetry(item)"
                  size="small"
                  variant="flat"
                  color="primary"
                  :loading="syncingId === item.id"
                  @click.stop="retryCrmSync(item.id)"
                >
                  Відвантажити в CRM
                </v-btn>
                <v-btn
                  v-if="canForceTimeConflict(item)"
                  size="small"
                  variant="tonal"
                  color="warning"
                  :loading="syncingId === item.id"
                  @click.stop="retryCrmSyncForce(item)"
                >
                  Force
                </v-btn>
                <v-btn
                  size="small"
                  variant="text"
                  :prepend-icon="expandedId === item.id ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                  @click.stop="toggleExpanded(item.id)"
                >
                  Деталі
                </v-btn>
              </template>
              <div v-if="expandedId === item.id" class="mt-2" @click.stop>
                <OrderDetailPanel
                  :item="item"
                  :master-options="masterOptions"
                  :syncing-id="syncingId"
                  :saving-masters-id="savingMastersId"
                  :mobile="true"
                  @set-master="(i, v) => setServiceMaster(item, i, v)"
                  @save-masters="saveBookingMasters(item)"
                  @retry="retryCrmSync(item.id)"
                  @retry-force="retryCrmSyncForce(item)"
                />
              </div>
            </MobileListCard>
          </template>
        </ResponsiveDataList>
      </v-card-text>
    </v-card>

    <v-snackbar v-model="snackbar" :color="snackbarColor" timeout="4000">
      {{ snackbarText }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useDisplay } from 'vuetify';
import api from '@/api';
import PageHeader from '@/components/PageHeader.vue';
import MobileListCard from '@/components/MobileListCard.vue';
import ResponsiveDataList from '@/components/ResponsiveDataList.vue';
import OrderDetailPanel from '@/components/OrderDetailPanel.vue';
import { useTouchDensity } from '@/composables/useTouchDensity';

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

const { mdAndUp } = useDisplay();
const { density } = useTouchDensity();

const orders = ref<Order[]>([]);
const total = ref(0);
const page = ref(1);
const limit = ref(20);
const loading = ref(false);
const statusFilter = ref('');
const includeArchived = ref(false);
const syncingId = ref<string | null>(null);
const savingMastersId = ref<string | null>(null);
const expandedId = ref<string | null>(null);
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

function toggleExpanded(id: string) {
  expandedId.value = expandedId.value === id ? null : id;
}

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
