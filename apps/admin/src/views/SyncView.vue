<template>
  <v-container fluid class="page-shell">
    <PageHeader
      title="Синхронізація"
      subtitle="Каталог товарів, послуг, цін і майстрів з підключених CRM. Автозапуск раз на добу (~04:00) + ручний тригер."
    >
      <template #actions>
        <v-btn
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
        <span>Синхронізація триває з {{ formatDate(latestRun?.startedAt) }}. Сторінка оновлюється автоматично.</span>
      </div>
    </v-alert>

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
      <v-col v-for="chip in latestSourceChips" :key="chip.label" cols="12" sm="6" md="3">
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
      <div v-if="mobile" class="pa-3 mobile-list-stack">
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
          </template>
          <div v-if="item.status === 'error' && item.errorMessage" class="text-error text-caption mt-1">
            {{ item.errorMessage }}
          </div>
        </MobileListCard>
        <div v-if="!loading && !runs.length" class="text-center text-medium-emphasis py-6">
          Ще немає синхронізацій
        </div>
      </div>
      <v-data-table
        v-else
        :headers="headers"
        :items="runs"
        :loading="loading"
        hover
      >
        <template #item.status="{ item }">
          <v-chip
            :color="statusColor(item.status)"
            size="small"
            label
          >
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
            <v-chip v-if="item.counts.categories != null" size="x-small" class="mr-1" variant="outlined">
              Категорій: {{ item.counts.categories }}
            </v-chip>
            <v-chip v-if="item.counts.products != null" size="x-small" class="mr-1" variant="outlined">
              Товарів: {{ item.counts.products }}
            </v-chip>
            <v-chip v-if="item.counts.offers != null" size="x-small" class="mr-1" variant="outlined">
              Варіантів: {{ item.counts.offers }}
            </v-chip>
            <v-chip v-if="item.counts.services != null" size="x-small" class="mr-1" variant="outlined">
              Послуг: {{ item.counts.services }}
            </v-chip>
            <v-chip v-if="item.counts.masters != null" size="x-small" variant="outlined">
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
          <span v-if="item.status === 'error' && item.errorMessage" class="text-red text-body-2">
            {{ item.errorMessage }}
          </span>
          <span v-else>-</span>
        </template>
      </v-data-table>
    </v-card>

    <v-card class="mt-4">
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
        Знімок після синхронізації (services.json): ціни по рівнях майстрів з CRM (positions), не live API.
      </v-card-subtitle>

      <v-card-text v-if="servicesCount > 0 || servicesSearch" class="pt-0">
        <v-text-field
          v-model="servicesSearch"
          density="compact"
          variant="outlined"
          hide-details
          clearable
          prepend-inner-icon="mdi-magnify"
          placeholder="Пошук за назвою, категорією, грейдом або ID"
          class="mb-3"
          style="max-width: 420px"
        />
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
          <template #no-data>
            <div class="text-medium-emphasis py-4">
              Нічого не знайдено за запитом «{{ servicesSearch }}».
            </div>
          </template>
        </v-data-table>
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
          prepend-icon="mdi-sync"
          :loading="triggering"
          :disabled="isRunning"
          @click="triggerSync"
        >
          Синхронізувати зараз
        </v-btn>
      </v-card-text>
    </v-card>

    <v-card class="mt-4">
      <v-card-title class="d-flex flex-wrap align-center ga-2 py-3">
        <span>Каталог з файлу</span>
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
        CSV з Shop-Express (Engine): парсер кодом → перевірка Claude → підтвердження.
        Агент шукає товари за пріоритетом нижче.
      </v-card-subtitle>

      <v-card-text>
        <v-row dense>
          <v-col cols="12" md="4">
            <v-select
              v-model="importSource"
              :items="importSourceItems"
              label="Джерело файлу"
              density="comfortable"
              variant="outlined"
              hide-details
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
              @change="onCsvSelected"
            />
            <v-btn
              v-if="manualMeta.productCount > 0"
              variant="tonal"
              color="error"
              class="tap-target"
              :block="mobile"
              :loading="clearingManual"
              prepend-icon="mdi-delete-outline"
              @click="clearManual"
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
            v-model="priorityDraft"
            density="compact"
            hide-details
            inline
            :disabled="savingPriority"
            @update:model-value="savePriority"
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
            v-model="pricePrefDraft"
            density="compact"
            hide-details
            inline
            :disabled="savingPriority"
            @update:model-value="savePricePreference"
          >
            <v-radio label="Файл" value="file" />
            <v-radio
              label="CRM"
              value="crm"
              :disabled="!manualMeta.crmCatalogAvailable"
            />
          </v-radio-group>
        </div>

        <div class="mt-4">
          <div class="d-flex flex-wrap align-center ga-2 mb-2">
            <div class="text-subtitle-2">Звʼязки з CRM</div>
            <v-chip size="small" variant="tonal">
              matched {{ matchOverview.matched }}
            </v-chip>
            <v-chip size="small" variant="outlined">
              unmatched {{ matchOverview.unmatchedManual.length }}
            </v-chip>
            <v-spacer />
            <v-btn
              size="small"
              variant="tonal"
              class="tap-target"
              :loading="rebuildingMatches"
              prepend-icon="mdi-link-variant"
              @click="rebuildMatches"
            >
              Перерахувати matches
            </v-btn>
          </div>

          <div v-if="matchOverview.unmatchedManual.length" class="mb-3">
            <div class="text-caption text-medium-emphasis mb-2">Не зматчені (файл)</div>
            <div v-if="mobile" class="mobile-list-stack">
              <MobileListCard
                v-for="p in matchOverview.unmatchedManual.slice(0, 30)"
                :key="p.id"
                :title="p.name"
                :meta="formatManualPrice(p.minPrice, p.maxPrice)"
              >
                <v-select
                  v-model="linkDraft[p.id]"
                  :items="crmLinkItems"
                  item-title="title"
                  item-value="value"
                  density="compact"
                  variant="outlined"
                  hide-details
                  label="CRM товар"
                  class="mt-2"
                />
                <v-btn
                  size="small"
                  class="mt-2 tap-target"
                  color="primary"
                  :disabled="!linkDraft[p.id]"
                  :loading="linkingId === p.id"
                  @click="linkMatch(p.id)"
                >
                  Звʼязати
                </v-btn>
              </MobileListCard>
            </div>
            <v-data-table
              v-else
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
                    v-model="linkDraft[item.id]"
                    :items="crmLinkItems"
                    item-title="title"
                    item-value="value"
                    density="compact"
                    variant="outlined"
                    hide-details
                    style="min-width: 220px"
                  />
                  <v-btn
                    size="small"
                    color="primary"
                    :disabled="!linkDraft[item.id]"
                    :loading="linkingId === item.id"
                    @click="linkMatch(item.id)"
                  >
                    Звʼязати
                  </v-btn>
                </div>
              </template>
            </v-data-table>
          </div>

          <div v-if="matchOverview.matches.length">
            <div class="text-caption text-medium-emphasis mb-2">Зматчені</div>
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
                  @click="unlinkMatch(item.manualProductId)"
                >
                  Unlink
                </v-btn>
              </template>
            </v-data-table>
          </div>
        </div>

        <div v-if="importPreview" class="mt-4">
          <div class="text-subtitle-2 mb-1">Preview імпорту</div>
          <div class="text-body-2 mb-2">
            Рядків: {{ importPreview.stats.rowCount }},
            товарів: {{ importPreview.stats.productCount }},
            варіантів: {{ importPreview.stats.offerCount }},
            ціни: {{ importPreview.stats.priceMin ?? '—' }}–{{ importPreview.stats.priceMax ?? '—' }} ₴
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

          <div v-if="mobile" class="mobile-list-stack mb-3">
            <MobileListCard
              v-for="p in importPreview.sampleProducts"
              :key="p.id"
              :title="p.name"
              :meta="formatManualPrice(p.minPrice, p.maxPrice)"
            />
          </div>
          <v-data-table
            v-else
            :headers="manualPreviewHeaders"
            :items="importPreview.sampleProducts"
            density="compact"
            :items-per-page="10"
            class="mb-3"
          />

          <div class="d-flex flex-wrap ga-2">
            <v-btn
              color="primary"
              class="tap-target"
              :loading="confirmingImport"
              :disabled="!importPreview.verify.ok && !forceImport"
              @click="confirmImport(false)"
            >
              Застосувати каталог
            </v-btn>
            <v-btn
              v-if="!importPreview.verify.ok"
              variant="tonal"
              color="warning"
              class="tap-target"
              :loading="confirmingImport"
              @click="confirmImport(true)"
            >
              Застосувати з force
            </v-btn>
            <v-checkbox
              v-if="!importPreview.verify.ok"
              v-model="forceImport"
              density="compact"
              hide-details
              label="Дозволити confirm без ok verify"
              class="ml-1"
            />
          </div>
        </div>

        <div v-if="manualMeta.productCount > 0" class="mt-6">
          <div class="text-subtitle-2 mb-2">Товари та ціни (файловий каталог)</div>
          <v-text-field
            v-model="manualSearch"
            density="compact"
            variant="outlined"
            hide-details
            clearable
            prepend-inner-icon="mdi-magnify"
            placeholder="Пошук за назвою, SKU або ID"
            class="mb-3"
            style="max-width: 420px"
            @update:model-value="debouncedFetchManualProducts"
          />

          <div v-if="mobile" class="mobile-list-stack">
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
          </div>
          <v-data-table
            v-else
            :headers="manualProductHeaders"
            :items="manualProducts"
            :loading="manualProductsLoading"
            :items-per-page="manualPageSize"
            :page="manualPage"
            :items-length="manualTotal"
            @update:page="onManualPage"
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
        </div>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import api from '@/api';
