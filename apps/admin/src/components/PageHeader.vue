<template>
  <header class="page-header mb-4 mb-md-6" :class="{ 'page-header--compact': compact }">
    <div class="page-header-text min-width-0">
      <h1 class="page-title">{{ title }}</h1>
      <p v-if="subtitle" class="page-subtitle">{{ subtitle }}</p>
      <slot name="subtitle" />
    </div>
    <div v-if="$slots.actions" class="page-header-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    compact?: boolean;
  }>(),
  { subtitle: undefined, compact: false },
);
</script>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.page-header-text {
  flex: 1 1 auto;
  min-width: 0;
}

.page-header-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.min-width-0 {
  min-width: 0;
}

@media (max-width: 600px) {
  .page-header--compact .page-subtitle {
    font-size: 12px;
  }
}
</style>
