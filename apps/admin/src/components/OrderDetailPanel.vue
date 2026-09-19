<template>
  <div class="order-detail-panel">
    <h4 class="text-subtitle-2 mb-2">Товари</h4>
    <div v-if="item.items?.length" class="text-body-2 mb-3">
      <div v-for="(line, i) in item.items" :key="i" class="mb-1">
        {{ line.name }}{{ line.variant ? ` (${line.variant})` : '' }}
        × {{ line.qty ?? 1 }} — {{ line.price * (line.qty ?? 1) }} ₴
        <span class="text-medium-emphasis text-caption"> (каталог)</span>
      </div>
      <div class="mt-2">
        <strong>Озвучено клієнту:</strong>
        {{ displayQuoted }} ₴
        <span
          v-if="showCatalogDelta"
          class="text-medium-emphasis"
        >
          · каталог: {{ displayCatalog }} ₴
          <template v-if="deltaLabel"> ({{ deltaLabel }})</template>
        </span>
      </div>
    </div>
    <div v-else class="text-medium-emphasis text-body-2 mb-3">Немає товарів</div>

    <div v-if="item.note" class="mb-3 text-body-2">
      <strong>Нотатка:</strong> {{ item.note }}
    </div>

    <div
      v-if="item.kind === 'booking' && item.appointmentServices?.length && canRetry"
      class="mb-3"
    >
      <h4 class="text-subtitle-2 mb-2">Майстри на послуги</h4>
      <p class="text-caption text-medium-emphasis mb-2">
        Різні майстри в один час — оберіть людину на кожен рядок, збережіть, потім відвантажте в CRM.
      </p>
      <div
        v-for="(svc, i) in item.appointmentServices"
        :key="`${item.id}-${svc.id}-${i}`"
        class="mb-3"
        :class="mobile ? 'd-flex flex-column ga-2' : 'd-flex align-center ga-2 flex-wrap'"
      >
        <div class="text-body-2 flex-grow-1">{{ svc.name || 'Послуга' }}</div>
        <v-select
          :model-value="svc.masterId || null"
          :items="masterOptions"
          item-title="name"
          item-value="id"
          :density="mobile ? 'comfortable' : 'compact'"
          variant="outlined"
          hide-details
          label="Майстер"
          :style="mobile ? 'width: 100%' : 'max-width: 280px'"
          @update:model-value="(v: string) => $emit('set-master', i, v)"
        />
      </div>
      <v-btn
        :size="mobile ? 'default' : 'small'"
        variant="tonal"
        color="primary"
        :block="mobile"
        :class="{ 'tap-target': mobile }"
        :loading="savingMastersId === item.id"
        @click="$emit('save-masters')"
      >
        Зберегти майстрів
      </v-btn>
    </div>

    <h4 class="text-subtitle-2 mb-2">Контакт</h4>
    <div class="text-body-2 mb-3">
      <div>{{ item.customerName || '—' }} · {{ item.phone || '—' }}</div>
      <div class="text-medium-emphasis">{{ item.city || '—' }} · НП: {{ item.npBranch || '—' }}</div>
      <div class="text-medium-emphasis">Оплата: {{ paymentLabel }}</div>
    </div>

    <h4 class="text-subtitle-2 mb-2">{{ item.crmProviderLabel || 'CRM' }}</h4>
    <div class="text-body-2 mb-2">{{ crmStatusLabel }}</div>
    <div v-if="item.crmSyncError" class="text-error text-body-2 mb-2">{{ item.crmSyncError }}</div>

    <div :class="mobile ? 'd-flex flex-column ga-2' : 'd-flex flex-wrap ga-2'">
      <v-btn
        v-if="item.keycrmOrderUrl"
        :size="mobile ? 'default' : 'small'"
        variant="tonal"
        color="primary"
        :href="item.keycrmOrderUrl"
        target="_blank"
        rel="noopener noreferrer"
        :block="mobile"
      >
        Відкрити в KeyCRM
      </v-btn>
      <v-btn
        v-if="canRetry"
        :size="mobile ? 'default' : 'small'"
        variant="flat"
        color="primary"
        :loading="syncingId === item.id"
        :block="mobile"
        :class="{ 'tap-target': mobile }"
        @click="$emit('retry')"
      >
        Відвантажити в CRM
      </v-btn>
      <v-btn
        v-if="canForce"
        :size="mobile ? 'default' : 'small'"
        variant="tonal"
        color="warning"
        :loading="syncingId === item.id"
        :block="mobile"
        @click="$emit('retry-force')"
      >
        Все одно в CRM (force)
      </v-btn>
      <v-btn
        v-if="canCancel"
        :size="mobile ? 'default' : 'small'"
        variant="tonal"
        color="error"
        :loading="cancellingId === item.id"
        :block="mobile"
        :class="{ 'tap-target': mobile }"
        @click="$emit('cancel')"
      >
        {{ item.kind === 'booking' ? 'Скасувати запис' : 'Скасувати замовлення' }}
      </v-btn>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