import PageHeader from '@/components/PageHeader.vue';
import MobileListCard from '@/components/MobileListCard.vue';
import { useTouchDensity } from '@/composables/useTouchDensity';

const { mobile } = useTouchDensity();

interface SyncCounts {
  categories?: number;
  products?: number;
  offers?: number;
  services?: number;
  masters?: number;
}

interface SyncArtifacts {
  catalogPath?: string;
  servicesPath?: string;
  mastersPath?: string;
  sources?: Record<string, { provider?: string; count?: number; error?: string; skipped?: boolean }>;
}

interface SyncRun {
  id: string;
  status: 'running' | 'ok' | 'error';
  provider?: string;
  syncType?: string;
  startedAt: string;
  finishedAt?: string | null;
  counts?: SyncCounts;
  artifacts?: SyncArtifacts;
  errorMessage?: string | null;
}

interface SyncedService {
  id: string;
  name: string;
  price: number;
  durationMin: number;
  categoryName?: string;
  provider: string;
  branchPrices?: Array<{ branchId: string; branchName: string; price: number }>;
  priceRows?: Array<{
    branchId: string;
    positionId?: string;
    positionName?: string;
    price: number;
  }>;
}

const runs = ref<SyncRun[]>([]);
const loading = ref(false);
const triggering = ref(false);
const error = ref('');
const triggerSuccess = ref('');

