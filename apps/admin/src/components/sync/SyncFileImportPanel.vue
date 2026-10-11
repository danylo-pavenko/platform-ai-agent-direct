<template>
  <v-card>
    <v-card-title class="d-flex flex-wrap align-center ga-2 py-3">
      <span>Імпорт каталогу</span>
      <v-chip v-if="manualMeta.productCount > 0" size="small" variant="tonal">
        {{ manualMeta.productCount }} товарів
      </v-chip>
      <v-spacer />
      <span
        v-if="manualMeta.settings?.lastImportAt"
        class="text-caption text-medium-emphasis font-weight-regular"
      >
        Імпорт · {{ formatDate(manualMeta.settings.lastImportAt) }}
      </span>
    </v-card-title>
    <v-card-subtitle class="pb-2">
      CSV з Shop-Express (Engine): парсер кодом → перевірка Claude → підтвердження. Агент шукає
      товари за пріоритетом нижче.
    </v-card-subtitle>

    <v-card-text>
      <v-row dense>
        <v-col cols="12" md="4">
          <v-select
            :model-value="importSource"
            :items="importSourceItems"
            label="Джерело файлу"
            :density="density"
            variant="outlined"
            hide-details
            @update:model-value="$emit('update:importSource', $event)"
          />
        </v-col>
        <v-col cols="12" md="8" class="d-flex flex-wrap align-center ga-2">
          <v-btn
            color="primary"
            class="tap-target"
            :block="mobile"
            prepend-icon="mdi-upload"
            :loading="importing"
            @click="fileInput?.click()"
          >
            Завантажити CSV
          </v-btn>
          <input
            ref="fileInput"
            type="file"
            accept=".csv,text/csv"
            class="d-none"
            @change="$emit('csv-selected', $event)"
          />
          <v-btn
            v-if="manualMeta.productCount > 0"
            variant="tonal"
            color="error"
            class="tap-target"
            :block="mobile"
            :loading="clearingManual"
            prepend-icon="mdi-delete-outline"
            @click="$emit('clear')"
          >
            Очистити файловий каталог
          </v-btn>
        </v-col>
      </v-row>

      <v-alert v-if="importError" type="error" density="compact" class="mt-3" closable>
        {{ importError }}
      </v-alert>
      <v-alert v-if="importSuccess" type="success" density="compact" class="mt-3" closable>
        {{ importSuccess }}
      </v-alert>

      <div class="mt-4">
        <div class="text-subtitle-2 mb-2">Пріоритет пошуку агента</div>
        <v-radio-group
          :model-value="priorityDraft"
          :density="density"
          hide-details
          :inline="!mobile"
          :disabled="savingPriority"
          @update:model-value="$emit('save-priority', $event)"
        >
          <v-radio label="Файл" value="file" />
          <v-radio
            label="CRM"
            value="crm"
            :disabled="!manualMeta.crmCatalogAvailable"
          />
        </v-radio-group>
        <div class="text-caption text-medium-emphasis mt-1">
          Зараз ефективно:
          <strong>{{ manualMeta.effectiveSource === 'crm' ? 'CRM' : 'файл' }}</strong>
          <span v-if="!manualMeta.crmCatalogAvailable">
            · CRM каталог недоступний — лише файл
          </span>
        </div>
      </div>

      <div class="mt-4">
        <div class="text-subtitle-2 mb-2">Ціна для агента (коли товар зматчений)</div>
        <v-radio-group
          :model-value="pricePrefDraft"
          :density="density"
          hide-details
          :inline="!mobile"
          :disabled="savingPriority"
          @update:model-value="$emit('save-price-preference', $event)"
        >
          <v-radio label="Файл" value="file" />
          <v-radio
            label="CRM"
            value="crm"
            :disabled="!manualMeta.crmCatalogAvailable"
          />
        </v-radio-group>
      </div>

      <div v-if="importPreview" class="mt-4">
        <div class="text-subtitle-2 mb-1">Preview імпорту</div>
        <div class="text-body-2 mb-2">
          Рядків: {{ importPreview.stats.rowCount }}, товарів:
          {{ importPreview.stats.productCount }}, варіантів:
          {{ importPreview.stats.offerCount }}, ціни:
          {{ importPreview.stats.priceMin ?? '—' }}–{{ importPreview.stats.priceMax ?? '—' }} ₴
        </div>
        <v-alert
          :type="importPreview.verify.ok ? 'info' : 'warning'"
          density="compact"
          class="mb-3"
          variant="tonal"
        >
          <div class="font-weight-medium">Claude verify</div>
          <div>{{ importPreview.verify.summaryUk }}</div>
          <ul v-if="importPreview.verify.issues?.length" class="mt-1 mb-0 pl-4">
            <li v-for="(issue, idx) in importPreview.verify.issues" :key="idx">
              [{{ issue.severity }}] {{ issue.message }}
            </li>
          </ul>
        </v-alert>

        <ResponsiveDataList
          class="mb-3"
          :empty="!importPreview.sampleProducts.length"
          empty-text="Немає sample товарів"
        >
          <template #cards>
            <MobileListCard
              v-for="p in importPreview.sampleProducts"
              :key="p.id"
              :title="p.name"
              :meta="formatManualPrice(p.minPrice, p.maxPrice)"
            />
          </template>
          <template #table>
            <v-data-table
              :headers="manualPreviewHeaders"
              :items="importPreview.sampleProducts"
              density="compact"
              :items-per-page="10"
              class="mb-3"
            />
          </template>
        </ResponsiveDataList>

        <div class="d-flex flex-column flex-sm-row flex-wrap ga-2">
          <v-btn
            color="primary"
            class="tap-target"
            :block="mobile"
            :loading="confirmingImport"
            :disabled="!importPreview.verify.ok && !forceImport"
            @click="$emit('confirm-import', false)"
          >
            Застосувати каталог
          </v-btn>
          <v-btn
            v-if="!importPreview.verify.ok"
            variant="tonal"
            color="warning"
            class="tap-target"
            :block="mobile"
            :loading="confirmingImport"
            @click="$emit('confirm-import', true)"
          >
            Застосувати з force
          </v-btn>
          <v-checkbox
            v-if="!importPreview.verify.ok"
            :model-value="forceImport"
            :density="density"
            hide-details
            label="Дозволити confirm без ok verify"
            @update:model-value="$emit('update:forceImport', Boolean($event))"
          />
        </div>
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import MobileListCard from '@/components/MobileListCard.vue';
import ResponsiveDataList from '@/components/ResponsiveDataList.vue';
import { useTouchDensity } from '@/composables/useTouchDensity';
import type { ImportPreview } from '@/composables/useCatalogManual';
import { formatDate, formatManualPrice } from '@/components/sync/sync-labels';

defineProps<{
  manualMeta: {
    settings: { lastImportAt: string | null } | null;
    crmCatalogAvailable: boolean;
    effectiveSource: 'file' | 'crm';
    productCount: number;
  };
  importSource: string;
  importSourceItems: Array<{ title: string; value: string }>;
  importing: boolean;
  clearingManual: boolean;
  savingPriority: boolean;
  importError: string;
  importSuccess: string;
  forceImport: boolean;
  importPreview: ImportPreview | null;
  confirmingImport: boolean;
  priorityDraft: 'file' | 'crm';
  pricePrefDraft: 'file' | 'crm';
}>();

defineEmits<{
  'update:importSource': [value: string];
  'update:forceImport': [value: boolean];
  'csv-selected': [event: Event];
  clear: [];
  'save-priority': [value: unknown];
  'save-price-preference': [value: unknown];
  'confirm-import': [force: boolean];
}>();

const { mobile, density } = useTouchDensity();
const fileInput = ref<HTMLInputElement | null>(null);

const manualPreviewHeaders = [
  { title: 'Назва', key: 'name' },
  { title: 'Ціна від', key: 'minPrice' },
  { title: 'Ціна до', key: 'maxPrice' },
  { title: 'К-сть', key: 'quantity' },
];
</script>