export interface OrderDetailItem {
  id: string;
  kind?: string;
  status?: string;
  customerName: string;
  phone: string;
  city?: string | null;
  npBranch?: string | null;
  paymentMethod?: string | null;
  note?: string | null;
  total?: number;
  catalogTotal?: number;
  quotedTotal?: number | null;
  totalDelta?: number;
  items?: Array<{ name: string; variant?: string; qty: number; price: number }>;
  keycrmOrderId?: string | null;
  keycrmOrderUrl?: string | null;
  crmSyncStatus?: string;
  crmSyncError?: string | null;
  crmProvider?: string | null;
  crmProviderLabel?: string | null;
  crmRecordId?: string | null;
  appointmentServices?: Array<{
    id: string;
    name?: string;
    masterId?: string;
  }>;
  canRetryCrm?: boolean;
  canCancel?: boolean;
}

const props = defineProps<{
  item: OrderDetailItem;
  masterOptions: Array<{ id: string; name: string }>;
  syncingId?: string | null;
  cancellingId?: string | null;
  savingMastersId?: string | null;
  mobile?: boolean;
}>();

defineEmits<{
  'set-master': [index: number, masterId: string];
  'save-masters': [];
  retry: [];
  'retry-force': [];
  cancel: [];
}>();

const canRetry = computed(() => {
  if (typeof props.item.canRetryCrm === 'boolean') return props.item.canRetryCrm;
  return (
    !props.item.keycrmOrderId &&
    !props.item.crmRecordId &&
    props.item.crmSyncStatus !== 'synced'
  );
});

const canCancel = computed(() => {
  if (typeof props.item.canCancel === 'boolean') return props.item.canCancel;
  return props.item.status !== 'cancelled';
});

const canForce = computed(() => {
  if (props.item.kind !== 'booking' || !canRetry.value) return false;
  const err = (props.item.crmSyncError ?? '').toUpperCase();
  return err.includes('TIME_CONFLICT') || err.includes('TIME CONFLICT');
});

const paymentLabel = computed(() => {
  const method = props.item.paymentMethod;
  if (!method) return '—';
  const labels: Record<string, string> = {
    card: 'Картка',
    transfer: 'Переказ',
    cod: 'Накладений платіж',
  };
  return labels[method] || method;
});

const displayCatalog = computed(() => {
  if (typeof props.item.catalogTotal === 'number') return props.item.catalogTotal;
  const lines = props.item.items ?? [];
  return lines.reduce((sum, line) => sum + (line.price || 0) * (line.qty ?? 1), 0);
});

const displayQuoted = computed(() => {
  if (typeof props.item.quotedTotal === 'number') return props.item.quotedTotal;
  if (typeof props.item.total === 'number') return props.item.total;
  return displayCatalog.value;
});

const showCatalogDelta = computed(
  () => Math.abs(displayQuoted.value - displayCatalog.value) >= 0.01,
);

const deltaLabel = computed(() => {
  const d =
    typeof props.item.totalDelta === 'number'
      ? props.item.totalDelta
      : Math.round((displayQuoted.value - displayCatalog.value) * 100) / 100;
  if (Math.abs(d) < 0.01) return '';
  return d > 0 ? `+${d} ₴` : `${d} ₴`;
});

const crmStatusLabel = computed(() => {
  const item = props.item;
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
});
</script>
