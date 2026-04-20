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

          <template #item.total="{ item }">
            {{ item.total ? `${item.total} ₴` : '-' }}
          </template>

          <template #item.createdAt="{ item }">
            {{ formatDate(item.createdAt) }}
          </template>

          <template #expanded-row="{ columns, item }">
            <tr>
              <td :colspan="columns.length" class="pa-4">
                <v-row>
                  <!-- Order items -->
                  <v-col cols="12" md="7">
                    <h4 class="text-subtitle-2 mb-2">Товари</h4>
                    <v-table density="compact">
                      <thead>
                        <tr>
                          <th>Назва</th>
                          <th>Кількість</th>
                          <th>Ціна</th>
                          <th>Сума</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="(lineItem, i) in (item.items || [])" :key="i">
                          <td>{{ lineItem.name }}</td>
                          <td>{{ lineItem.quantity }}</td>
                          <td>{{ lineItem.price }} ₴</td>
                          <td>{{ (lineItem.price * lineItem.quantity) }} ₴</td>
                        </tr>
                        <tr v-if="!item.items?.length">
                          <td colspan="4" class="text-center text-grey">Немає товарів</td>
                        </tr>
                      </tbody>
                    </v-table>
                  </v-col>

                  <!-- Contact info -->
                  <v-col cols="12" md="5">
                    <h4 class="text-subtitle-2 mb-2">Контактна інформація</h4>
                    <v-list density="compact">
                      <v-list-item v-if="item.customerName">
                        <template #prepend>
                          <v-icon size="small">mdi-account</v-icon>
                        </template>
                        <v-list-item-title>{{ item.customerName }}</v-list-item-title>
                        <v-list-item-subtitle>Ім'я</v-list-item-subtitle>
                      </v-list-item>
                      <v-list-item v-if="item.customerPhone">
                        <template #prepend>
                          <v-icon size="small">mdi-phone</v-icon>
                        </template>
                        <v-list-item-title>{{ item.customerPhone }}</v-list-item-title>
                        <v-list-item-subtitle>Телефон</v-list-item-subtitle>
                      </v-list-item>
                      <v-list-item v-if="item.city">
                        <template #prepend>
                          <v-icon size="small">mdi-map-marker</v-icon>
                        </template>
                        <v-list-item-title>{{ item.city }}</v-list-item-title>
                        <v-list-item-subtitle>Місто</v-list-item-subtitle>
                      </v-list-item>
                      <v-list-item v-if="item.deliveryAddress">
                        <template #prepend>
                          <v-icon size="small">mdi-truck</v-icon>
                        </template>
                        <v-list-item-title>{{ item.deliveryAddress }}</v-list-item-title>
                        <v-list-item-subtitle>Адреса доставки</v-list-item-subtitle>
                      </v-list-item>
                      <v-list-item v-if="item.paymentMethod">
                        <template #prepend>
                          <v-icon size="small">mdi-credit-card</v-icon>
                        </template>
                        <v-list-item-title>{{ item.paymentMethod }}</v-list-item-title>
                        <v-list-item-subtitle>Спосіб оплати</v-list-item-subtitle>
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
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import api from '@/api';

interface OrderItem {
  name: string;
  quantity: number;
  price: number;
}

interface Order {
  id: string;
  client?: string;
  status: string;
  customerName?: string;
  customerPhone?: string;
  city?: string;
  deliveryAddress?: string;
  paymentMethod?: string;
  total?: number;
  items?: OrderItem[];
  createdAt: string;
}

const orders = ref<Order[]>([]);
const total = ref(0);
const page = ref(1);
const limit = ref(20);
const loading = ref(false);
const statusFilter = ref('');

const statusOptions = [
  { title: 'Всі', value: '' },
  { title: 'Чернетка', value: 'draft' },
  { title: 'Подано', value: 'submitted' },
  { title: 'Підтверджено', value: 'confirmed' },
  { title: 'Скасовано', value: 'cancelled' },
];

const headers = [
  { title: 'ID', key: 'id', sortable: false, width: '120px' },
  { title: 'Клієнт', key: 'client', sortable: false },
  { title: 'Статус', key: 'status', sortable: false, width: '140px' },
  { title: "Ім'я замовника", key: 'customerName', sortable: false },
  { title: 'Місто', key: 'city', sortable: false },
  { title: 'Сума', key: 'total', sortable: false, width: '120px' },
  { title: 'Дата', key: 'createdAt', sortable: false, width: '180px' },
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

function formatDate(dateStr: string): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('uk-UA');
}

async function fetchOrders() {
  loading.value = true;
  try {
    const params: Record<string, any> = {
      page: page.value,
      limit: limit.value,
    };
    if (statusFilter.value) params.status = statusFilter.value;

    const { data } = await api.get('/orders', { params });
    orders.value = data.data;
    total.value = data.total;
  } catch (e) {
    console.error('Failed to fetch orders', e);
  } finally {
    loading.value = false;
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
