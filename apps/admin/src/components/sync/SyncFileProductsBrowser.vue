<template>
  <v-card>
    <v-card-title class="d-flex flex-wrap align-center ga-2 py-3">
      <span>Товари та ціни</span>
      <v-chip v-if="productCount > 0" size="small" variant="tonal">
        {{ productCount }}
      </v-chip>
    </v-card-title>
    <v-card-subtitle class="pb-2">
      Файловий каталог після імпорту CSV — те, що бачить агент при пріоритеті «файл».
    </v-card-subtitle>

    <v-card-text v-if="productCount > 0">
      <v-text-field
        :model-value="manualSearch"
        :density="density"
        variant="outlined"
        hide-details
        clearable
        prepend-inner-icon="mdi-magnify"
        placeholder="Пошук за назвою, SKU або ID"
        class="mb-3"
        :style="mobile ? undefined : 'max-width: 420px'"
        @update:model-value="onSearch"
      />

      <ResponsiveDataList
        :loading="manualProductsLoading"
        :empty="!manualProductsLoading && !manualProducts.length"
        empty-text="Нічого не знайдено"
        :show-pagination="manualTotal > manualPageSize"
        :page="manualPage"
        :items-per-page="manualPageSize"
        :items-length="manualTotal"
        @update:page="$emit('update:page', $event)"
      >
        <template #cards>
          <MobileListCard
            v-for="p in manualProducts"
            :key="p.id"
            :title="p.name"
            :meta="`${formatManualPrice(p.minPrice, p.maxPrice)} · варіантів ${p.offerCount}`"
          >
            <div
              v-for="o in p.offers.slice(0, 4)"
              :key="o.id"
              class="text-caption text-medium-emphasis"
            >
              {{ formatOfferLine(o) }}
            </div>
          </MobileListCard>
        </template>
        <template #table>
          <v-data-table
            :headers="manualProductHeaders"
            :items="manualProducts"
            :loading="manualProductsLoading"
            :items-per-page="manualPageSize"
            :page="manualPage"
            :items-length="manualTotal"
            @update:page="$emit('update:page', $event)"
          >
            <template #item.price="{ item }">
              {{ formatManualPrice(item.minPrice, item.maxPrice) }}
            </template>
            <template #item.offers="{ item }">
              <div class="text-caption">
                <div v-for="o in item.offers.slice(0, 3)" :key="o.id">
                  {{ formatOfferLine(o) }}
                </div>
                <div v-if="item.offerCount > 3" class="text-medium-emphasis">
                  …ще {{ item.offerCount - 3 }}
                </div>
              </div>
            </template>
          </v-data-table>
        </template>
      </ResponsiveDataList>
    </v-card-text>

    <v-card-text v-else>
      <div class="text-body-2 text-medium-emphasis">
        Каталог порожній — спочатку імпортуйте CSV у вкладці «Імпорт».
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import MobileListCard from '@/components/MobileListCard.vue';
import ResponsiveDataList from '@/components/ResponsiveDataList.vue';
import { useTouchDensity } from '@/composables/useTouchDensity';
import type { ManualProduct } from '@/composables/useCatalogManual';
import { formatManualPrice, formatOfferLine } from '@/components/sync/sync-labels';

defineProps<{
  productCount: number;
  manualProducts: ManualProduct[];
  manualProductsLoading: boolean;
  manualSearch: string;
  manualPage: number;
  manualPageSize: number;
  manualTotal: number;
}>();

const emit = defineEmits<{
  'update:manualSearch': [value: string];
  'update:page': [page: number];
  search: [];
}>();

const { mobile, density } = useTouchDensity();

function onSearch(value: string | null) {
  emit('update:manualSearch', value ?? '');
  emit('search');
}

const manualProductHeaders = [
  { title: 'Назва', key: 'name' },
  { title: 'Ціна', key: 'price' },
  { title: 'Варіанти', key: 'offers' },
  { title: 'ID', key: 'id', width: '120px' },
];
</script>
