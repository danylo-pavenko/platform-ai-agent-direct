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
            <div class="mb-2">{{ card.description }}</div>
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

    <v-dialog v-model="editor" :fullscreen="mobile" max-width="840">
      <v-card>
        <v-card-title>{{ draft.id ? 'Картка' : 'Нова картка' }}</v-card-title>
        <v-card-text>
          <v-text-field v-model="draft.title" label="Назва" class="mb-2" />
          <v-text-field
            v-model="draft.slug"
            label="Slug"
            hint="Латиниця, цифри, дефіс. Агент кличе картку цим ім’ям."
            persistent-hint
            class="mb-2"
          />
          <v-textarea
            v-model="draft.description"
            label="Коли брати"
            rows="2"
            hint="Одне речення: у якому питанні клієнта ця картка потрібна."
            persistent-hint
            class="mb-2"
          />
          <v-textarea
            v-model="aliasesText"
            label="Аліаси"
            rows="2"
            hint="По одному в рядку. Наприклад N55 або 2.5 tdi."
            persistent-hint
            class="mb-2"
          />
          <v-textarea v-model="draft.body" label="Текст картки" rows="12" />
          <v-switch
            v-model="isActive"
            color="primary"
            label="Увімкнути. Чернетка в діалог не йде."
            hide-details
          />
        </v-card-text>
        <v-card-actions class="dialog-actions-stack">
          <v-btn v-if="draft.id" color="error" variant="text" class="tap-target" @click="remove">
            Видалити
          </v-btn>
          <v-spacer />
          <v-btn variant="text" class="tap-target" @click="editor = false">Закрити</v-btn>
          <v-btn color="primary" class="tap-target" :loading="saving" @click="save">Зберегти</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="importOpen" :fullscreen="mobile" max-width="720">
      <v-card>
        <v-card-title>Застосувати картки з JSON</v-card-title>
        <v-card-text>
          <p class="mb-3">
            Файл або вставлений текст. Картка з тим самим slug оновлюється.
            Без status вона одразу вмикається і йде в наступний діалог.
            Інші картки цього тенанта не чіпаються.
          </p>
          <pre class="import-sample mb-3">{{ sample }}</pre>
          <v-file-input
            accept="application/json,.json"
            label="Файл JSON"
            prepend-icon="mdi-file-upload-outline"
            density="comfortable"
            :disabled="importing"
            @update:model-value="onImportFile"
          />
          <v-textarea
            v-model="importText"
            label="Або вставте JSON"
            rows="8"
            auto-grow
            class="mt-2"
          />
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
        <v-card-actions class="dialog-actions-stack">
          <v-spacer />
          <v-btn variant="text" class="tap-target" @click="importOpen = false">Закрити</v-btn>
          <v-btn color="primary" class="tap-target" :loading="importing" @click="applyImport">
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
.import-sample {
  white-space: pre-wrap;
  font-size: 12px;
  padding: 12px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.04);
}
</style>
