<template>
  <div>
    <v-row v-if="latestOkRun" class="mb-4">
      <v-col cols="12" sm="6" md="3">
        <v-card variant="tonal" color="primary">
          <v-card-text>
            <div class="text-caption">Останній успішний run</div>
            <div class="text-h6">{{ providerLabel(latestOkRun.provider) }}</div>
            <div class="text-caption">{{ syncTypeLabel(latestOkRun.syncType) }}</div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col v-for="chip in chips" :key="chip.label" cols="12" sm="6" md="3">
        <v-card variant="outlined">
          <v-card-text>
            <div class="text-caption text-medium-emphasis">{{ chip.label }}</div>
            <div class="text-h6">{{ chip.count ?? '—' }}</div>
            <div class="text-caption">{{ chip.provider }}</div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-card>
      <v-card-title>Останні синхронізації</v-card-title>
      <ResponsiveDataList
        :loading="loading"
        :empty="!loading && !runs.length"
        empty-text="Ще немає синхронізацій"
      >
        <template #cards>
          <MobileListCard
            v-for="(item, idx) in runs"
            :key="idx"
            :title="`${providerLabel(item.provider)} · ${syncTypeLabel(item.syncType)}`"
            :meta="formatDate(item.startedAt)"
          >
            <template #chips>
              <v-chip :color="statusColor(item.status)" size="small" label>
                {{ statusLabel(item.status) }}
              </v-chip>
              <v-chip
                v-if="item.counts?.services != null"
                size="small"
                variant="outlined"
              >
                Послуг: {{ item.counts.services }}
              </v-chip>
              <v-chip
                v-if="item.counts?.masters != null"
                size="small"
                variant="outlined"
              >
                Майстрів: {{ item.counts.masters }}
              </v-chip>
            </template>
            <div
              v-if="item.status === 'error' && item.errorMessage"
              class="text-error text-caption mt-1"
            >
              {{ item.errorMessage }}
            </div>
          </MobileListCard>
        </template>
        <template #table>
          <v-data-table :headers="headers" :items="runs" :loading="loading" hover>
            <template #item.status="{ item }">
              <v-chip :color="statusColor(item.status)" size="small" label>
                <v-progress-circular
                  v-if="item.status === 'running'"
                  indeterminate
                  size="12"
                  width="2"
                  class="mr-2"
                />
                {{ statusLabel(item.status) }}
              </v-chip>
            </template>
            <template #item.provider="{ item }">
              <v-chip size="small" variant="tonal" :color="providerColor(item.provider)">
                {{ providerLabel(item.provider) }}
              </v-chip>
            </template>
            <template #item.syncType="{ item }">
              {{ syncTypeLabel(item.syncType) }}
            </template>
            <template #item.startedAt="{ item }">
              {{ formatDate(item.startedAt) }}
            </template>
            <template #item.finishedAt="{ item }">
              {{ formatDate(item.finishedAt) }}
            </template>
            <template #item.duration="{ item }">
              {{ calcDuration(item.startedAt, item.finishedAt) }}
            </template>
            <template #item.counts="{ item }">
              <template v-if="item.counts">
                <v-chip
                  v-if="item.counts.categories != null"
                  size="x-small"
                  class="mr-1"
                  variant="outlined"
                >
                  Категорій: {{ item.counts.categories }}
                </v-chip>
                <v-chip
                  v-if="item.counts.products != null"
                  size="x-small"
                  class="mr-1"
                  variant="outlined"
                >
                  Товарів: {{ item.counts.products }}
                </v-chip>
                <v-chip
                  v-if="item.counts.offers != null"
                  size="x-small"
                  class="mr-1"
                  variant="outlined"
                >
                  Варіантів: {{ item.counts.offers }}
                </v-chip>
                <v-chip
                  v-if="item.counts.services != null"
                  size="x-small"
                  class="mr-1"
                  variant="outlined"
                >
                  Послуг: {{ item.counts.services }}
                </v-chip>
                <v-chip
                  v-if="item.counts.masters != null"
                  size="x-small"
                  variant="outlined"
                >
                  Майстрів: {{ item.counts.masters }}
                </v-chip>
              </template>
              <span v-else class="text-grey">-</span>
            </template>
            <template #item.artifacts="{ item }">
              <span v-if="artifactSummary(item)" class="text-caption text-medium-emphasis">
                {{ artifactSummary(item) }}
              </span>
              <span v-else>-</span>
            </template>
            <template #item.errorMessage="{ item }">
              <span
                v-if="item.status === 'error' && item.errorMessage"
                class="text-red text-body-2"
              >
                {{ item.errorMessage }}
              </span>
              <span v-else>-</span>
            </template>
          </v-data-table>
        </template>
      </ResponsiveDataList>
    </v-card>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import MobileListCard from '@/components/MobileListCard.vue';
import ResponsiveDataList from '@/components/ResponsiveDataList.vue';
import {
  type SyncRun,
  artifactSummary,
  calcDuration,
  formatDate,
  latestSourceChips,
  providerColor,
  providerLabel,
  statusColor,
  statusLabel,
  syncTypeLabel,
} from '@/components/sync/sync-labels';

const props = defineProps<{
  runs: SyncRun[];
  loading: boolean;
  latestOkRun: SyncRun | null;
}>();

const chips = computed(() => latestSourceChips(props.latestOkRun));

const headers = [
  { title: 'Статус', key: 'status', width: '120px', sortable: false },
  { title: 'CRM', key: 'provider', width: '110px', sortable: false },
  { title: 'Тип', key: 'syncType', width: '100px', sortable: false },
  { title: 'Початок', key: 'startedAt', width: '160px', sortable: false },
  { title: 'Завершення', key: 'finishedAt', width: '160px', sortable: false },
  { title: 'Тривалість', key: 'duration', width: '110px', sortable: false },
  { title: 'Кількість', key: 'counts', sortable: false },
  { title: 'Файли', key: 'artifacts', sortable: false },
  { title: 'Помилка', key: 'errorMessage', sortable: false },
];
</script>
