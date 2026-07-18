<template>
  <v-card id="settings-telegram" class="mb-4">
    <v-card-title class="d-flex align-center flex-wrap ga-2">
      <v-icon start color="blue">mdi-send</v-icon>
      <span>Telegram боти</span>
      <v-chip size="small" variant="tonal" color="blue">{{ bots.length }}</v-chip>
    </v-card-title>
    <v-card-subtitle class="pb-2">
      Кілька ботів зі своїми ролями: куди слати ескалації, ліди, замовлення чи системні алерти.
      Основний бот — fallback і interactive (/login, кнопки takeover).
    </v-card-subtitle>

    <v-card-text>
      <v-btn
        variant="text"
        size="small"
        color="info"
        class="mb-3 px-1"
        :prepend-icon="showHelp ? 'mdi-chevron-up' : 'mdi-help-circle-outline'"
        @click="showHelp = !showHelp"
      >
        Де взяти дані та як підключити ботів? Натисни тут.
      </v-btn>
      <v-expand-transition>
        <v-alert v-if="showHelp" type="info" variant="tonal" density="compact" class="mb-4 text-body-2">
          <ol class="pl-4 mb-2" style="line-height:1.8;">
            <li>
              Створіть бота в
              <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a>
              → скопіюйте Bot Token.
            </li>
            <li>
              Для кожного бота задайте <strong>опис ролі</strong> (текст для мета-агента / промпту)
              і відмітьте <strong>типи сповіщень</strong>.
            </li>
            <li>
              Один бот має бути <strong>основним</strong> — на нього йдуть типи без явного маршруту,
              і він обробляє <code>/login</code> + кнопки в сповіщеннях.
            </li>
            <li>
              Після збереження: <code>/login</code> у відповідному боті або вкажіть Manager Group ID.
            </li>
          </ol>
        </v-alert>
      </v-expand-transition>

      <div v-for="(bot, idx) in bots" :key="bot.id" class="bot-card mb-4 pa-3">
        <div class="d-flex align-center flex-wrap ga-2 mb-3">
          <v-text-field
            v-model="bot.label"
            label="Назва бота"
            variant="outlined"
            density="compact"
            hide-details
            class="bot-label-field"
          />
          <v-switch
            v-model="bot.enabled"
            label="Увімкнений"
            color="primary"
            density="compact"
            hide-details
          />
          <v-radio-group
            :model-value="bot.isPrimary ? bot.id : null"
            hide-details
            density="compact"
            class="ma-0"
            @update:model-value="setPrimary(bot.id)"
          >
            <v-radio label="Основний" :value="bot.id" color="primary" density="compact" />
          </v-radio-group>
          <v-spacer />
          <v-btn
            v-if="bots.length > 1"
            icon="mdi-delete-outline"
            variant="text"
            color="error"
            size="small"
            :disabled="bot.isPrimary"
            @click="removeBot(idx)"
          />
        </div>

        <v-textarea
          v-model="bot.rolePrompt"
          label="Опис ролі / промпт (що сюди слати)"
          placeholder="Напр.: бот для гарячих лідів салону; системні помилки Claude сюди не слати"
          variant="outlined"
          density="compact"
          rows="2"
          auto-grow
          class="mb-3"
          hint="Бачать мета-агент і системний промпт (без токенів)"
          persistent-hint
        />

        <v-row dense class="mb-2">
          <v-col cols="12" md="6">
            <v-text-field
              v-model="bot.botToken"
              label="Bot Token"
              variant="outlined"
              density="compact"
              hide-details
              :type="showToken[bot.id] ? 'text' : 'password'"
              :append-inner-icon="showToken[bot.id] ? 'mdi-eye-off' : 'mdi-eye'"
              placeholder="123456:ABC-DEF..."
              @click:append-inner="showToken[bot.id] = !showToken[bot.id]"
            />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field
              v-model="bot.managerGroupId"
              label="Manager Group ID"
              variant="outlined"
              density="compact"
              hide-details
              placeholder="-100…"
            />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field
              v-model="bot.adminPassword"
              label="Admin Password (/login)"
              variant="outlined"
              density="compact"
              hide-details
              :type="showPassword[bot.id] ? 'text' : 'password'"
              :append-inner-icon="showPassword[bot.id] ? 'mdi-eye-off' : 'mdi-eye'"
              @click:append-inner="showPassword[bot.id] = !showPassword[bot.id]"
            />
          </v-col>
        </v-row>

        <div class="text-caption text-medium-emphasis mb-2">Типи сповіщень</div>
        <v-chip-group v-model="bot.channels" multiple column selected-class="text-primary">
          <v-chip
            v-for="ch in channelOptions"
            :key="ch.value"
            :value="ch.value"
            filter
            variant="outlined"
            size="small"
          >
            {{ ch.label }}
          </v-chip>
        </v-chip-group>
      </div>

      <div class="d-flex flex-wrap align-center ga-2 mt-2">
        <v-btn
          color="primary"
          variant="tonal"
          size="small"
          prepend-icon="mdi-plus"
          @click="addBot"
        >
          Додати бота
        </v-btn>
        <v-btn
          color="primary"
          variant="flat"
          size="small"
          prepend-icon="mdi-content-save"
          :loading="saving"
          @click="commitAndSave"
        >
          Зберегти Telegram
        </v-btn>
        <slot name="actions" />
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue';

