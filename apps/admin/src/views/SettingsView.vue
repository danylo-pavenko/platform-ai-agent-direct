<template>
  <v-container fluid>
    <v-row class="mb-4" align="center">
      <v-col>
        <div class="page-title">Налаштування</div>
      </v-col>
    </v-row>

    <div v-if="loading" class="d-flex justify-center pa-8">
      <v-progress-circular indeterminate color="primary" />
    </div>

    <template v-else>
      <!-- AI Agent mode -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start color="primary">mdi-robot</v-icon>
          Режим роботи AI-агента
        </v-card-title>
        <v-card-text>
          <v-alert type="info" variant="tonal" density="compact" class="mb-4">
            AI-агент може працювати <strong>24/7</strong> без перерв. Робочі години впливають лише на те,
            чи відповідає бот автоматично, чи надсилає шаблон "ми зараз не працюємо".
          </v-alert>

          <v-radio-group v-model="agentMode" @update:model-value="onModeChange">
            <v-radio value="24_7">
              <template #label>
                <div>
                  <strong>24/7 — Агент відповідає завжди</strong>
                  <div class="text-caption text-medium-emphasis">
                    Бот обробляє повідомлення цілодобово. Клієнти отримують відповідь миттєво в будь-який час.
                  </div>
                </div>
              </template>
            </v-radio>
            <v-radio value="schedule" class="mt-2">
              <template #label>
                <div>
                  <strong>За розкладом — Агент працює у робочі години</strong>
                  <div class="text-caption text-medium-emphasis">
                    Поза робочими годинами клієнти отримують шаблонне повідомлення.
                    Якщо розмова вже активна (повідомлення за останні 30 хв) — бот продовжує відповідати.
                  </div>
                </div>
              </template>
            </v-radio>
          </v-radio-group>
        </v-card-text>
      </v-card>

      <!-- Working hours (shown only in schedule mode) -->
      <v-card v-if="agentMode === 'schedule'" class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start>mdi-clock-outline</v-icon>
          Робочі години
        </v-card-title>
        <v-card-subtitle class="pb-2">
          Графік, коли бот відповідає автоматично. Поза цими годинами — надсилає шаблон.
        </v-card-subtitle>
        <v-card-text>
          <v-row
            v-for="day in days"
            :key="day.key"
            dense
            align="center"
            class="mb-1"
          >
            <v-col cols="12" sm="2" class="text-body-1 font-weight-medium">
              {{ day.label }}
            </v-col>
            <v-col cols="4" sm="2">
              <v-switch
                v-model="workingHours[day.key].enabled"
                :label="workingHours[day.key].enabled ? 'Працює' : 'Вихідний'"
                hide-details
                density="compact"
                color="primary"
              />
            </v-col>
            <v-col cols="3" sm="2">
              <v-text-field
                v-model="workingHours[day.key].start"
                label="Початок"
                type="time"
                variant="outlined"
                density="compact"
                hide-details
                :disabled="!workingHours[day.key].enabled"
              />
            </v-col>
            <v-col cols="1" sm="1" class="text-center text-body-2">—</v-col>
            <v-col cols="3" sm="2">
              <v-text-field
                v-model="workingHours[day.key].end"
                label="Кінець"
                type="time"
                variant="outlined"
                density="compact"
                hide-details
                :disabled="!workingHours[day.key].enabled"
              />
            </v-col>
            <v-col v-if="workingHours[day.key].enabled" cols="12" sm="3" class="text-caption text-medium-emphasis">
              {{ hoursPerDay(workingHours[day.key]) }}
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- Out-of-hours template -->
      <v-card v-if="agentMode === 'schedule'" class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start>mdi-message-text-clock</v-icon>
          Повідомлення поза робочим часом
        </v-card-title>
        <v-card-subtitle class="pb-2">
          Текст, який отримає клієнт, якщо напише поза робочими годинами (і розмова не була активна останні 30 хв).
        </v-card-subtitle>
        <v-card-text>
          <v-textarea
            v-model="outOfHoursTemplate"
            variant="outlined"
            rows="3"
            auto-grow
            hide-details
            placeholder="Дякуємо за повідомлення! Зараз ми не на зв'язку. Відповімо вам у робочий час."
          />
        </v-card-text>
      </v-card>

      <!-- Handoff keywords -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start>mdi-account-switch</v-icon>
          Передача менеджеру
        </v-card-title>
        <v-card-subtitle class="pb-2">
          Ключові слова, при яких бот автоматично передає розмову менеджеру. AI-агент також сам визначає потребу в ескалації.
        </v-card-subtitle>
        <v-card-text>
          <v-text-field
            v-model="handoffKeywords"
            variant="outlined"
            hide-details
            placeholder="менеджер, оператор, людина, скарга, повернення"
          />
          <div class="text-caption text-medium-emphasis mt-1">Через кому. Приклад: менеджер, оператор, людина, скарга</div>
        </v-card-text>
      </v-card>

      <!-- Feature flags -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start>mdi-toggle-switch</v-icon>
          Додаткові опції
        </v-card-title>
        <v-card-text>
          <v-switch
            v-model="featureFlags.auto_handoff"
            color="primary"
            hide-details
            class="mb-3"
          >
            <template #label>
              <div>
                <strong>Автоматична ескалація</strong>
                <div class="text-caption text-medium-emphasis">
                  Бот сам вирішує, коли передати розмову менеджеру (скарга, брак, невпевненість у відповіді).
                </div>
              </div>
            </template>
          </v-switch>
          <v-switch
            v-model="featureFlags.send_typing_indicator"
            color="primary"
            hide-details
          >
            <template #label>
              <div>
                <strong>Індикатор набору</strong>
                <div class="text-caption text-medium-emphasis">
                  Показувати "друкує..." в Instagram, поки бот формує відповідь.
                </div>
              </div>
            </template>
          </v-switch>
        </v-card-text>
      </v-card>

      <!-- Save button -->
      <v-row class="mb-8">
        <v-col cols="auto">
          <v-btn
            color="primary"
            size="large"
            :loading="saving"
            @click="saveSettings"
          >
            <v-icon start>mdi-content-save</v-icon>
            Зберегти налаштування
          </v-btn>
        </v-col>
      </v-row>

      <v-alert v-if="error" type="error" density="compact" class="mb-4">
        {{ error }}
      </v-alert>
      <v-snackbar v-model="success" color="success" :timeout="3000">
        Налаштування збережено
      </v-snackbar>
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

