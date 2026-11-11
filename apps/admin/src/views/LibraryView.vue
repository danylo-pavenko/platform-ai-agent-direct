<template>
  <v-container fluid class="page-shell">
    <PageHeader
      title="Бібліотека"
      subtitle="Картки знань. У хід іде лише увімкнена картка, і лише її зміст, доки текст не знадобився."
    >
      <template #actions>
        <v-btn
          color="primary"
          class="tap-target"
          :prepend-icon="mobile ? undefined : 'mdi-plus'"
          :icon="mobile ? 'mdi-plus' : undefined"
          aria-label="Нова картка"
          @click="openCreate"
        >
          <span v-if="!mobile">Нова картка</span>
        </v-btn>
      </template>
    </PageHeader>

    <v-alert type="info" variant="tonal" density="comfortable" class="mb-4">
      Чернетка не потрапляє в діалог. Ціни з CRM сюди не копіюйте: їх агент бере з каталогу.
      Картки тенанта зручно тримати файлом JSON і застосувати його тут.
    </v-alert>

    <div class="d-flex flex-wrap ga-2 mb-4">
      <v-btn variant="tonal" class="tap-target" @click="importOpen = true">
        Застосувати JSON
      </v-btn>
      <v-btn
        variant="text"
        class="tap-target"
        :disabled="cards.length === 0"
        @click="exportJson"
      >
        Завантажити JSON
      </v-btn>
    </div>

    <v-progress-linear v-if="loading" indeterminate class="mb-4" />

    <v-alert v-else-if="cards.length === 0" type="warning" variant="tonal">
      Карток ще немає.
    </v-alert>

    <v-row v-else>
      <v-col v-for="card in cards" :key="card.id" cols="12" md="6">
        <v-card class="mobile-list-card" @click="openEdit(card)">
          <v-card-item>
            <v-card-title class="text-wrap">{{ card.title }}</v-card-title>
            <v-card-subtitle class="text-wrap">{{ card.slug }}</v-card-subtitle>
          </v-card-item>
          <v-card-text>
            <div class="library-card-desc mb-2">{{ card.description }}</div>
            <v-chip
              size="small"
              :color="card.status === 'active' ? 'success' : 'default'"
              class="mr-2"
            >
              {{ card.status === 'active' ? 'Увімкнена' : 'Чернетка' }}
            </v-chip>
            <v-chip v-if="card.author === 'meta_agent'" size="small" variant="outlined">
              Запропонував помічник
            </v-chip>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-dialog v-model="editor" :fullscreen="mobile" max-width="840" scrollable>
      <v-card class="library-dialog">
        <v-card-title class="library-dialog-title">
          {{ draft.id ? 'Картка' : 'Нова картка' }}
        </v-card-title>
        <v-card-text class="library-dialog-body">
          <div class="library-field">
            <label class="library-label" for="library-title">Назва</label>
            <v-text-field
              id="library-title"
              v-model="draft.title"
              variant="outlined"
              density="comfortable"
              hide-details
              placeholder="Як людина знайде цю картку"
              class="library-input" spellcheck="false"
            />
          </div>
          <div class="library-field">
            <label class="library-label" for="library-slug">Slug</label>
            <v-text-field
              id="library-slug"
              v-model="draft.slug"
              variant="outlined"
              density="comfortable"
              hide-details
              placeholder="diesel"
              class="library-input" spellcheck="false"
            />
            <p class="library-hint">Латиниця, цифри, дефіс. Агент кличе картку цим ім’ям.</p>
          </div>
          <div class="library-field">
            <label class="library-label" for="library-when">Коли брати</label>
            <v-textarea
              id="library-when"
              v-model="draft.description"
              variant="outlined"
              density="comfortable"
              rows="2"
              auto-grow
              hide-details
              placeholder="Одне речення: у якому питанні клієнта ця картка потрібна"
              class="library-input" spellcheck="false"
            />
          </div>
          <div class="library-field">
            <label class="library-label" for="library-aliases">Аліаси</label>
            <v-textarea
              id="library-aliases"
              v-model="aliasesText"
              variant="outlined"
              density="comfortable"
              rows="3"
              auto-grow
              hide-details
              placeholder="N55&#10;2.5 tdi"
              class="library-input" spellcheck="false"
            />
            <p class="library-hint">По одному в рядку.</p>
          </div>
          <div class="library-field">
            <label class="library-label" for="library-body">Текст картки</label>
            <v-textarea
              id="library-body"
              v-model="draft.body"
              variant="outlined"
              density="comfortable"
              rows="12"
              hide-details
              placeholder="Текст, який агент може сказати клієнту"
              class="library-input library-body" spellcheck="false"
            />
          </div>
          <div class="library-switch">
            <v-switch
              v-model="isActive"
              color="primary"
              hide-details
              inset
              density="comfortable"
            />
            <div>
              <div class="library-switch-title">{{ isActive ? 'Увімкнена' : 'Чернетка' }}</div>
              <div class="library-hint">Чернетка в діалог не йде.</div>
            </div>
          </div>
        </v-card-text>
        <v-card-actions class="library-dialog-actions dialog-actions-stack">
          <v-btn v-if="draft.id" color="error" variant="text" class="tap-target" @click="remove">
            Видалити
          </v-btn>
          <v-spacer />
          <v-btn variant="text" class="tap-target" @click="editor = false">Закрити</v-btn>
          <v-btn color="primary" variant="flat" class="tap-target" :loading="saving" @click="save">
            Зберегти
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="importOpen" :fullscreen="mobile" max-width="720" scrollable>
      <v-card class="library-dialog">
        <v-card-title class="library-dialog-title">Застосувати картки з JSON</v-card-title>
        <v-card-text class="library-dialog-body">
          <p class="library-lead">
            Файл або вставлений текст. Картка з тим самим slug оновлюється.
            Без status вона одразу вмикається і йде в наступний діалог.
            Інші картки цього тенанта не чіпаються.
          </p>
          <pre class="import-sample">{{ sample }}</pre>
          <div class="library-field">
            <label class="library-label" for="library-file">Файл JSON</label>
            <v-file-input
              id="library-file"
              accept="application/json,.json"
              placeholder="Оберіть файл"
              prepend-icon=""
              prepend-inner-icon="mdi-file-upload-outline"
              variant="outlined"
              density="comfortable"
              hide-details
              class="library-input" spellcheck="false"
              :disabled="importing"
              @update:model-value="onImportFile"
            />
          </div>
          <div class="library-field">
            <label class="library-label" for="library-json">Або вставте JSON</label>
            <v-textarea
              id="library-json"
              v-model="importText"
              variant="outlined"
              density="comfortable"
              rows="8"
              auto-grow
              hide-details
              placeholder="{ &quot;version&quot;: 1, &quot;cards&quot;: [] }"
              class="library-input library-body" spellcheck="false"
            />
          </div>
          <v-alert
            v-if="importIssues.length"
            type="error"
            variant="tonal"
            class="mt-2"
          >
            <div v-for="(issue, i) in importIssues" :key="i">
              {{ issue.path }}: {{ issue.message }}
            </div>
          </v-alert>
        </v-card-text>
        <v-card-actions class="library-dialog-actions dialog-actions-stack">
          <v-spacer />
          <v-btn variant="text" class="tap-target" @click="importOpen = false">Закрити</v-btn>
          <v-btn color="primary" variant="flat" class="tap-target" :loading="importing" @click="applyImport">
            Застосувати
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="snack" :color="snackColor">{{ snackText }}</v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useDisplay } from 'vuetify';
import PageHeader from '@/components/PageHeader.vue';
import api from '@/api';

