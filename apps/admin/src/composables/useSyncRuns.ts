import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import api from '@/api';
import { type SyncRun, formatDate } from '@/components/sync/sync-labels';

const POLL_INTERVAL_MS = 3_000;

export function useSyncRuns(opts?: { onRunFinished?: () => void }) {
  const runs = ref<SyncRun[]>([]);
  const loading = ref(false);
  const triggering = ref(false);
  const error = ref('');
  const triggerSuccess = ref('');

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const latestRun = computed<SyncRun | null>(() => runs.value[0] ?? null);
  const isRunning = computed(() => latestRun.value?.status === 'running');
  const latestOkRun = computed(() => runs.value.find((r) => r.status === 'ok') ?? null);

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
      void fetchSyncStatus(false);
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
      if (wasRunning) opts?.onRunFinished?.();
    }
  });

  onMounted(() => {
    if (isRunning.value) startPolling();
  });

  onUnmounted(() => {
    stopPolling();
  });

  return {
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
  };
}