type WorkingHoursMap = Record<string, DaySchedule>;

const days = [
  { key: 'mon', label: 'Понеділок' },
  { key: 'tue', label: 'Вівторок' },
  { key: 'wed', label: 'Середа' },
  { key: 'thu', label: 'Четвер' },
  { key: 'fri', label: "П'ятниця" },
  { key: 'sat', label: 'Субота' },
  { key: 'sun', label: 'Неділя' },
];

const loading = ref(false);
const saving = ref(false);
const error = ref('');
const success = ref(false);

const agentMode = ref<'24_7' | 'schedule'>('schedule');

const workingHours = ref<WorkingHoursMap>({
  mon: { start: '09:00', end: '20:00', enabled: true },
  tue: { start: '09:00', end: '20:00', enabled: true },
  wed: { start: '09:00', end: '20:00', enabled: true },
  thu: { start: '09:00', end: '20:00', enabled: true },
  fri: { start: '09:00', end: '20:00', enabled: true },
  sat: { start: '10:00', end: '18:00', enabled: true },
  sun: { start: '10:00', end: '18:00', enabled: false },
});

const outOfHoursTemplate = ref(
  "Дякуємо за повідомлення! Зараз ми не на зв'язку. Відповімо вам у робочий час.",
);
const handoffKeywords = ref('');
const featureFlags = ref({
  auto_handoff: true,
  send_typing_indicator: false,
});

function hoursPerDay(day: DaySchedule): string {
  if (!day.enabled || !day.start || !day.end) return '';
  const [sh, sm] = day.start.split(':').map(Number);
  const [eh, em] = day.end.split(':').map(Number);
  const diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff <= 0) return '';
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return m > 0 ? `${h} год ${m} хв` : `${h} год`;
}

function onModeChange(mode: '24_7' | 'schedule' | null) {
  if (!mode) return;
  if (mode === '24_7') {
    // Enable all days, 00:00–23:59
    for (const day of days) {
      workingHours.value[day.key] = { start: '00:00', end: '23:59', enabled: true };
    }
  }
}

async function fetchSettings() {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/settings');

    if (data.working_hours && typeof data.working_hours === 'object') {
      workingHours.value = { ...workingHours.value, ...data.working_hours };

      // Detect 24/7 mode: all days enabled 00:00–23:59
      const all247 = days.every((d) => {
        const h = workingHours.value[d.key];
        return h && h.enabled && h.start === '00:00' && h.end === '23:59';
      });
      agentMode.value = all247 ? '24_7' : 'schedule';
    }

    if (typeof data.out_of_hours_template === 'string') {
      outOfHoursTemplate.value = data.out_of_hours_template;
    }

    if (data.handoff_keywords) {
      handoffKeywords.value = Array.isArray(data.handoff_keywords)
        ? data.handoff_keywords.join(', ')
        : String(data.handoff_keywords);
    }

    if (data.feature_flags && typeof data.feature_flags === 'object') {
      featureFlags.value = { ...featureFlags.value, ...data.feature_flags };
    }
  } catch {
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
        .map((k: string) => k.trim())
        .filter(Boolean),
      feature_flags: featureFlags.value,
    });
    success.value = true;
  } catch {
    error.value = 'Не вдалося зберегти налаштування';
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  fetchSettings();
});
</script>
