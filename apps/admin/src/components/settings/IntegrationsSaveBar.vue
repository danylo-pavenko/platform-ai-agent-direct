<template>
  <v-row class="mb-2 mt-2">
    <v-col cols="auto">
      <v-btn
        color="primary"
        size="large"
        :loading="saving"
        @click="$emit('save')"
      >
        <v-icon start>mdi-content-save</v-icon>
        Зберегти інтеграції
      </v-btn>
    </v-col>
    <v-col cols="auto" class="d-flex align-center">
      <v-chip
        v-if="saved"
        color="success"
        size="small"
        prepend-icon="mdi-check"
      >
        Збережено - перезапустіть сервер
      </v-chip>
    </v-col>
  </v-row>
</template>

<script setup lang="ts">
defineProps<{
  saving?: boolean;
  saved?: boolean;
}>();

defineEmits<{
  save: [];
}>();
</script>
