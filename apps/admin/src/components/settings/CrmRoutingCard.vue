<template>
  <v-card id="settings-crm-routing" class="mb-4">
    <v-card-title class="d-flex align-center">
      <v-icon start color="indigo">mdi-routes</v-icon>
      Маршрутизація CRM
    </v-card-title>
    <v-card-subtitle class="pb-2">
      За замовчуванням можна працювати без CRM — замовлення, клієнти й записи лишаються в локальній базі.
      Підключіть інтеграцію й оберіть провайдера, або лишіть «Жодна».
    </v-card-subtitle>
    <v-card-text>
      <v-alert
        v-if="isLocalOnly"
        type="info"
        variant="tonal"
        density="compact"
        class="mb-4 text-body-2"
      >
        CRM не підключена: усі дії пишуться лише локально (замовлення, клієнти, записи в адмінці).
      </v-alert>

      <v-select
        v-model="routing.mode"
        :items="modeItems"
        label="Режим"
        item-title="title"
        item-value="value"
        class="mb-3"
      />

      <v-select
        v-model="routing.default"
        :items="targetItems"
        label="CRM за замовчуванням"
        item-title="title"
        item-value="value"
        class="mb-3"
        @update:model-value="onDefaultChange"
      />

      <div class="text-subtitle-2 mb-2">Увімкнені провайдери</div>
      <v-chip-group v-model="routing.enabled_providers" column multiple filter>
        <v-chip
          v-for="p in providerItems"
          :key="p.value"
          :value="p.value"
          filter
          variant="outlined"
        >
          {{ p.title }}
        </v-chip>
      </v-chip-group>
      <div class="text-caption text-medium-emphasis mb-2">
        Порожній список = лише локальна БД (навіть якщо вище обрано вендора).
      </div>

      <template v-if="routing.mode === 'by_action' || routing.mode === 'prompt'">
        <v-divider class="my-4" />
        <div class="text-subtitle-2 mb-2">Маршрути за дією</div>
        <v-table density="compact" class="crm-routes-table">
          <thead>
            <tr>
              <th>Дія</th>
              <th>CRM</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="action in actionRows" :key="action.key">
              <td>
                <div>{{ action.label }}</div>
                <div class="text-caption text-medium-emphasis">{{ action.hint }}</div>
              </td>
              <td style="max-width: 200px;">
                <v-select
                  v-model="routing.routes[action.key]"
                  :items="targetItems"
                  item-title="title"
                  item-value="value"
                  density="compact"
                  hide-details
                  variant="outlined"
                />
              </td>
            </tr>
          </tbody>
        </v-table>
      </template>

      <v-alert
        v-if="routing.mode === 'prompt'"
        type="info"
        variant="tonal"
        density="compact"
        class="mt-4 text-body-2"
      >
        У режимі <strong>prompt</strong> агент може передати <code>crm_provider</code> у booking-tools;
        якщо не передано — використовується маршрут з таблиці вище.
      </v-alert>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';

export type CrmProviderValue = 'keycrm' | 'cleverbox' | 'beautypro' | 'altegio';
export type CrmRouteTarget = CrmProviderValue | 'none';
export type CrmRoutingMode = 'single' | 'by_action' | 'prompt';

export interface CrmRoutingShape {
  mode: CrmRoutingMode;
  default: CrmRouteTarget;
  enabled_providers: CrmProviderValue[];
  routes: Record<string, CrmRouteTarget>;
}

const routing = defineModel<CrmRoutingShape>({ required: true });

const modeItems = [
  { title: 'Один CRM для всього', value: 'single' },
  { title: 'Різні CRM за дією (гібрид)', value: 'by_action' },
  { title: 'Агент обирає (prompt + fallback)', value: 'prompt' },
] as const;

const providerItems = [
  { title: 'KeyCRM', value: 'keycrm' },
  { title: 'CleverBOX', value: 'cleverbox' },
  { title: 'BeautyPro', value: 'beautypro' },
  { title: 'Altegio', value: 'altegio' },
] as const;

const targetItems = [
  { title: 'Жодна (лише локальна БД)', value: 'none' },
  ...providerItems,
] as const;

const actionRows = [
  { key: 'catalog', label: 'Каталог товарів', hint: 'search_products, sync products' },
  { key: 'services', label: 'Послуги', hint: 'search_services' },
  { key: 'branches', label: 'Філії', hint: 'імпорт локацій' },
  { key: 'booking', label: 'Запис', hint: 'book_appointment' },
  { key: 'order', label: 'Замовлення', hint: 'collect_order → CRM або локально' },
  { key: 'lead', label: 'Ліди', hint: 'leadgen brief' },
  { key: 'client_upsert', label: 'Клієнт CRM', hint: 'update_client_info mirror' },
] as const;

const isLocalOnly = computed(
  () =>
    routing.value.default === 'none' &&
    (!routing.value.enabled_providers || routing.value.enabled_providers.length === 0),
);

function onDefaultChange(value: CrmRouteTarget) {
  if (value === 'none') {
    routing.value.enabled_providers = [];
    for (const row of actionRows) {
      routing.value.routes[row.key] = 'none';
    }
    return;
  }
  if (!routing.value.enabled_providers.includes(value)) {
    routing.value.enabled_providers = [...routing.value.enabled_providers, value];
  }
  if (routing.value.mode === 'single') {
    for (const row of actionRows) {
      routing.value.routes[row.key] = value;
    }
  }
}
</script>

<style scoped>
.crm-routes-table :deep(td) {
  vertical-align: top;
  padding-top: 8px;
  padding-bottom: 8px;
}
</style>