const services = ref<SyncedService[]>([]);
const servicesCount = ref(0);
const servicesSyncedAt = ref<string | null>(null);
const servicesLoading = ref(false);
const servicesSearch = ref('');

const fileInput = ref<HTMLInputElement | null>(null);
const importSource = ref<'shop_express'>('shop_express');
const importSourceItems = [{ title: 'Shop-Express (Engine)', value: 'shop_express' }];
const importing = ref(false);
const confirmingImport = ref(false);
const clearingManual = ref(false);
const savingPriority = ref(false);
const importError = ref('');
const importSuccess = ref('');
const forceImport = ref(false);
const importPreview = ref<{
  sessionId: string;
  stats: {
    rowCount: number;
    productCount: number;
    offerCount: number;
    priceMin: number | null;
    priceMax: number | null;
  };
  verify: {
    ok: boolean;
    summaryUk: string;
    issues: Array<{ severity: string; message: string }>;
  };
  sampleProducts: Array<{
    id: number;
    name: string;
    minPrice: number | null;
    maxPrice: number | null;
    quantity: number;
    isArchived: boolean;
  }>;
} | null>(null);

const manualMeta = ref<{
  settings: {
    sourcePriority: 'file' | 'crm';
    lastImportAt: string | null;
    productCount: number;
    offerCount: number;
  } | null;
  crmCatalogAvailable: boolean;
  effectiveSource: 'file' | 'crm';
  productCount: number;
  offerCount: number;
}>({
  settings: null,
  crmCatalogAvailable: false,
  effectiveSource: 'file',
  productCount: 0,
  offerCount: 0,
});
const priorityDraft = ref<'file' | 'crm'>('file');
const pricePrefDraft = ref<'file' | 'crm'>('file');
const matchOverview = ref<{
  matches: Array<{
    manualProductId: number;
    crmProductId: number;
    method: string;
    confidence: string;
  }>;
  matched: number;
  unmatchedManual: Array<{
    id: number;
    name: string;
    minPrice: number | null;
    maxPrice: number | null;
  }>;
  crmProductOptions: Array<{
    id: number;
    name: string;
    minPrice: number | null;
    maxPrice: number | null;
  }>;
}>({
  matches: [],
  matched: 0,
  unmatchedManual: [],
  crmProductOptions: [],
});
const linkDraft = ref<Record<number, number | null>>({});
const linkingId = ref<number | null>(null);
const unlinkingId = ref<number | null>(null);
const rebuildingMatches = ref(false);

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

