<template>
  <v-card>
    <v-card-title class="d-flex flex-wrap align-center ga-2 py-3">
      <span>Звʼязки з CRM</span>
      <v-chip size="small" variant="tonal">matched {{ matchOverview.matched }}</v-chip>
      <v-chip size="small" variant="outlined">
        unmatched {{ matchOverview.unmatchedManual.length }}
      </v-chip>
      <v-spacer />
      <v-btn
        size="small"
        variant="tonal"
        class="tap-target"
        :block="mobile"
        :loading="rebuildingMatches"
        prepend-icon="mdi-link-variant"
        @click="$emit('rebuild')"
      >
        Перерахувати matches
      </v-btn>
    </v-card-title>
    <v-card-subtitle class="pb-2">
      Звʼяжіть товари з файлу з позиціями CRM, щоб агент коректно шукав і цитував ціни.
    </v-card-subtitle>

    <v-card-text>
      <v-alert v-if="importError" type="error" density="compact" class="mb-3" closable>
        {{ importError }}
      </v-alert>
      <v-alert v-if="importSuccess" type="success" density="compact" class="mb-3" closable>
        {{ importSuccess }}
      </v-alert>

      <div v-if="matchOverview.unmatchedManual.length" class="mb-4">
        <div class="text-caption text-medium-emphasis mb-2">Не зматчені (файл)</div>
        <ResponsiveDataList
          :empty="false"
          empty-text="Немає незматчених"
        >
          <template #cards>
            <MobileListCard
              v-for="p in matchOverview.unmatchedManual.slice(0, 30)"
              :key="p.id"
              :title="p.name"
              :meta="formatManualPrice(p.minPrice, p.maxPrice)"
            >
              <v-select
                :model-value="linkDraft[p.id]"
                :items="crmLinkItems"
                item-title="title"
                item-value="value"
                density="compact"
                variant="outlined"
                hide-details
                label="CRM товар"
                class="mt-2"
                @update:model-value="$emit('update-link-draft', p.id, $event)"
              />
              <v-btn
                size="small"
                class="mt-2 tap-target"
                color="primary"
                :disabled="!linkDraft[p.id]"
                :loading="linkingId === p.id"
                @click="$emit('link', p.id)"
              >
                Звʼязати
              </v-btn>
            </MobileListCard>
          </template>
          <template #table>
            <v-data-table
              :headers="unmatchedHeaders"
              :items="matchOverview.unmatchedManual.slice(0, 50)"
              density="compact"
              :items-per-page="10"
            >
              <template #item.price="{ item }">
                {{ formatManualPrice(item.minPrice, item.maxPrice) }}
              </template>
              <template #item.link="{ item }">
                <div class="d-flex align-center ga-2 py-1">
                  <v-select
                    :model-value="linkDraft[item.id]"
                    :items="crmLinkItems"
                    item-title="title"
                    item-value="value"
                    density="compact"
                    variant="outlined"
                    hide-details
                    style="min-width: 220px"
                    @update:model-value="$emit('update-link-draft', item.id, $event)"
                  />
                  <v-btn
                    size="small"
                    color="primary"
                    :disabled="!linkDraft[item.id]"
                    :loading="linkingId === item.id"
                    @click="$emit('link', item.id)"
                  >
                    Звʼязати
                  </v-btn>
                </div>
              </template>
            </v-data-table>
          </template>
        </ResponsiveDataList>
      </div>

      <div v-if="enrichedMatches.length">
        <div class="text-caption text-medium-emphasis mb-2">Зматчені</div>
        <ResponsiveDataList :empty="false">
          <template #cards>
            <MobileListCard
              v-for="item in enrichedMatches"
              :key="`${item.manualProductId}-${item.crmProductId}`"
              :title="`Файл #${item.manualProductId} → CRM #${item.crmProductId}`"
              :meta="`${item.method} · ${item.confidence}`"
            >
              <template #actions>
                <v-btn
                  size="small"
                  variant="tonal"
                  color="error"
                  class="tap-target"
                  :loading="unlinkingId === item.manualProductId"
                  @click="$emit('unlink', item.manualProductId)"
                >
                  Unlink
                </v-btn>
              </template>
            </MobileListCard>
          </template>
          <template #table>
            <v-data-table
              :headers="matchedHeaders"
              :items="enrichedMatches"
              density="compact"
              :items-per-page="10"
            >
              <template #item.actions="{ item }">
                <v-btn
                  size="small"
                  variant="text"
                  color="error"
                  :loading="unlinkingId === item.manualProductId"
                  @click="$emit('unlink', item.manualProductId)"
                >
                  Unlink
                </v-btn>
              </template>
            </v-data-table>
          </template>
        </ResponsiveDataList>
      </div>

      <div
        v-if="!matchOverview.unmatchedManual.length && !enrichedMatches.length"
        class="text-body-2 text-medium-emphasis"
      >
        Немає звʼязків — імпортуйте файл і натисніть «Перерахувати matches», або звʼяжіть вручну.
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import MobileListCard from '@/components/MobileListCard.vue';
import ResponsiveDataList from '@/components/ResponsiveDataList.vue';
import { useTouchDensity } from '@/composables/useTouchDensity';
import { formatManualPrice } from '@/components/sync/sync-labels';

defineProps<{
  matchOverview: {
    matched: number;
    unmatchedManual: Array<{
      id: number;
      name: string;
      minPrice: number | null;
      maxPrice: number | null;
    }>;
  };
  enrichedMatches: Array<{
    manualProductId: number;
    crmProductId: number;
    method: string;
    confidence: string;
  }>;
  crmLinkItems: Array<{ title: string; value: number }>;
  linkDraft: Record<number, number | null>;
  linkingId: number | null;
  unlinkingId: number | null;
  rebuildingMatches: boolean;
  importError: string;
  importSuccess: string;
}>();

defineEmits<{
  rebuild: [];
  link: [manualProductId: number];
  unlink: [manualProductId: number];
  'update-link-draft': [manualProductId: number, crmProductId: number | null];
}>();

const { mobile } = useTouchDensity();

const unmatchedHeaders = [
  { title: 'Файл', key: 'name' },
  { title: 'Ціна', key: 'price', width: '120px' },
  { title: 'Звʼязок', key: 'link' },
];
const matchedHeaders = [
  { title: 'Файл ID', key: 'manualProductId', width: '100px' },
  { title: 'CRM ID', key: 'crmProductId', width: '100px' },
  { title: 'Метод', key: 'method', width: '100px' },
  { title: 'Confidence', key: 'confidence', width: '110px' },
  { title: '', key: 'actions', width: '100px', sortable: false },
];
</script>
