<template>
  <v-container fluid class="page-shell">
    <PageHeader
      title="Синхронізація"
      :subtitle="headerSubtitle"
    >
      <template #actions>
        <v-btn
          v-if="syncSource === 'crm'"
          color="primary"
          class="tap-target"
          :block="mobile"
          :prepend-icon="isRunning ? 'mdi-progress-clock' : 'mdi-sync'"
          :loading="triggering"
          :disabled="isRunning"
          @click="triggerSync"
        >
          {{ isRunning ? 'Виконується…' : 'Синхронізувати зараз' }}
        </v-btn>
      </template>
    </PageHeader>

    <v-alert v-if="triggerSuccess" type="success" density="compact" class="mb-4" closable>
      {{ triggerSuccess }}
    </v-alert>
    <v-alert v-if="error" type="error" density="compact" class="mb-4" closable>
      {{ error }}
    </v-alert>
    <v-alert v-if="isRunning" type="info" density="compact" class="mb-4" variant="tonal">
      <div class="d-flex align-center ga-2">
        <v-progress-circular indeterminate size="16" width="2" />
        <span>
          Синхронізація триває з {{ formatDate(latestRun?.startedAt) }}. Сторінка оновлюється
          автоматично.
        </span>
      </div>
    </v-alert>

    <!-- L1: source -->
    <v-tabs
      v-model="syncSource"
      color="primary"
      class="sync-tabs mb-2"
      :density="density"
      show-arrows
      @update:model-value="persistHash"
    >
      <v-tab value="crm" class="tap-target text-none">
        <v-icon start size="18">mdi-cloud-sync</v-icon>
        CRM
      </v-tab>
      <v-tab value="file" class="tap-target text-none">
        <v-icon start size="18">mdi-file-upload-outline</v-icon>
        Каталог з файлу
        <v-chip
          v-if="manualMeta.productCount > 0"
          size="x-small"
          variant="tonal"
          class="ml-2"
        >
          {{ manualMeta.productCount }}
        </v-chip>
      </v-tab>
    </v-tabs>

    <!-- L2: CRM panes -->
    <v-tabs
      v-if="syncSource === 'crm'"
      v-model="crmPane"
      color="primary"
      class="sync-tabs sync-tabs--sub mb-3"
      :density="density"
      show-arrows
      @update:model-value="persistHash"
    >
      <v-tab value="runs" class="tap-target text-none">Запуски</v-tab>
      <v-tab value="services" class="tap-target text-none">
        Послуги
        <v-chip
          v-if="servicesCount > 0"
          size="x-small"
          variant="tonal"
          class="ml-2"
        >
          {{ servicesCount }}
        </v-chip>
      </v-tab>
    </v-tabs>

    <!-- L2: File panes -->
    <v-tabs
      v-if="syncSource === 'file'"
      v-model="filePane"
      color="primary"
      class="sync-tabs sync-tabs--sub mb-3"
      :density="density"
      show-arrows
      @update:model-value="persistHash"
    >
      <v-tab value="import" class="tap-target text-none">Імпорт</v-tab>
      <v-tab value="products" class="tap-target text-none">
        Товари
        <v-chip
          v-if="manualMeta.productCount > 0"
          size="x-small"
          variant="tonal"
          class="ml-2"
        >
          {{ manualMeta.productCount }}
        </v-chip>
      </v-tab>
      <v-tab value="matches" class="tap-target text-none">
        Звʼязки
        <v-chip
          v-if="matchOverview.matched > 0"
          size="x-small"
          variant="tonal"
          class="ml-2"
        >
          {{ matchOverview.matched }}
        </v-chip>
      </v-tab>
    </v-tabs>

    <SyncCrmRunsPanel
      v-if="activePane === 'crm-runs'"
      :runs="runs"
      :loading="loading"
      :latest-ok-run="latestOkRun"
    />

    <SyncServicesBrowser
      v-else-if="activePane === 'crm-services'"
      v-model:services-search="servicesSearch"
      :filtered-services="filteredServices"
      :services-count="servicesCount"
      :services-synced-at="servicesSyncedAt"
      :services-loading="servicesLoading"
      :triggering="triggering"
      :is-running="isRunning"
      @trigger="triggerSync"
    />

    <SyncFileImportPanel
      v-else-if="activePane === 'file-import'"
      v-model:import-source="importSource"
      v-model:force-import="forceImport"
      :manual-meta="manualMeta"
      :import-source-items="importSourceItems"
      :importing="importing"
      :clearing-manual="clearingManual"
      :saving-priority="savingPriority"
      :import-error="importError"
      :import-success="importSuccess"
      :import-preview="importPreview"
      :confirming-import="confirmingImport"
      :priority-draft="priorityDraft"
      :price-pref-draft="pricePrefDraft"
      @csv-selected="onCsvSelected"
      @clear="clearManual"
      @save-priority="savePriority"
      @save-price-preference="savePricePreference"
      @confirm-import="confirmImport"
    />

    <SyncFileProductsBrowser
      v-else-if="activePane === 'file-products'"
      v-model:manual-search="manualSearch"
      :product-count="manualMeta.productCount"
      :manual-products="manualProducts"
      :manual-products-loading="manualProductsLoading"
      :manual-page="manualPage"
      :manual-page-size="manualPageSize"
      :manual-total="manualTotal"
      @search="debouncedFetchManualProducts"
      @update:page="onManualPage"
    />

    <SyncFileMatchesPanel
      v-else-if="activePane === 'file-matches'"
      :match-overview="matchOverview"
      :enriched-matches="enrichedMatches"
      :crm-link-items="crmLinkItems"
      :link-draft="linkDraft"
      :linking-id="linkingId"
      :unlinking-id="unlinkingId"
      :rebuilding-matches="rebuildingMatches"
      :import-error="importError"
      :import-success="importSuccess"
      @rebuild="rebuildMatches"
      @link="linkMatch"
      @unlink="unlinkMatch"
      @update-link-draft="onUpdateLinkDraft"
    />
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import SyncCrmRunsPanel from '@/components/sync/SyncCrmRunsPanel.vue';
import SyncServicesBrowser from '@/components/sync/SyncServicesBrowser.vue';
import SyncFileImportPanel from '@/components/sync/SyncFileImportPanel.vue';
import SyncFileProductsBrowser from '@/components/sync/SyncFileProductsBrowser.vue';
import SyncFileMatchesPanel from '@/components/sync/SyncFileMatchesPanel.vue';
import {
  resolveSyncPane,
  syncHeaderSubtitle,
} from '@/components/sync/sync-flow';
import {
  type CrmPane,
  type FilePane,
  type SyncSource,
  parseSyncHash,
  replaceSyncHash,
} from '@/components/sync/sync-hash';
import { formatDate } from '@/components/sync/sync-labels';
import { useTouchDensity } from '@/composables/useTouchDensity';
import { useSyncRuns } from '@/composables/useSyncRuns';
import { useSyncServices } from '@/composables/useSyncServices';
import { useCatalogManual } from '@/composables/useCatalogManual';