const crmLinkItems = computed(() =>
  matchOverview.value.crmProductOptions.map((p) => ({
    title: `${p.name} (${p.minPrice ?? '—'}₴) [#${p.id}]`,
    value: p.id,
  })),
);

const enrichedMatches = computed(() => matchOverview.value.matches);
const manualProducts = ref<
  Array<{
    id: number;
    name: string;
    minPrice: number | null;
    maxPrice: number | null;
    quantity: number;
    offerCount: number;
    offers: Array<{
      id: number;
      sku: string | null;
      price: number;
      quantity: number;
      properties: Array<{ name: string; value: string }>;
    }>;
  }>
>([]);
const manualProductsLoading = ref(false);
const manualSearch = ref('');
const manualPage = ref(1);
const manualPageSize = 25;
const manualTotal = ref(0);
let manualSearchTimer: ReturnType<typeof setTimeout> | null = null;

const POLL_INTERVAL_MS = 3_000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

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

const serviceHeaders = [
  { title: 'Назва', key: 'name', sortable: true },
  { title: 'Категорія', key: 'categoryName', sortable: true },
  { title: 'Тривалість', key: 'durationMin', width: '110px', sortable: true },
  { title: 'Ціна', key: 'price', width: '280px', sortable: true },
  { title: 'CRM', key: 'provider', width: '120px', sortable: true },
  { title: 'ID', key: 'id', width: '200px', sortable: false },
];

const manualPreviewHeaders = [
  { title: 'Назва', key: 'name' },
  { title: 'Ціна від', key: 'minPrice' },
  { title: 'Ціна до', key: 'maxPrice' },
  { title: 'К-сть', key: 'quantity' },
];

const manualProductHeaders = [
  { title: 'Назва', key: 'name' },
  { title: 'Ціна', key: 'price' },
  { title: 'Варіанти', key: 'offers' },
  { title: 'ID', key: 'id', width: '120px' },
];

const latestRun = computed<SyncRun | null>(() => runs.value[0] ?? null);
const isRunning = computed(() => latestRun.value?.status === 'running');
const latestOkRun = computed(() => runs.value.find((r) => r.status === 'ok') ?? null);

