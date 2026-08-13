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
    <v-col cols="auto">
      <v-btn
        color="orange-darken-2"
        variant="tonal"
        size="large"
        :loading="restarting"
        :disabled="restarting"
        @click="$emit('restart')"
      >
        <v-icon start>mdi-restart</v-icon>
        Перезапустити додатки
      </v-btn>
    </v-col>
    <v-col cols="auto" class="d-flex align-center">
      <v-chip
        v-if="saved"
        color="success"
        size="small"
        prepend-icon="mdi-check"
      >
        Збережено
      </v-chip>
      <span
        v-if="saved"
        class="text-caption text-medium-emphasis ml-2"
      >
        Більшість змін з БД підхоплюються одразу. Якщо щось не оновилось — перезапустіть додатки.
      </span>
    </v-col>
  </v-row>
</template>

<script setup lang="ts">
defineProps<{
  saving?: boolean;
  saved?: boolean;
  restarting?: boolean;
}>();

defineEmits<{
  save: [];
  restart: [];
}>();
</script>
