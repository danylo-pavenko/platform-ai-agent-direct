<template>
  <v-card>
    <v-card-title class="d-flex flex-wrap align-center ga-2 py-3">
      <span>Послуги та ціни</span>
      <v-chip v-if="servicesCount > 0" size="small" variant="tonal">
        {{ servicesCount }}
      </v-chip>
      <v-spacer />
      <span v-if="servicesSyncedAt" class="text-caption text-medium-emphasis font-weight-regular">
        Знімок sync · {{ formatDate(servicesSyncedAt) }}
      </span>
    </v-card-title>
    <v-card-subtitle class="pb-2">
      Знімок після синхронізації (services.json): ціни по рівнях майстрів з CRM (positions), не live
      API.
    </v-card-subtitle>

    <v-card-text v-if="servicesCount > 0 || servicesSearch" class="pt-0">
      <v-text-field
        v-model="servicesSearchModel"
        :density="density"
        variant="outlined"
        hide-details
        clearable
        prepend-inner-icon="mdi-magnify"
        placeholder="Пошук за назвою, категорією, грейдом або ID"
        class="mb-3"
        :style="mobile ? undefined : 'max-width: 420px'"
      />
      <ResponsiveDataList
        :loading="servicesLoading"
        :empty="!servicesLoading && !filteredServices.length"
        :empty-text="
          servicesSearch
            ? `Нічого не знайдено за запитом «${servicesSearch}».`
            : 'Немає послуг у знімку'
        "
      >
        <template #cards>
          <MobileListCard
            v-for="item in filteredServices"
            :key="`${item.provider}-${item.id}`"
            :title="item.name"
            :meta="`${item.durationMin} хв · ${item.categoryName || '—'}`"
          >
            <template #chips>
              <v-chip size="small" variant="tonal" :color="providerColor(item.provider)">
                {{ providerLabel(item.provider) }}
              </v-chip>
            </template>
            <div class="text-body-2 mt-1">{{ formatServicePriceDisplay(item) }}</div>
            <div
              v-if="formatServiceGradeBreakdown(item)"
              class="text-caption text-medium-emphasis"
            >
              {{ formatServiceGradeBreakdown(item) }}
            </div>
            <div class="text-caption text-medium-emphasis mt-1">
              <code>{{ item.id }}</code>
              <v-btn
                size="x-small"
                variant="text"
                icon="mdi-content-copy"
                class="tap-target"
                @click="copyText(item.id)"
              />
            </div>
          </MobileListCard>
        </template>
        <template #table>
          <v-data-table
            :headers="serviceHeaders"
            :items="filteredServices"
            :loading="servicesLoading"
            :items-per-page="25"
            hover
            density="compact"
          >
            <template #item.provider="{ item }">
              <v-chip size="x-small" variant="tonal" :color="providerColor(item.provider)">
                {{ providerLabel(item.provider) }}
              </v-chip>
            </template>
            <template #item.durationMin="{ item }">
              {{ item.durationMin }} хв
            </template>
            <template #item.price="{ item }">
              <div>
                <div>{{ formatServicePriceDisplay(item) }}</div>
                <div
                  v-if="formatServiceGradeBreakdown(item)"
                  class="text-caption text-medium-emphasis"
                >
                  {{ formatServiceGradeBreakdown(item) }}
                </div>
                <div
                  v-else-if="!item.priceRows?.length"
                  class="text-caption text-medium-emphasis"
                >
                  Пересинхронізуйте, щоб побачити грейди
                </div>
                <div
                  v-if="uniqueBranchCount(item) > 0"
                  class="text-caption text-medium-emphasis"
                >
                  ({{ uniqueBranchCount(item) }} філ.)
                </div>
              </div>
            </template>
            <template #item.categoryName="{ item }">
              {{ item.categoryName || '—' }}
            </template>
            <template #item.id="{ item }">
              <div class="d-flex align-center ga-1">
                <code class="text-caption">{{ item.id }}</code>
                <v-btn
                  size="x-small"
                  variant="text"
                  icon="mdi-content-copy"
                  @click="copyText(item.id)"
                />
              </div>
            </template>
          </v-data-table>
        </template>
      </ResponsiveDataList>
    </v-card-text>

    <v-card-text v-else-if="servicesLoading" class="d-flex align-center ga-2 py-6">
      <v-progress-circular indeterminate size="20" width="2" />
      <span class="text-body-2 text-medium-emphasis">Завантаження знімка послуг…</span>
    </v-card-text>

    <v-card-text v-else>
      <div class="text-body-2 text-medium-emphasis mb-3">
        Ще немає знімка послуг — запустіть синхронізацію після підключення BeautyPro або CleverBOX.
      </div>
      <v-btn
        color="primary"
        variant="tonal"
        class="tap-target"
        :block="mobile"
        prepend-icon="mdi-sync"
        :loading="triggering"
        :disabled="isRunning"
        @click="$emit('trigger')"
      >
        Синхронізувати зараз
      </v-btn>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import MobileListCard from '@/components/MobileListCard.vue';
import ResponsiveDataList from '@/components/ResponsiveDataList.vue';
import { useTouchDensity } from '@/composables/useTouchDensity';
import {
  type SyncedService,
  copyText,
  formatDate,
  formatServiceGradeBreakdown,
  formatServicePriceDisplay,
  providerColor,
  providerLabel,
  uniqueBranchCount,
} from '@/components/sync/sync-labels';

const props = defineProps<{
  filteredServices: SyncedService[];
  servicesCount: number;
  servicesSyncedAt: string | null;
  servicesLoading: boolean;
  servicesSearch: string;
  triggering: boolean;
  isRunning: boolean;
}>();

const emit = defineEmits<{
  'update:servicesSearch': [value: string];
  trigger: [];
}>();

const { mobile, density } = useTouchDensity();

const servicesSearchModel = computed({
  get: () => props.servicesSearch,
  set: (v: string) => emit('update:servicesSearch', v ?? ''),
});

const serviceHeaders = [
  { title: 'Назва', key: 'name', sortable: true },
  { title: 'Категорія', key: 'categoryName', sortable: true },
  { title: 'Тривалість', key: 'durationMin', width: '110px', sortable: true },
  { title: 'Ціна', key: 'price', width: '280px', sortable: true },
  { title: 'CRM', key: 'provider', width: '120px', sortable: true },
  { title: 'ID', key: 'id', width: '200px', sortable: false },
];
</script>