interface LibraryCard {
  id: string;
  slug: string;
  title: string;
  description: string;
  body: string;
  aliases: string[];
  status: 'draft' | 'active';
  author: 'human' | 'meta_agent';
}

const { mobile } = useDisplay();
const cards = ref<LibraryCard[]>([]);
const loading = ref(true);
const saving = ref(false);
const importing = ref(false);
const importOpen = ref(false);
const importText = ref('');
const importIssues = ref<Array<{ path: string; message: string }>>([]);
const sample = `{
  "version": 1,
  "cards": [
    {
      "slug": "refund-rules",
      "title": "Повернення",
      "description": "Коли клієнт просить повернути гроші",
      "aliases": ["повернення", "refund"],
      "body": "Текст, який агент може назвати клієнту.",
      "status": "active"
    }
  ]
}`;
const editor = ref(false);
const draft = ref<Partial<LibraryCard>>({});
const aliasesText = ref('');
const snack = ref(false);
const snackText = ref('');
const snackColor = ref('success');

const isActive = computed({
  get: () => draft.value.status === 'active',
  set: (on: boolean) => {
    draft.value.status = on ? 'active' : 'draft';
  },
});

function notify(text: string, color = 'success') {
  snackText.value = text;
  snackColor.value = color;
  snack.value = true;
}

async function load() {
  loading.value = true;
  try {
    const { data } = await api.get<{ data: LibraryCard[] }>('/library');
    cards.value = data.data;
  } catch {
    notify('Не вдалося завантажити картки', 'error');
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  draft.value = { title: '', slug: '', description: '', body: '', status: 'draft', aliases: [] };
  aliasesText.value = '';
  editor.value = true;
}

function openEdit(card: LibraryCard) {
  draft.value = { ...card };
  aliasesText.value = card.aliases.join('\n');
  editor.value = true;
}

function aliasesFromText(): string[] {
  return aliasesText.value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 2);
}

