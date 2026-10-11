<template>
  <div class="msg-sources-intro mb-4">
    <v-alert type="warning" variant="tonal" density="comfortable" rounded="lg" class="mb-3">
      <div class="font-weight-bold mb-1">Без каналу з клієнтами агент «глухий»</div>
      <div class="text-body-2">
        Поки не підключено хоча б один канал, бот <strong>не отримує</strong> повідомлення клієнтів
        і <strong>не бачить</strong> відповіді менеджерів з месенджера. Підключіть Instagram —
        це зараз основний шлях, звідки приходять діалоги.
      </div>
    </v-alert>

    <div class="msg-sources-list">
      <button
        v-for="src in sources"
        :key="src.id"
        type="button"
        class="msg-source-row"
        :class="{
          'msg-source-row--active': src.sectionId === activeSectionId,
          'msg-source-row--soon': src.status === 'coming_soon',
        }"
        @click="$emit('select', src.sectionId)"
      >
        <v-icon :icon="src.icon" size="22" class="msg-source-icon" />
        <span class="msg-source-body">
          <span class="msg-source-title">{{ src.title }}</span>
          <span class="msg-source-why">{{ src.whyItMatters }}</span>
        </span>
        <v-chip
          v-if="src.status === 'live'"
          size="small"
          color="success"
          variant="tonal"
        >
          {{ src.sectionId === activeSectionId ? 'Налаштувати' : 'Доступно' }}
        </v-chip>
        <v-chip v-else size="small" color="default" variant="tonal">Скоро</v-chip>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { MESSAGE_SOURCES } from '@/lib/message-sources';

defineProps<{
  activeSectionId?: string;
}>();

defineEmits<{
  select: [sectionId: string];
}>();

const sources = MESSAGE_SOURCES;
</script>

<style scoped>
.msg-sources-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.msg-source-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  min-height: var(--tap-min, 44px);
  text-align: left;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.msg-source-row--active {
  border-color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.04);
}

.msg-source-row--soon {
  opacity: 0.92;
}

.msg-source-icon {
  flex-shrink: 0;
  margin-top: 2px;
}

.msg-source-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.msg-source-title {
  font-weight: 650;
  font-size: 0.9375rem;
  line-height: 1.3;
}

.msg-source-why {
  font-size: 0.75rem;
  line-height: 1.4;
  color: rgba(var(--v-theme-on-surface), 0.65);
}
</style>
