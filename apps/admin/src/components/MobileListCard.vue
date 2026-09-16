<template>
  <div
    class="mobile-list-card"
    role="button"
    tabindex="0"
    @click="$emit('click')"
    @keydown.enter.prevent="$emit('click')"
  >
    <div class="mobile-list-card__row">
      <slot name="prepend" />
      <div class="mobile-list-card__body">
        <div v-if="title || $slots.title" class="mobile-list-card__title">
          <slot name="title">{{ title }}</slot>
        </div>
        <div v-if="meta || $slots.meta" class="mobile-list-card__meta">
          <slot name="meta">{{ meta }}</slot>
        </div>
        <div v-if="$slots.chips" class="mobile-list-card__chips">
          <slot name="chips" />
        </div>
      </div>
      <slot name="append" />
    </div>
    <div v-if="$slots.actions" class="mobile-list-card__actions" @click.stop>
      <slot name="actions" />
    </div>
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title?: string;
  meta?: string;
}>();

defineEmits<{
  click: [];
}>();
</script>