async function save() {
  const payload = {
    slug: (draft.value.slug ?? '').trim(),
    title: (draft.value.title ?? '').trim(),
    description: (draft.value.description ?? '').trim(),
    body: (draft.value.body ?? '').trim(),
    aliases: aliasesFromText(),
    status: draft.value.status === 'active' ? 'active' : 'draft',
  };
  saving.value = true;
  try {
    if (draft.value.id) {
      await api.patch(`/library/${draft.value.id}`, payload);
    } else {
      await api.post('/library', payload);
    }
    editor.value = false;
    await load();
    notify('Збережено');
  } catch {
    notify('Не вдалося зберегти. Перевірте slug і обовʼязкові поля.', 'error');
  } finally {
    saving.value = false;
  }
}

async function remove() {
  if (!draft.value.id) return;
  saving.value = true;
  try {
    await api.delete(`/library/${draft.value.id}`);
    editor.value = false;
    await load();
    notify('Картку видалено');
  } catch {
    notify('Не вдалося видалити', 'error');
  } finally {
    saving.value = false;
  }
}

function exportJson() {
  const pack = {
    version: 1,
    cards: cards.value.map((card) => ({
      slug: card.slug,
      title: card.title,
      description: card.description,
      aliases: card.aliases,
      body: card.body,
      status: card.status,
    })),
  };
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'library.json';
  link.click();
  URL.revokeObjectURL(url);
}

async function onImportFile(file: File | File[] | null) {
  const picked = Array.isArray(file) ? file[0] : file;
  if (!picked) return;
  importText.value = await picked.text();
  await applyImport();
}

async function applyImport() {
  importIssues.value = [];
  let raw: unknown;
  try {
    raw = JSON.parse(importText.value);
  } catch {
    importIssues.value = [{ path: 'json', message: 'Це не JSON' }];
    return;
  }
  importing.value = true;
  try {
    const { data } = await api.post<{ upserted: number; active: number; draft: number }>(
      '/library/import',
      raw,
    );
    importOpen.value = false;
    importText.value = '';
    await load();
    notify(`Застосовано карток: ${data.upserted}. Увімкнено: ${data.active}. Чернеток: ${data.draft}.`);
  } catch (err: unknown) {
    const issues = (err as { response?: { data?: { issues?: Array<{ path: string; message: string }> } } })
      .response?.data?.issues;
    importIssues.value = issues?.length
      ? issues
      : [{ path: 'import', message: 'Не вдалося застосувати файл' }];
  } finally {
    importing.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.library-card-desc {
  color: #1c3348;
  line-height: 1.45;
}

.library-dialog {
  background: #fff;
  color: #0a2540;
}

.library-dialog-title {
  padding: 20px 24px 12px;
  font-size: 20px;
  font-weight: 650;
  color: #0a2540;
  letter-spacing: 0;
}

.library-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 4px;
  background: #fff;
}

.library-lead {
  margin: 0;
  color: #1c3348;
  line-height: 1.5;
}

.library-field {
  display: flex;
  flex-direction: column;
}

.library-label {
  margin: 0 0 6px;
  color: #0a2540;
  font-size: 13px;
  font-weight: 650;
  line-height: 1.3;
}

.library-hint {
  margin: 6px 0 0;
  color: #3d4f66;
  font-size: 13px;
  line-height: 1.4;
}

.library-input :deep(.v-field) {
  background: #fff;
  border: 1.5px solid #6d7f93;
  border-radius: 12px;
  font-size: 15px !important;
}

.library-input :deep(.v-field--focused) {
  border-color: #635bff;
}

.library-input :deep(.v-field__outline) {
  display: none;
}

.library-input :deep(.v-field__input),
.library-input :deep(textarea) {
  color: #0a2540 !important;
  caret-color: #0a2540;
  opacity: 1;
  font-size: 15px !important;
  line-height: 1.5;
}

.library-input :deep(.v-field__input::placeholder),
.library-input :deep(textarea::placeholder) {
  color: #5c6d80;
  opacity: 1;
}

.library-body :deep(textarea) {
  min-height: 220px;
}

.library-switch {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid #c5d0dc;
  border-radius: 12px;
  background: #f7f9fc;
}

.library-switch :deep(.v-input) {
  margin: 0;
  flex: 0 0 auto;
}

.library-switch :deep(.v-selection-control) {
  min-height: 44px;
}

.library-switch-title {
  color: #0a2540;
  font-weight: 650;
}

.import-sample {
  margin: 0;
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.45;
  color: #0a2540;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid #c5d0dc;
  background: #f7f9fc;
}

.library-dialog-actions {
  padding: 12px 20px 16px;
  border-top: 1px solid #e6ebf1;
  background: #fff;
}
</style>
