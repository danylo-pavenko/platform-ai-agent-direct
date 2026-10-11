import { ref, computed } from 'vue';
import api from '@/api';

export type ManualProduct = {
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
};

export type ImportPreview = {
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
};

export function useCatalogManual() {
  const importSource = ref<'shop_express'>('shop_express');
  const importSourceItems = [{ title: 'Shop-Express (Engine)', value: 'shop_express' }];
  const importing = ref(false);
  const confirmingImport = ref(false);
  const clearingManual = ref(false);
  const savingPriority = ref(false);
  const importError = ref('');
  const importSuccess = ref('');
  const forceImport = ref(false);
  const importPreview = ref<ImportPreview | null>(null);

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

  const manualProducts = ref<ManualProduct[]>([]);
  const manualProductsLoading = ref(false);
  const manualSearch = ref('');
  const manualPage = ref(1);
  const manualPageSize = 25;
  const manualTotal = ref(0);
  let manualSearchTimer: ReturnType<typeof setTimeout> | null = null;

  const crmLinkItems = computed(() =>
    matchOverview.value.crmProductOptions.map((p) => ({
      title: `${p.name} (${p.minPrice ?? '—'}₴) [#${p.id}]`,
      value: p.id,
    })),
  );

  const enrichedMatches = computed(() => matchOverview.value.matches);

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
      void fetchManualProducts();
    }, 300);
  }

  function onManualPage(page: number) {
    manualPage.value = page;
    void fetchManualProducts();
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
      if (e.response?.status === 413) {
        importError.value =
          e.response?.data?.error ||
          'Файл завеликий для сервера (nginx 413). Макс. ~50 МБ CSV — зменшіть файл або підніміть client_max_body_size і перезавантажте nginx.';
      } else {
        importError.value =
          e.response?.data?.error || e.message || 'Не вдалося розпарсити CSV';
      }
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
      importError.value = e.response?.data?.error || 'Не вдалося змінити пріоритет';
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
      importError.value = e.response?.data?.error || 'Не вдалося змінити пріоритет ціни';
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

  return {
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
  };
}
