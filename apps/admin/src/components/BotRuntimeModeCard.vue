<template>
  <section
    class="bot-mode-card"
    :class="[
      `bot-mode-card--${variant}`,
      isPublic ? 'bot-mode-card--public' : 'bot-mode-card--debug',
    ]"
    aria-labelledby="bot-mode-title"
  >
    <div class="bot-mode-head">
      <div class="bot-mode-head-text">
        <h2 id="bot-mode-title" class="bot-mode-title">
          <v-icon
            :icon="isPublic ? 'mdi-earth' : 'mdi-shield-account-outline'"
            size="22"
            class="bot-mode-title-icon"
          />
          Кому зараз відповідає бот
        </h2>
        <p class="bot-mode-lead">
          Швидке перемикання: якщо щось пішло не так — увімкніть «Лише тест», щоб бот
          тимчасово не відповідав усім клієнтам у Instagram.
        </p>
      </div>
      <div class="bot-mode-status-row">
        <v-chip
          size="small"
          :color="isPublic ? 'success' : 'warning'"
          variant="flat"
          class="bot-mode-chip"
        >
          {{ isPublic ? 'Для всіх клієнтів' : 'Лише тест' }}
        </v-chip>
        <v-chip
          v-if="saveState === 'saving'"
          size="small"
          color="primary"
          variant="tonal"
          prepend-icon="mdi-content-save-outline"
        >
          Зберігаю…
        </v-chip>
        <v-chip
          v-else-if="saveState === 'saved'"
          size="small"
          color="success"
          variant="tonal"
          prepend-icon="mdi-check"
        >
          Збережено
        </v-chip>
        <v-chip
          v-else-if="saveState === 'error'"
          size="small"
          color="error"
          variant="tonal"
          prepend-icon="mdi-alert-circle-outline"
        >
          Помилка
        </v-chip>
      </div>
    </div>

    <v-alert
      v-if="loadError"
      type="error"
      variant="tonal"
      density="compact"
      class="mb-3"
      rounded="lg"
    >
      {{ loadError }}
    </v-alert>

    <div v-else-if="loading" class="bot-mode-loading text-medium-emphasis">
      Завантаження режиму…
    </div>

    <div v-else class="bot-mode-options" role="radiogroup" aria-label="Режим відповіді бота">
      <button
        type="button"
        class="bot-mode-option"
        :class="{ 'bot-mode-option--active': isPublic }"
        role="radio"
        :aria-checked="isPublic"
        :disabled="saving"
        @click="selectMode('public')"
      >
        <span class="bot-mode-option-icon" aria-hidden="true">
          <v-icon icon="mdi-earth" size="28" />
        </span>
        <span class="bot-mode-option-body">
          <span class="bot-mode-option-title">Для всіх клієнтів</span>
          <span class="bot-mode-option-desc">
            Бот відповідає кожному, хто пише в Instagram. Увімкніть, коли агент
            готовий працювати з реальними клієнтами.
          </span>
        </span>
        <span class="bot-mode-option-check" aria-hidden="true">
          <v-icon v-if="isPublic" icon="mdi-check-circle" color="success" size="22" />
          <v-icon v-else icon="mdi-circle-outline" size="22" class="text-medium-emphasis" />
        </span>
      </button>

      <button
        type="button"
        class="bot-mode-option"
        :class="{ 'bot-mode-option--active': !isPublic }"
        role="radio"
        :aria-checked="!isPublic"
        :disabled="saving"
        @click="selectMode('debug')"
      >
        <span class="bot-mode-option-icon bot-mode-option-icon--warn" aria-hidden="true">
          <v-icon icon="mdi-shield-account-outline" size="28" />
        </span>
        <span class="bot-mode-option-body">
          <span class="bot-mode-option-title">Лише тест</span>
          <span class="bot-mode-option-desc">
            Бот відповідає тільки обраним акаунтам (наприклад, вашим тестовим).
            Інші клієнти відповіді від бота не отримають — зручно під час налаштування
            або якщо потрібно швидко «приглушити» агента.
          </span>
        </span>
        <span class="bot-mode-option-check" aria-hidden="true">
          <v-icon v-if="!isPublic" icon="mdi-check-circle" color="warning" size="22" />
          <v-icon v-else icon="mdi-circle-outline" size="22" class="text-medium-emphasis" />
        </span>
      </button>
    </div>

    <v-alert
      v-if="!loading && !isPublic"
      type="warning"
      variant="tonal"
      density="comfortable"
      class="mt-3"
      rounded="lg"
    >
      <template v-if="whitelistCount > 0">
        Зараз бот відповідає
        <strong>{{ whitelistCount }}</strong>
        {{ whitelistWord }}:
        <span class="bot-mode-handles">{{ whitelistPreview }}</span>
      </template>
      <template v-else>
        Список тестових акаунтів порожній — бот зараз нікому не відповідає.
      </template>
      <div class="mt-2">
        <RouterLink class="bot-mode-link" :to="{ name: 'settings', hash: '#settings-runtime' }">
          Налаштувати список і чорний список →
        </RouterLink>
      </div>
    </v-alert>

    <p v-else-if="!loading && isPublic" class="bot-mode-foot">
      Потрібно додати когось у «не відповідати» або змінити тестовий список?
      <RouterLink class="bot-mode-link" :to="{ name: 'settings', hash: '#settings-runtime' }">
        Відкрити повні налаштування режиму
      </RouterLink>
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import api from '@/api';

export type RuntimeModeValue = 'public' | 'debug';