const filteredServices = computed(() => {
  const q = servicesSearch.value.trim().toLowerCase();
  if (!q) return services.value;
  return services.value.filter((s) => {
    const grades = (s.priceRows ?? [])
      .map((r) => r.positionName ?? '')
      .join(' ');
    const hay = [s.name, s.categoryName ?? '', s.id, s.provider, grades]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
});

const latestSourceChips = computed(() => {
  const run = latestOkRun.value;
  if (!run?.artifacts?.sources) {
    if (!run?.counts) return [];
    const chips: Array<{ label: string; count: number; provider: string }> = [];
    if (run.counts.products != null) {
      chips.push({ label: 'Товари', count: run.counts.products, provider: providerLabel(run.provider) });
    }
    if (run.counts.services != null) {
      chips.push({ label: 'Послуги', count: run.counts.services, provider: providerLabel(run.provider) });
    }
    if (run.counts.masters != null) {
      chips.push({ label: 'Майстри', count: run.counts.masters, provider: providerLabel(run.provider) });
    }
    return chips;
  }
  return Object.entries(run.artifacts.sources).map(([key, src]) => ({
    label: sourceLabel(key),
    count: src.count,
    provider: providerLabel(src.provider),
  }));
});

function sourceLabel(key: string): string {
  const map: Record<string, string> = {
    categories: 'Категорії',
    products: 'Товари',
    offers: 'Варіанти',
    services: 'Послуги',
    masters: 'Майстри',
    branches: 'Філії',
  };
  return map[key] ?? key;
}

function providerLabel(p?: string): string {
  if (!p) return '—';
  if (p === 'keycrm') return 'KeyCRM';
  if (p === 'cleverbox') return 'CleverBOX';
  if (p === 'beautypro') return 'BeautyPro';
  return p;
}

function providerColor(p?: string): string {
  if (p === 'cleverbox') return 'deep-purple';
  if (p === 'beautypro') return 'pink-darken-2';
  if (p === 'keycrm') return 'green-darken-1';
  return 'grey';
}

function syncTypeLabel(t?: string): string {
  if (!t) return 'каталог';
  const map: Record<string, string> = {
    catalog: 'Каталог товарів',
    services: 'Послуги',
    branches: 'Філії',
    full: 'Повна',
  };
  return map[t] ?? t;
}

function artifactSummary(item: SyncRun): string {
  const parts: string[] = [];
  if (item.artifacts?.catalogPath) parts.push('catalog.txt');
  if (item.artifacts?.servicesPath) parts.push('services-live.txt');
  if (item.artifacts?.mastersPath) parts.push('masters-live.txt');
  return parts.join(', ');
}

function formatDate(dateStr?: string | null): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('uk-UA');
}

function calcDuration(start?: string | null, end?: string | null): string {
  if (!start || !end) return '-';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms} мс`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes} хв ${remainingSeconds} с`;
}

function statusLabel(status: SyncRun['status']): string {
  switch (status) {
    case 'running': return 'В процесі';
    case 'ok':      return 'Успішно';
    case 'error':   return 'Помилка';
    default:        return status;
  }
}

function statusColor(status: SyncRun['status']): string {
  switch (status) {
    case 'running': return 'blue';
    case 'ok':      return 'green';
    case 'error':   return 'red';
    default:        return 'grey';
  }
}

async function fetchSyncStatus(showLoader = true) {
  if (showLoader) loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/sync/status');
    runs.value = Array.isArray(data?.runs) ? data.runs : [];
  } catch {
    error.value = 'Не вдалося завантажити статус синхронізації';
  } finally {
    if (showLoader) loading.value = false;
  }
}

async function fetchServices(showLoader = true) {
  if (showLoader) servicesLoading.value = true;
  try {
    const { data } = await api.get('/sync/services');
    services.value = Array.isArray(data?.services) ? data.services : [];
    servicesCount.value = typeof data?.count === 'number' ? data.count : services.value.length;
    servicesSyncedAt.value = typeof data?.syncedAt === 'string' ? data.syncedAt : null;
  } catch {
    // Keep previous snapshot visible; status error is more important on this page.
  } finally {
    if (showLoader) servicesLoading.value = false;
  }
}

async function fetchManualMeta() {
  try {
    const { data } = await api.get('/sync/catalog-manual');
    manualMeta.value = {
      settings: data?.settings ?? null,
      crmCatalogAvailable: Boolean(data?.crmCatalogAvailable),
      effectiveSource: data?.effectiveSource === 'crm' ? 'crm' : 'file',
      productCount: Number(data?.productCount) || 0,
      offerCount: Number(data?.offerCount) || 0,
    };
    priorityDraft.value = data?.settings?.sourcePriority === 'crm' ? 'crm' : 'file';
    pricePrefDraft.value = data?.settings?.pricePreference === 'crm' ? 'crm' : 'file';
  } catch {
    /* ignore */
  }
}

async function fetchMatches() {
  try {
    const { data } = await api.get('/sync/catalog-matches');
    matchOverview.value = {
      matches: Array.isArray(data?.matches) ? data.matches : [],
      matched: Number(data?.matched) || 0,
      unmatchedManual: Array.isArray(data?.unmatchedManual) ? data.unmatchedManual : [],
      crmProductOptions: Array.isArray(data?.crmProductOptions) ? data.crmProductOptions : [],
    };
  } catch {
    /* ignore */
  }
}