const { mobile, density } = useTouchDensity();

const syncSource = ref<SyncSource>('crm');
const crmPane = ref<CrmPane>('runs');
const filePane = ref<FilePane>('import');

const routeState = computed(() => ({
  source: syncSource.value,
  crmPane: crmPane.value,
  filePane: filePane.value,
}));
const activePane = computed(() => resolveSyncPane(routeState.value));

const {
  servicesCount,
  servicesSyncedAt,
  servicesLoading,
  servicesSearch,
  filteredServices,
  fetchServices,
} = useSyncServices();

const {
  runs,
  loading,
  triggering,
  error,
  triggerSuccess,
  latestRun,
  isRunning,
  latestOkRun,
  fetchSyncStatus,
  triggerSync,
} = useSyncRuns({
  onRunFinished: () => {
    void fetchServices(false);
  },
});

const catalog = useCatalogManual();
const {
  importSource,
  importSourceItems,
  importing,
  confirmingImport,
  clearingManual,
  savingPriority,
  importError,
  importSuccess,
  forceImport,
  importPreview,
  manualMeta,
  priorityDraft,
  pricePrefDraft,
  matchOverview,
  linkDraft,
  linkingId,
  unlinkingId,
  rebuildingMatches,
  manualProducts,
  manualProductsLoading,
  manualSearch,
  manualPage,
  manualPageSize,
  manualTotal,
  crmLinkItems,
  enrichedMatches,
  fetchManualMeta,
  fetchMatches,
  fetchManualProducts,
  debouncedFetchManualProducts,
  onManualPage,
  onCsvSelected,
  confirmImport,
  savePriority,
  savePricePreference,
  rebuildMatches,
  linkMatch,
  unlinkMatch,
  clearManual,
} = catalog;

const headerSubtitle = computed(() => syncHeaderSubtitle(routeState.value));

function persistHash() {
  replaceSyncHash(routeState.value);
}

function applyHashFromLocation() {
  const state = parseSyncHash(typeof location !== 'undefined' ? location.hash : '');
  syncSource.value = state.source;
  crmPane.value = state.crmPane;
  filePane.value = state.filePane;
}

function onUpdateLinkDraft(manualProductId: number, crmProductId: number | null) {
  linkDraft.value[manualProductId] = crmProductId;
}

watch(filePane, (pane) => {
  if (pane === 'products') void fetchManualProducts();
  if (pane === 'matches') void fetchMatches();
});

onMounted(async () => {
  applyHashFromLocation();
  await Promise.all([
    fetchSyncStatus(),
    fetchServices(),
    fetchManualMeta(),
    fetchMatches(),
  ]);
  if (filePane.value === 'products' || manualMeta.value.productCount > 0) {
    await fetchManualProducts();
  }
  persistHash();
});
</script>

<style scoped>
.sync-tabs {
  margin-inline: calc(-1 * var(--page-pad, 0px));
  padding-inline: var(--page-pad, 0);
}

.sync-tabs :deep(.v-tab) {
  min-height: var(--tap-min, 44px);
  flex: 1 1 0;
  max-width: none;
}

.sync-tabs--sub :deep(.v-tab) {
  font-size: 0.875rem;
}

@media (min-width: 960px) {
  .sync-tabs {
    margin-inline: 0;
    padding-inline: 0;
  }

  .sync-tabs :deep(.v-tab) {
    flex: 0 0 auto;
  }
}
</style>
