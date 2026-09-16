<template>
  <div class="sticky-action-bar" :class="{ 'sticky-action-bar--stack': stack }">
    <slot />
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    /** Full-width stacked buttons on mobile. */
    stack?: boolean;
  }>(),
  { stack: true },
);
</script>