export type TelegramNotifyChannel =
  | 'handoff'
  | 'order'
  | 'brief'
  | 'agent_failure'
  | 'crm_fallback'
  | 'auth'
  | 'ops';

export interface TelegramBotForm {
  id: string;
  label: string;
  rolePrompt: string;
  botToken: string;
  adminPassword: string;
  managerGroupId: string;
  enabled: boolean;
  isPrimary: boolean;
  channels: TelegramNotifyChannel[];
}

const ALL_CHANNELS: TelegramNotifyChannel[] = [
  'handoff',
  'order',
  'brief',
  'agent_failure',
  'crm_fallback',
  'auth',
  'ops',
];

const channelOptions = [
  { value: 'handoff' as const, label: 'Ескалації' },
  { value: 'order' as const, label: 'Замовлення' },
  { value: 'brief' as const, label: 'Ліди / брифи' },
  { value: 'agent_failure' as const, label: 'Помилки агента' },
  { value: 'crm_fallback' as const, label: 'CRM down' },
  { value: 'auth' as const, label: 'Auth / ліміти' },
  { value: 'ops' as const, label: 'Системні / тести' },
];

const props = defineProps<{
  modelValue: TelegramBotForm[];
  saving?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: TelegramBotForm[]];
  save: [];
}>();

/** Local draft — edits stay here until Save (no parent re-render on keystroke). */
const bots = ref<TelegramBotForm[]>(normalizeIncoming(props.modelValue));
const showHelp = ref(false);
const showToken = reactive<Record<string, boolean>>({});
const showPassword = reactive<Record<string, boolean>>({});

// Sync from parent only when the array reference changes (e.g. after fetch/save),
 // not on every deep mutation — avoids dual deep-watch feedback loops.
watch(
  () => props.modelValue,
  (v) => {
    bots.value = normalizeIncoming(v);
  },
);

function normalizeIncoming(list: TelegramBotForm[] | undefined): TelegramBotForm[] {
  if (!list || list.length === 0) {
    return [
      {
        id: crypto.randomUUID(),
        label: 'Основний бот',
        rolePrompt:
          'Основний бот для сповіщень менеджерам: ескалації, замовлення, ліди, системні алерти.',
        botToken: '',
        adminPassword: '',
        managerGroupId: '',
        enabled: true,
        isPrimary: true,
        channels: [...ALL_CHANNELS],
      },
    ];
  }
  const copy = list.map((b) => ({
    ...b,
    channels: b.channels?.length ? [...b.channels] : [...ALL_CHANNELS],
  }));
  if (!copy.some((b) => b.isPrimary)) {
    copy[0]!.isPrimary = true;
  }
  return copy;
}

function snapshotBots(): TelegramBotForm[] {
  return bots.value.map((b) => ({
    ...b,
    channels: [...b.channels],
  }));
}

function setPrimary(id: string) {
  for (const b of bots.value) {
    b.isPrimary = b.id === id;
  }
}

function addBot() {
  bots.value.push({
    id: crypto.randomUUID(),
    label: `Бот ${bots.value.length + 1}`,
    rolePrompt: '',
    botToken: '',
    adminPassword: '',
    managerGroupId: '',
    enabled: true,
    isPrimary: false,
    channels: ['brief', 'order'],
  });
}

function removeBot(idx: number) {
  const bot = bots.value[idx];
  if (!bot || bot.isPrimary) return;
  bots.value.splice(idx, 1);
}

function commitAndSave() {
  emit('update:modelValue', snapshotBots());
  emit('save');
}
</script>

<style scoped>
.bot-card {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 10px;
  background: rgba(var(--v-theme-surface), 1);
}

.bot-label-field {
  max-width: 220px;
}
</style>
