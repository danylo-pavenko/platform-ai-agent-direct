import { ref, computed } from 'vue';
import api from '@/api';
import { filterSyncedServices } from '@/components/sync/sync-flow';
import { type SyncedService } from '@/components/sync/sync-labels';

export function useSyncServices() {
  const services = ref<SyncedService[]>([]);
  const servicesCount = ref(0);
  const servicesSyncedAt = ref<string | null>(null);
  const servicesLoading = ref(false);
  const servicesSearch = ref('');

  const filteredServices = computed(() =>
    filterSyncedServices(services.value, servicesSearch.value),
  );

  async function fetchServices(showLoader = true) {
    if (showLoader) servicesLoading.value = true;
    try {
      const { data } = await api.get('/sync/services');
      services.value = Array.isArray(data?.services) ? data.services : [];
      servicesCount.value =
        typeof data?.count === 'number' ? data.count : services.value.length;
      servicesSyncedAt.value = typeof data?.syncedAt === 'string' ? data.syncedAt : null;
    } catch {
      /* keep previous snapshot */
    } finally {
      if (showLoader) servicesLoading.value = false;
    }
  }

  return {
    services,
    servicesCount,
    servicesSyncedAt,
    servicesLoading,
    servicesSearch,
    filteredServices,
    fetchServices,
  };
}