withDefaults(
  defineProps<{
    /** dashboard = prominent card on home; settings = same control if reused later */
    variant?: 'dashboard' | 'settings';
  }>(),
  { variant: 'dashboard' },
);

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const mode = ref<RuntimeModeValue>('public');
const debugWhitelist = ref<string[]>([]);
const botIgnoreUsernames = ref<string[]>([]);
const backfillLimit = ref(200);

const loading = ref(true);
const loadError = ref('');
const saveState = ref<SaveState>('idle');
const saving = computed(() => saveState.value === 'saving');

const isPublic = computed(() => mode.value === 'public');
const whitelistCount = computed(() => debugWhitelist.value.length);

const whitelistWord = computed(() => {
  const n = whitelistCount.value;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'акаунту';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'акаунтам';
  return 'акаунтам';
});

const whitelistPreview = computed(() => {
  const tags = debugWhitelist.value.slice(0, 4).map((h) => `@${h}`);
  const extra = debugWhitelist.value.length - tags.length;
  return extra > 0 ? `${tags.join(', ')} +${extra}` : tags.join(', ');
});

function normalizeHandles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const h = v.trim().replace(/^@+/, '').toLowerCase();
    if (h && !seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  return out;
}

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const { data } = await api.get('/settings');
    const raw = data?.runtime_mode;
    if (raw && typeof raw === 'object') {
      mode.value = raw.mode === 'debug' ? 'debug' : 'public';
      debugWhitelist.value = normalizeHandles(raw.debugWhitelist);
      botIgnoreUsernames.value = normalizeHandles(raw.botIgnoreUsernames);
      if (typeof raw.backfillLimit === 'number' && raw.backfillLimit > 0) {
        backfillLimit.value = Math.min(500, Math.floor(raw.backfillLimit));
      }
    }
  } catch {
    loadError.value = 'Не вдалося завантажити режим бота';
  } finally {
    loading.value = false;
  }
}

async function selectMode(next: RuntimeModeValue) {
  if (loading.value || saving.value || mode.value === next) return;
  const prev = mode.value;
  mode.value = next;
  saveState.value = 'saving';
  try {
    await api.put('/settings', {
      runtime_mode: {
        mode: next,
        debugWhitelist: debugWhitelist.value,
        botIgnoreUsernames: botIgnoreUsernames.value,
        backfillLimit: Math.max(10, Math.min(500, backfillLimit.value || 200)),
      },
    });
    saveState.value = 'saved';
    setTimeout(() => {
      if (saveState.value === 'saved') saveState.value = 'idle';
    }, 2000);
  } catch {
    mode.value = prev;
    saveState.value = 'error';
  }
}

onMounted(() => {
  void load();
});
</script>

<style scoped>
.bot-mode-card {
  border-radius: 16px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));
  padding: 16px;
  margin-bottom: 16px;
}

.bot-mode-card--public {
  border-color: rgba(76, 175, 80, 0.35);
}

.bot-mode-card--debug {
  border-color: rgba(255, 152, 0, 0.45);
  background: linear-gradient(
    180deg,
    rgba(255, 152, 0, 0.06) 0%,
    rgb(var(--v-theme-surface)) 48%
  );
}

.bot-mode-head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 12px;
}

.bot-mode-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 1.125rem;
  font-weight: 650;
  line-height: 1.3;
  margin: 0 0 6px;
}

.bot-mode-title-icon {
  flex-shrink: 0;
}

.bot-mode-lead {
  margin: 0;
  max-width: 42rem;
  font-size: 0.875rem;
  line-height: 1.45;
  color: rgba(var(--v-theme-on-surface), 0.7);
}

.bot-mode-status-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.bot-mode-options {
  display: grid;
  gap: 10px;
}

@media (min-width: 960px) {
  .bot-mode-options {
    grid-template-columns: 1fr 1fr;
  }
}

.bot-mode-option {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  min-height: var(--tap-min, 44px);
  text-align: left;
  padding: 14px;
  border-radius: 14px;
  border: 1.5px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-surface), 1);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    background 0.15s ease;
}

.bot-mode-option:disabled {
  opacity: 0.65;
  cursor: wait;
}

.bot-mode-option--active {
  border-color: rgb(var(--v-theme-primary));
  box-shadow: 0 0 0 1px rgba(var(--v-theme-primary), 0.2);
  background: rgba(var(--v-theme-primary), 0.04);
}

.bot-mode-card--debug .bot-mode-option--active {
  border-color: rgb(var(--v-theme-warning));
  box-shadow: 0 0 0 1px rgba(var(--v-theme-warning), 0.25);
  background: rgba(var(--v-theme-warning), 0.06);
}

.bot-mode-option-icon {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background: rgba(76, 175, 80, 0.12);
  color: #2e7d32;
}

.bot-mode-option-icon--warn {
  background: rgba(255, 152, 0, 0.16);
  color: #ef6c00;
}

.bot-mode-option-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bot-mode-option-title {
  font-weight: 650;
  font-size: 1rem;
  line-height: 1.3;
}

.bot-mode-option-desc {
  font-size: 0.8125rem;
  line-height: 1.45;
  color: rgba(var(--v-theme-on-surface), 0.68);
}

.bot-mode-option-check {
  flex-shrink: 0;
  margin-top: 2px;
}

.bot-mode-handles {
  word-break: break-word;
}

.bot-mode-link {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
  text-decoration: none;
}

.bot-mode-link:hover {
  text-decoration: underline;
}

.bot-mode-foot {
  margin: 12px 0 0;
  font-size: 0.8125rem;
  line-height: 1.45;
  color: rgba(var(--v-theme-on-surface), 0.65);
}

.bot-mode-loading {
  font-size: 0.875rem;
  padding: 8px 0;
}
</style>
