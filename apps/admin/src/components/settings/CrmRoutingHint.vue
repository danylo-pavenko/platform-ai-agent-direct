<template>
  <v-alert type="info" variant="tonal" density="compact" class="mb-3 text-body-2">
    <div>
      За замовчуванням один CRM обслуговує всі дії. Якщо підключено кілька, маршрути задаються окремо.
    </div>
    <v-btn
      variant="text"
      color="indigo"
      class="px-1 text-none"
      prepend-icon="mdi-routes"
      style="min-height: 44px"
      @click="emit('open-routing')"
    >
      Відкрити CRM routing
    </v-btn>
  </v-alert>
</template>

<script setup lang="ts">
const emit = defineEmits<{ 'open-routing': [] }>();
</script>
