<template>
  <v-container fluid>
    <v-row class="mb-4" align="center">
      <v-col>
        <h1 class="text-h5">Налаштування</h1>
      </v-col>
    </v-row>

    <div v-if="loading" class="d-flex justify-center pa-8">
      <v-progress-circular indeterminate color="primary" />
    </div>

    <template v-else>
      <!-- Working hours -->
      <v-card class="mb-4">
        <v-card-title>Робочі години</v-card-title>
        <v-card-text>
          <v-row
            v-for="(day, index) in workingHours"
            :key="index"
            dense
            align="center"
            class="mb-1"
          >
            <v-col cols="2" sm="1" class="text-body-2 font-weight-medium">
              {{ dayLabels[index] }}
            </v-col>
            <v-col cols="3" sm="2">
              <v-switch
                v-model="day.enabled"
                hide-details
                density="compact"
                color="primary"
              />
            </v-col>
            <v-col cols="3" sm="2">
              <v-text-field
                v-model="day.start"
                label="Початок"
                type="time"
                variant="outlined"
                density="compact"
                hide-details
                :disabled="!day.enabled"
              />
            </v-col>
            <v-col cols="3" sm="2">
              <v-text-field
                v-model="day.end"
                label="Кінець"
                type="time"
                variant="outlined"
                density="compact"
                hide-details
                :disabled="!day.enabled"
              />
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- Out-of-hours template -->
      <v-card class="mb-4">
        <v-card-title>Шаблон відповіді поза робочим часом</v-card-title>
        <v-card-text>
          <v-textarea
            v-model="outOfHoursTemplate"
            variant="outlined"
            rows="4"
            auto-grow
            hide-details
            placeholder="Дякуємо за звернення! Наразі ми не працюємо..."
          />
        </v-card-text>
      </v-card>

      <!-- Handoff keywords -->
      <v-card class="mb-4">
        <v-card-title>Ключові слова для передачі менеджеру</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="handoffKeywords"
            variant="outlined"
            hide-details
            placeholder="менеджер, оператор, людина, скарга"
            hint="Через кому"
            persistent-hint
          />
        </v-card-text>
      </v-card>

      <!-- Feature flags -->
      <v-card class="mb-4">
        <v-card-title>Функціональні налаштування</v-card-title>
        <v-card-text>
          <v-switch
            v-model="featureFlags.auto_handoff"
            label="Автоматична передача менеджеру"
            color="primary"
            hide-details
            class="mb-2"
          />
          <v-switch
            v-model="featureFlags.send_typing_indicator"
            label="Показувати індикатор набору тексту"
            color="primary"
            hide-details
          />
        </v-card-text>
      </v-card>

      <!-- Save button -->
      <v-row>
        <v-col cols="auto">
          <v-btn
            color="primary"
            size="large"
            :loading="saving"
            @click="saveSettings"
          >
            <v-icon start>mdi-content-save</v-icon>
            Зберегти
          </v-btn>
        </v-col>
      </v-row>

      <v-alert v-if="error" type="error" density="compact" class="mt-4">
        {{ error }}
      </v-alert>
      <v-alert v-if="success" type="success" density="compact" class="mt-4">
        Налаштування збережено
      </v-alert>
    </template>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import api from '@/api';

interface DaySchedule {
  enabled: boolean;
  start: string;
  end: string;
}

const dayLabels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];

const loading = ref(false);
const saving = ref(false);
const error = ref('');
const success = ref(false);

const workingHours = ref<DaySchedule[]>(
  Array.from({ length: 7 }, () => ({
    enabled: true,
    start: '09:00',
    end: '18:00',
  })),
);

const outOfHoursTemplate = ref('');
const handoffKeywords = ref('');
const featureFlags = ref({
  auto_handoff: true,
  send_typing_indicator: true,
});

async function fetchSettings() {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/settings');

    if (data.working_hours) {
      workingHours.value = data.working_hours;
    }
    if (data.out_of_hours_template !== undefined) {
      outOfHoursTemplate.value = data.out_of_hours_template;
    }
    if (data.handoff_keywords) {
      handoffKeywords.value = Array.isArray(data.handoff_keywords)
        ? data.handoff_keywords.join(', ')
        : data.handoff_keywords;
    }
    if (data.feature_flags) {
      featureFlags.value = {
        ...featureFlags.value,
        ...data.feature_flags,
      };
    }
  } catch (e) {
    error.value = 'Не вдалося завантажити налаштування';
  } finally {
    loading.value = false;
  }
}

async function saveSettings() {
  saving.value = true;
  error.value = '';
  success.value = false;
  try {
    await api.put('/settings', {
      working_hours: workingHours.value,
      out_of_hours_template: outOfHoursTemplate.value,
      handoff_keywords: handoffKeywords.value
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
      feature_flags: featureFlags.value,
    });
    success.value = true;
    setTimeout(() => {
      success.value = false;
    }, 3000);
  } catch (e) {
    error.value = 'Не вдалося зберегти налаштування';
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  fetchSettings();
});
</script>
