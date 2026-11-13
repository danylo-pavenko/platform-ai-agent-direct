<template>
  <v-card class="mb-4 settings-widget">
    <v-card-title class="d-flex align-center">
      <v-icon start>mdi-swap-horizontal</v-icon>
      Перехід на іншу salon CRM
    </v-card-title>
    <v-card-subtitle class="pb-2">
      Hard cutover (наприклад BeautyPro → Altegio): клієнти зіставляються за телефоном,
      старі id лишаються як legacy, нові записи йдуть у нову CRM. Історичні візити не
      дзеркаляться.
    </v-card-subtitle>
    <v-card-text>
      <v-row dense>
        <v-col cols="12" sm="6">
          <v-select
            v-model="fromProvider"
            :items="providerItems"
            label="З якої CRM"
            variant="outlined"
            density="comfortable"
            hide-details="auto"
          />
        </v-col>
        <v-col cols="12" sm="6">
          <v-select
            v-model="toProvider"
            :items="providerItems"
            label="На яку CRM"
            variant="outlined"
            density="comfortable"
            hide-details="auto"
          />
        </v-col>
      </v-row>

      <v-alert type="warning" variant="tonal" density="compact" class="mt-3 mb-3">
        Змінить маршрути services / branches / booking / client_upsert. KeyCRM catalog/order
        не чіпає. Потрібне підтвердження.
      </v-alert>

      <v-btn
        color="primary"
        size="large"
        class="tap-target"
        :loading="running"
        :disabled="fromProvider === toProvider"
        @click="runCutover"
      >
        <v-icon start>mdi-play</v-icon>
        Запустити cutover
      </v-btn>

      <v-alert v-if="error" type="error" variant="tonal" class="mt-3" density="compact">
        {{ error }}
      </v-alert>

      <div v-if="last" class="mt-4">
        <div class="text-subtitle-2 mb-2">Останній запуск</div>
        <div class="text-body-2">
          {{ last.fromProvider }} → {{ last.toProvider }} ·
          {{ last.status }} · {{ formatWhen(last.finishedAt) }}
        </div>
        <div class="text-body-2 mt-1">
          Клієнти: matched {{ last.clients.matched }} /
          total {{ last.clients.total }}; без телефону
          {{ last.clients.pendingNoPhone }}; не знайдено
          {{ last.clients.pendingNotFound }}; помилки
          {{ last.clients.errors }}.
        </div>
        <div class="text-body-2">
          Філії: +{{ last.branches.imported }} / ~{{ last.branches.updated }}. Офери слотів
          очищено: {{ last.bookingOffersCleared }}.
        </div>
        <div v-if="last.pendingClientIds?.length" class="text-caption text-medium-emphasis mt-1">
          Pending clients: {{ last.pendingClientIds.length }} (долінкувати в картці клієнта).
        </div>
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import api from '@/api';

type CutoverReport = {
  fromProvider: string;
  toProvider: string;
  finishedAt: string;
  status: string;
  clients: {
    total: number;
    matched: number;
    pendingNoPhone: number;
    pendingNotFound: number;
    errors: number;
  };
  branches: { imported: number; updated: number; skipped: number };
  bookingOffersCleared: number;
  pendingClientIds?: string[];
};

const providerItems = [
  { title: 'BeautyPro', value: 'beautypro' },
  { title: 'Altegio', value: 'altegio' },
  { title: 'CleverBOX', value: 'cleverbox' },
  { title: 'KeyCRM', value: 'keycrm' },
];

const fromProvider = ref('beautypro');
const toProvider = ref('altegio');
const running = ref(false);
const error = ref('');
const last = ref<CutoverReport | null>(null);

function formatWhen(iso: string) {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString('uk-UA');
}

async function loadLast() {
  try {
    const { data } = await api.get('/settings/crm/salon-cutover');
    last.value = data.last ?? null;
  } catch {
    last.value = null;
  }
}

async function runCutover() {
  error.value = '';
  if (
    !confirm(
      `Перейти з ${fromProvider.value} на ${toProvider.value}? Нові записи підуть у нову CRM; старі id лишаться legacy.`,
    )
  ) {
    return;
  }
  running.value = true;
  try {
    const { data } = await api.post('/settings/crm/salon-cutover', {
      fromProvider: fromProvider.value,
      toProvider: toProvider.value,
      confirm: true,
    });
    last.value = data.report ?? null;
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } } };
    error.value = err.response?.data?.error || 'Cutover не вдався';
    await loadLast();
  } finally {
    running.value = false;
  }
}

onMounted(() => {
  void loadLast();
});
</script>