async function fetchManualProducts() {
  if (manualMeta.value.productCount <= 0 && !manualSearch.value) {
    manualProducts.value = [];
    manualTotal.value = 0;
    return;
  }
  manualProductsLoading.value = true;
  try {
    const { data } = await api.get('/sync/catalog-manual/products', {
      params: {
        q: manualSearch.value || undefined,
        page: manualPage.value,
        pageSize: manualPageSize,
      },
    });
    manualProducts.value = Array.isArray(data?.products) ? data.products : [];
    manualTotal.value = Number(data?.total) || 0;
  } catch {
    manualProducts.value = [];
  } finally {
    manualProductsLoading.value = false;
  }
}

function debouncedFetchManualProducts() {
  if (manualSearchTimer) clearTimeout(manualSearchTimer);
  manualSearchTimer = setTimeout(() => {
    manualPage.value = 1;
    fetchManualProducts();
  }, 300);
}

function onManualPage(page: number) {
  manualPage.value = page;
  fetchManualProducts();
}

function formatManualPrice(min: number | null, max: number | null): string {
  if (min == null && max == null) return '—';
  if (min == null) return `${max} ₴`;
  if (max == null || min === max) return `${min} ₴`;
  return `${min}–${max} ₴`;
}

function formatOfferLine(o: {
  sku: string | null;
  price: number;
  quantity: number;
  properties: Array<{ name: string; value: string }>;
}): string {
  const variant = o.properties.map((p) => p.value).filter(Boolean).join(', ') || '—';
  const sku = o.sku ? ` · ${o.sku}` : '';
  return `${variant} · ${o.price} ₴ · ${o.quantity} шт${sku}`;
}

async function onCsvSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  importError.value = '';
  importSuccess.value = '';
  importing.value = true;
  importPreview.value = null;
  try {
    const csv = await file.text();
    const { data } = await api.post('/sync/catalog-import', {
      source: importSource.value,
      csv,
    });
    importPreview.value = {
      sessionId: data.sessionId,
      stats: data.stats,
      verify: data.verify,
      sampleProducts: data.sampleProducts ?? [],
    };
  } catch (e: any) {
    importError.value =
      e.response?.data?.error || e.message || 'Не вдалося розпарсити CSV';
  } finally {
    importing.value = false;
  }
}

async function confirmImport(force: boolean) {
  if (!importPreview.value?.sessionId) return;
  confirmingImport.value = true;
  importError.value = '';
  try {
    await api.post('/sync/catalog-import/confirm', {
      sessionId: importPreview.value.sessionId,
      force,
    });
    importSuccess.value = 'Файловий каталог збережено';
    importPreview.value = null;
    await fetchManualMeta();
    await fetchManualProducts();
    await fetchMatches();
  } catch (e: any) {
    importError.value =
      e.response?.data?.error || e.message || 'Не вдалося застосувати імпорт';
  } finally {
    confirmingImport.value = false;
  }
}

async function savePriority(value: unknown) {
  if (value !== 'file' && value !== 'crm') return;
  savingPriority.value = true;
  importError.value = '';
  try {
    const { data } = await api.patch('/sync/catalog-manual/priority', {
      sourcePriority: value,
    });
    priorityDraft.value = data?.settings?.sourcePriority === 'crm' ? 'crm' : 'file';
    manualMeta.value.effectiveSource =
      data?.effectiveSource === 'crm' ? 'crm' : 'file';
    if (data?.settings) {
      manualMeta.value.settings = {
        ...manualMeta.value.settings,
        ...data.settings,
      };
    }
  } catch (e: any) {
    importError.value =
      e.response?.data?.error || 'Не вдалося змінити пріоритет';
    await fetchManualMeta();
  } finally {
    savingPriority.value = false;
  }
}

async function savePricePreference(value: unknown) {
  if (value !== 'file' && value !== 'crm') return;
  savingPriority.value = true;
  importError.value = '';
  try {
    const { data } = await api.patch('/sync/catalog-manual/priority', {
      pricePreference: value,
    });
    pricePrefDraft.value = data?.settings?.pricePreference === 'crm' ? 'crm' : 'file';
    if (data?.settings) {
      manualMeta.value.settings = {
        ...manualMeta.value.settings,
        ...data.settings,
      };
    }
  } catch (e: any) {
    importError.value =
      e.response?.data?.error || 'Не вдалося змінити пріоритет ціни';
    await fetchManualMeta();
  } finally {
    savingPriority.value = false;
  }
}

