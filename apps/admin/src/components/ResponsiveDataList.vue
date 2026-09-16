<template>
  <div class="responsive-data-list">
    <div v-if="mdAndUp" class="responsive-data-list__table">
      <slot name="table" />
    </div>
    <div v-else class="responsive-data-list__cards mobile-list-stack">
      <div v-if="loading" class="d-flex justify-center py-8">
        <v-progress-circular indeterminate color="primary" />
      </div>
      <template v-else>
        <slot name="cards" />
        <div
          v-if="empty"
          class="text-center text-medium-emphasis py-8 text-body-2"
        >
          {{ emptyText }}
        </div>
      </template>
    </div>
    <div
      v-if="showPagination"
      class="d-flex align-center justify-space-between flex-wrap ga-2 mt-3 px-1"
    >
      <div class="text-caption text-medium-emphasis">
        {{ paginationLabel }}
      </div>
      <div class="d-flex align-center ga-1">
        <v-btn
          icon
          variant="text"
          class="tap-target"
          :disabled="page <= 1 || loading"
          @click="emit('update:page', page - 1)"
        >
          <v-icon>mdi-chevron-left</v-icon>
        </v-btn>
        <span class="text-body-2">{{ page }}</span>
        <v-btn
          icon
          variant="text"
          class="tap-target"
          :disabled="page * itemsPerPage >= itemsLength || loading"
          @click="emit('update:page', page + 1)"
        >
          <v-icon>mdi-chevron-right</v-icon>
        </v-btn>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useDisplay } from 'vuetify';

const props = withDefaults(
  defineProps<{
    loading?: boolean;
    empty?: boolean;
    emptyText?: string;
    page?: number;
    itemsPerPage?: number;
    itemsLength?: number;
    showPagination?: boolean;
  }>(),
  {
    loading: false,
    empty: false,
    emptyText: 'Немає записів',
    page: 1,
    itemsPerPage: 20,
    itemsLength: 0,
    showPagination: false,
  },
);

const emit = defineEmits<{
  'update:page': [page: number];
}>();

const { mdAndUp } = useDisplay();

const paginationLabel = computed(() => {
  if (!props.itemsLength) return '0 записів';
  const start = (props.page - 1) * props.itemsPerPage + 1;
  const end = Math.min(props.page * props.itemsPerPage, props.itemsLength);
  return `${start}–${end} з ${props.itemsLength}`;
});
</script>