async function rebuildMatches() {
  rebuildingMatches.value = true;
  try {
    await api.post('/sync/catalog-matches/rebuild');
    await fetchMatches();
    importSuccess.value = 'Matches перераховано';
  } catch (e: any) {
    importError.value = e.response?.data?.error || 'Не вдалося перерахувати matches';
  } finally {
    rebuildingMatches.value = false;
  }
}

async function linkMatch(manualProductId: number) {
  const crmProductId = linkDraft.value[manualProductId];
  if (!crmProductId) return;
  linkingId.value = manualProductId;
  try {
    await api.put('/sync/catalog-matches', { manualProductId, crmProductId });
    linkDraft.value[manualProductId] = null;
    await fetchMatches();
  } catch (e: any) {
    importError.value = e.response?.data?.error || 'Не вдалося звʼязати';
  } finally {
    linkingId.value = null;
  }
}

async function unlinkMatch(manualProductId: number) {
  unlinkingId.value = manualProductId;
  try {
    await api.delete(`/sync/catalog-matches/${manualProductId}`);
    await fetchMatches();
  } catch (e: any) {
    importError.value = e.response?.data?.error || 'Не вдалося відʼязати';
  } finally {
    unlinkingId.value = null;
  }
}

async function clearManual() {
  if (!confirm('Очистити файловий каталог? Агент більше не бачитиме ці товари.')) return;
  clearingManual.value = true;
  try {
    await api.delete('/sync/catalog-manual');
    importPreview.value = null;
    importSuccess.value = 'Файловий каталог очищено';
    await fetchManualMeta();
    manualProducts.value = [];
    manualTotal.value = 0;
  } catch (e: any) {
    importError.value = e.response?.data?.error || 'Не вдалося очистити';
  } finally {
    clearingManual.value = false;
  }
}

function formatPrice(price: number): string {
  if (!Number.isFinite(price)) return '—';
  return `${price} ₴`;
}

function uniqueBranchCount(item: SyncedService): number {
  const ids = new Set<string>();
  for (const row of item.priceRows ?? []) {
    if (row.branchId) ids.add(row.branchId);
  }
  if (ids.size > 0) return ids.size;
  for (const b of item.branchPrices ?? []) {
    if (b.branchId) ids.add(b.branchId);
  }
  return ids.size;
}

function formatServicePriceDisplay(item: SyncedService): string {
  const fromRows = (item.priceRows ?? [])
    .map((r) => r.price)
    .filter((p) => typeof p === 'number' && p > 0);
  if (fromRows.length > 0) {
    const min = Math.min(...fromRows);
    const max = Math.max(...fromRows);
    return min === max ? formatPrice(min) : `${min}–${max} ₴`;
  }
  return formatPrice(item.price);
}

function formatServiceGradeBreakdown(item: SyncedService): string {
  const byName = new Map<string, number>();
  for (const row of item.priceRows ?? []) {
    const name = row.positionName?.trim();
    if (!name || !(row.price > 0)) continue;
    const prev = byName.get(name);
    if (prev == null || row.price > prev) byName.set(name, row.price);
  }
  if (byName.size === 0) return '';
  return [...byName.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], 'uk'))
    .map(([name, price]) => `${name}: ${price}`)
    .join('; ');
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}

async function triggerSync() {
  triggering.value = true;
  error.value = '';
  triggerSuccess.value = '';
  try {
    const { data } = await api.post('/sync/trigger');
    triggerSuccess.value = data.message || 'Синхронізацію запущено';
    await fetchSyncStatus(false);
  } catch (e: any) {
    if (e.response?.status === 409) {
      error.value = `Синхронізація вже виконується (з ${formatDate(e.response.data?.startedAt)})`;
      await fetchSyncStatus(false);
    } else {
      error.value = 'Не вдалося запустити синхронізацію';
    }
  } finally {
    triggering.value = false;
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    fetchSyncStatus(false);
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

watch(isRunning, (running, wasRunning) => {
  if (running) startPolling();
  else {
    stopPolling();
    // Reload services once when a run finishes (running → idle).
    if (wasRunning) fetchServices(false);
  }
});

onMounted(async () => {
  await Promise.all([fetchSyncStatus(), fetchServices(), fetchManualMeta(), fetchMatches()]);
  await fetchManualProducts();
  if (isRunning.value) startPolling();
});

onUnmounted(() => {
  stopPolling();
});
</script>
