<template>
  <v-container fluid class="page-shell">
    <PageHeader
      title="Бібліотека"
      subtitle="Картки знань і вкладення для клієнта (фото розмірної сітки тощо)."
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

    <header class="library-page__intro mb-4">
      <p class="library-page__lead">
        Чернетка не потрапляє в діалог. Ціни з CRM сюди не копіюйте — агент бере їх з каталогу.
        Фото з картки агент шле клієнту в Instagram через send_library_asset.
      </p>
      <div class="d-flex flex-wrap ga-2">
        <v-btn variant="tonal" class="tap-target" prepend-icon="mdi-file-import-outline" @click="importOpen = true">
          Застосувати JSON
        </v-btn>
        <v-btn
          variant="text"
          class="tap-target"
          prepend-icon="mdi-download"
          :disabled="cards.length === 0"
          @click="exportJson"
        >
          Завантажити JSON
        </v-btn>
      </div>
    </header>

    <v-progress-linear v-if="loading" indeterminate class="mb-4" />

    <v-alert v-else-if="cards.length === 0" type="warning" variant="tonal">
      Карток ще немає.
    </v-alert>

    <div v-else class="library-grid">
      <button
        v-for="card in cards"
        :key="card.id"
        type="button"
        class="settings-widget library-card-tile"
        @click="openEdit(card)"
      >
        <div class="settings-widget__head">
          <div
            class="settings-widget__icon"
            :class="cardIconClass(card)"
          >
            <v-icon size="20">{{ cardIcon(card) }}</v-icon>
          </div>
          <div class="library-card-tile__text">
            <h3 class="settings-widget__title">{{ card.title }}</h3>
            <p class="settings-widget__desc">{{ card.slug }}</p>
          </div>
        </div>
        <div class="settings-widget__body">
          <p class="library-card-desc mb-0">{{ card.description }}</p>
          <div class="d-flex flex-wrap ga-2 mt-2">
            <v-chip
              size="small"
              :color="card.status === 'active' ? 'success' : 'default'"
              variant="tonal"
              label
            >
              {{ card.status === 'active' ? 'Увімкнена' : 'Чернетка' }}
            </v-chip>
            <v-chip
              v-if="attachmentCount(card) > 0"
              size="small"
              color="primary"
              variant="tonal"
              label
              prepend-icon="mdi-paperclip"
            >
              {{ attachmentCount(card) }} вкл.
            </v-chip>
            <v-chip v-if="card.author === 'meta_agent'" size="small" variant="outlined" label>
              Запропонував помічник
            </v-chip>
          </div>
          <div v-if="firstImagePreview(card)" class="library-card-thumb mt-3">
            <img :src="firstImagePreview(card)!" alt="" loading="lazy" />
          </div>
        </div>
      </button>
    </div>

    <v-dialog v-model="editor" :fullscreen="mobile" max-width="880" scrollable>
      <v-card class="library-dialog settings-agent">
        <v-card-title class="library-dialog-title d-flex align-center justify-space-between flex-wrap ga-2">
          <span>{{ draft.id ? 'Картка' : 'Нова картка' }}</span>
          <v-chip
            size="small"
            :color="isActive ? 'success' : 'default'"
            variant="tonal"
            label
          >
            {{ isActive ? 'Увімкнена' : 'Чернетка' }}
          </v-chip>
        </v-card-title>
        <v-card-text class="library-dialog-body">
          <section class="settings-widget">
            <div class="settings-widget__head">
              <div class="settings-widget__icon settings-widget__icon--violet">
                <v-icon size="20">mdi-card-account-details-outline</v-icon>
              </div>
              <div>
                <h3 class="settings-widget__title">Ідентичність</h3>
                <p class="settings-widget__desc">Як агент і ви знайдете цю картку.</p>
              </div>
            </div>
            <div class="settings-widget__body settings-widget__body--grid">
              <div class="settings-field settings-field--full">
                <label class="settings-field__label" for="library-title">Назва</label>
                <v-text-field
                  id="library-title"
                  v-model="draft.title"
                  variant="outlined"
                  density="comfortable"
                  hide-details
                  placeholder="Розмірна сітка худі Blessed"
                  class="settings-field__control"
                  prepend-inner-icon="mdi-tag-outline"
                  spellcheck="false"
                />
              </div>
              <div class="settings-field settings-field--full">
                <label class="settings-field__label" for="library-slug">Slug</label>
                <v-text-field
                  id="library-slug"
                  v-model="draft.slug"
                  variant="outlined"
                  density="comfortable"
                  hide-details
                  placeholder="size-chart-hoodie"
                  class="settings-field__control"
                  prepend-inner-icon="mdi-link-variant"
                  spellcheck="false"
                />
                <p class="settings-field__hint">Латиниця, цифри, дефіс. Агент кличе картку цим імʼям.</p>
              </div>
            </div>
          </section>

          <section class="settings-widget">
            <div class="settings-widget__head">
              <div class="settings-widget__icon settings-widget__icon--blue">
                <v-icon size="20">mdi-target</v-icon>
              </div>
              <div>
                <h3 class="settings-widget__title">Коли брати</h3>
                <p class="settings-widget__desc">Опис для змісту + аліаси з повідомлення клієнта.</p>
              </div>
            </div>
            <div class="settings-widget__body">
              <div class="settings-field settings-field--full">
                <label class="settings-field__label" for="library-when">Опис</label>
                <v-textarea
                  id="library-when"
                  v-model="draft.description"
                  variant="outlined"
                  density="comfortable"
                  rows="2"
                  auto-grow
                  hide-details
                  placeholder="Клієнт питає розмірну сітку / розміри худі"
                  class="settings-field__control"
                  spellcheck="false"
                />
              </div>
              <div class="settings-field settings-field--full">
                <label class="settings-field__label" for="library-aliases">Аліаси</label>
                <v-textarea
                  id="library-aliases"
                  v-model="aliasesText"
                  variant="outlined"
                  density="comfortable"
                  rows="3"
                  auto-grow
                  hide-details
                  placeholder="розмірна сітка&#10;розміри&#10;сітка"
                  class="settings-field__control"
                  spellcheck="false"
                />
                <p class="settings-field__hint">По одному в рядку. За збігом текст картки підкладеться в хід.</p>
              </div>
            </div>
          </section>

          <section class="settings-widget">
            <div class="settings-widget__head">
              <div class="settings-widget__icon settings-widget__icon--amber">
                <v-icon size="20">mdi-text-box-outline</v-icon>
              </div>
              <div>
                <h3 class="settings-widget__title">Текст картки</h3>
                <p class="settings-widget__desc">Що агент може сказати клієнту словами.</p>
              </div>
            </div>
            <div class="settings-widget__body">
              <div class="settings-field settings-field--full">
                <label class="settings-field__label" for="library-body">Тіло</label>
                <v-textarea
                  id="library-body"
                  v-model="draft.body"
                  variant="outlined"
                  density="comfortable"
                  rows="10"
                  hide-details
                  placeholder="Коротко: ось розмірна сітка oversize — зараз надішлю фото."
                  class="settings-field__control library-body"
                  spellcheck="false"
                />
              </div>
            </div>
          </section>

          <section class="settings-widget settings-widget--accent">
            <div class="settings-widget__head">
              <div class="settings-widget__icon settings-widget__icon--orange">
                <v-icon size="20">mdi-image-multiple-outline</v-icon>
              </div>
              <div>
                <h3 class="settings-widget__title">Вкладення для клієнта</h3>
                <p class="settings-widget__desc">
                  Фото піде в Instagram як картинка (не лише лінк). Спочатку збережіть картку, щоб завантажити файл.
                </p>
              </div>
            </div>
            <div class="settings-widget__body">
              <div v-if="!draft.id" class="settings-callout settings-callout--warn mb-0">
                <p>Збережіть картку — після цього можна додати фото, файл або посилання.</p>
              </div>
              <template v-else>
                <div class="library-attach-actions">
                  <v-btn
                    color="primary"
                    variant="tonal"
                    class="tap-target"
                    prepend-icon="mdi-upload"
                    :loading="uploading"
                    @click="pickFile"
                  >
                    Завантажити фото/PDF
                  </v-btn>
                  <input
                    ref="fileInput"
                    type="file"
                    class="d-none"
                    accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
                    @change="onFilePicked"
                  />
                  <v-btn
                    variant="outlined"
                    class="tap-target"
                    prepend-icon="mdi-link-plus"
                    @click="linkDialog = true"
                  >
                    Додати посилання
                  </v-btn>
                </div>

                <div v-if="(draft.attachments ?? []).length === 0" class="text-caption text-medium-emphasis">
                  Поки порожньо. Наприклад: розмірна сітка Status Blessed.
                </div>

                <div
                  v-for="att in draft.attachments ?? []"
                  :key="att.id"
                  class="library-attach-row"
                >
                  <div class="library-attach-row__preview">
                    <img
                      v-if="att.type === 'image' && attachmentSrc(att)"
                      :src="attachmentSrc(att)!"
                      alt=""
                    />
                    <v-icon v-else-if="att.type === 'link'" size="28">mdi-link-variant</v-icon>
                    <v-icon v-else size="28">mdi-file-document-outline</v-icon>
                  </div>
                  <div class="library-attach-row__meta">
                    <div class="font-weight-medium">{{ att.title }}</div>
                    <div class="text-caption text-medium-emphasis">
                      {{ att.type }} · {{ att.id.slice(0, 8) }}…
                    </div>
                  </div>
                  <v-btn
                    icon="mdi-delete-outline"
                    variant="text"
                    color="error"
                    class="tap-target"
                    :loading="removingId === att.id"
                    @click="removeAttachment(att.id)"
                  />
                </div>
              </template>
            </div>
          </section>

          <section class="settings-widget">
            <div class="settings-widget__head settings-widget__head--row">
              <div class="settings-widget__head-text">
                <div class="settings-widget__icon settings-widget__icon--green">
                  <v-icon size="20">mdi-toggle-switch</v-icon>
                </div>
                <div>
                  <h3 class="settings-widget__title">Статус</h3>
                  <p class="settings-widget__desc">Чернетка в діалог не йде.</p>
                </div>
              </div>
              <v-switch
                v-model="isActive"
                color="success"
                hide-details
                density="comfortable"
                class="settings-widget__switch"
                :label="isActive ? 'Увімкнена' : 'Чернетка'"
              />
            </div>
          </section>
        </v-card-text>
        <v-card-actions class="library-dialog-actions dialog-actions-stack sticky-action-bar">
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

    <v-dialog v-model="linkDialog" max-width="480">
      <v-card class="pa-4">
        <v-card-title class="text-h6 px-0">Посилання</v-card-title>
        <v-text-field
          v-model="linkTitle"
          label="Назва"
          variant="outlined"
          density="comfortable"
          hide-details
          class="mb-3"
        />
        <v-text-field
          v-model="linkUrl"
          label="HTTPS URL"
          variant="outlined"
          density="comfortable"
          hide-details
          placeholder="https://…"
        />
        <v-card-actions class="px-0 pt-4">
          <v-spacer />
          <v-btn variant="text" @click="linkDialog = false">Скасувати</v-btn>
          <v-btn color="primary" :loading="linking" @click="addLink">Додати</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="importOpen" :fullscreen="mobile" max-width="720" scrollable>
      <v-card class="library-dialog">
        <v-card-title class="library-dialog-title">Застосувати картки з JSON</v-card-title>
        <v-card-text class="library-dialog-body">
          <p class="library-lead">
            Файл або вставлений текст. Картка з тим самим slug оновлюється.
            Без status вона одразу вмикається. version 2 підтримує attachments з https URL.
          </p>
          <pre class="import-sample">{{ sample }}</pre>
          <div class="settings-field">
            <label class="settings-field__label" for="library-file">Файл JSON</label>
            <v-file-input
              id="library-file"
              accept="application/json,.json"
              placeholder="Оберіть файл"
              prepend-icon=""
              prepend-inner-icon="mdi-file-upload-outline"
              variant="outlined"
              density="comfortable"
              hide-details
              class="settings-field__control"
              :disabled="importing"
              @update:model-value="onImportFile"
            />
          </div>
          <div class="settings-field">
            <label class="settings-field__label" for="library-json">Або вставте JSON</label>
            <v-textarea
              id="library-json"
              v-model="importText"
              variant="outlined"
              density="comfortable"
              rows="8"
              auto-grow
              hide-details
              placeholder="{ &quot;version&quot;: 2, &quot;cards&quot;: [] }"
              class="settings-field__control library-body"
              spellcheck="false"
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
import { resolveMessageMediaSrc } from '@/lib/mediaUrl';

interface LibraryAttachment {
  id: string;
  type: 'image' | 'file' | 'link';
  title: string;
  storageKey?: string;
  url?: string;
  mime?: string;
  bytes?: number;
}

interface LibraryCard {
  id: string;
  slug: string;
  title: string;
  description: string;
  body: string;
  aliases: string[];
  attachments?: LibraryAttachment[];
  status: 'draft' | 'active';
  author: 'human' | 'meta_agent';
}

const { mobile } = useDisplay();
const cards = ref<LibraryCard[]>([]);
const loading = ref(true);
const saving = ref(false);
const uploading = ref(false);
const linking = ref(false);
const removingId = ref<string | null>(null);
const importing = ref(false);
const importOpen = ref(false);
const importText = ref('');
const importIssues = ref<Array<{ path: string; message: string }>>([]);
const linkDialog = ref(false);
const linkTitle = ref('');
const linkUrl = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const sample = `{
  "version": 2,
  "cards": [
    {
      "slug": "size-chart-hoodie",
      "title": "Розмірна сітка худі",
      "description": "Клієнт питає розміри / сітку",
      "aliases": ["розмірна сітка", "розміри"],
      "body": "Ось розмірна сітка oversize — зараз надішлю фото.",
      "status": "active",
      "attachments": [
        {
          "type": "image",
          "title": "Сітка худі",
          "url": "https://example.com/size-chart.jpg"
        }
      ]
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

function attachmentCount(card: LibraryCard): number {
  return card.attachments?.length ?? 0;
}

function cardIcon(card: LibraryCard): string {
  const types = new Set((card.attachments ?? []).map((a) => a.type));
  if (types.has('image')) return 'mdi-image-outline';
  if (types.has('link')) return 'mdi-link-variant';
  if (types.has('file')) return 'mdi-file-document-outline';
  return 'mdi-book-open-page-variant-outline';
}

function cardIconClass(card: LibraryCard): string {
  const types = new Set((card.attachments ?? []).map((a) => a.type));
  if (types.has('image')) return 'settings-widget__icon--orange';
  if (types.has('link')) return 'settings-widget__icon--blue';
  if (types.has('file')) return 'settings-widget__icon--amber';
  return 'settings-widget__icon--violet';
}

function attachmentSrc(att: LibraryAttachment): string | undefined {
  if (att.url?.startsWith('https://')) return att.url;
  if (att.storageKey) return resolveMessageMediaSrc(att.storageKey);
  return undefined;
}

function firstImagePreview(card: LibraryCard): string | undefined {
  const img = (card.attachments ?? []).find((a) => a.type === 'image');
  return img ? attachmentSrc(img) : undefined;
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
  draft.value = {
    title: '',
    slug: '',
    description: '',
    body: '',
    status: 'draft',
    aliases: [],
    attachments: [],
  };
  aliasesText.value = '';
  editor.value = true;
}

function openEdit(card: LibraryCard) {
  draft.value = { ...card, attachments: [...(card.attachments ?? [])] };
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
    attachments: draft.value.attachments ?? [],
  };
  saving.value = true;
  try {
    if (draft.value.id) {
      const { data } = await api.patch<LibraryCard>(`/library/${draft.value.id}`, payload);
      draft.value = { ...data, attachments: data.attachments ?? [] };
    } else {
      const { data } = await api.post<LibraryCard>('/library', payload);
      draft.value = { ...data, attachments: data.attachments ?? [] };
    }
    await load();
    notify('Збережено');
  } catch {
    notify('Не вдалося зберегти. Перевірте slug і обовʼязкові поля.', 'error');
  } finally {
    saving.value = false;
  }
}

function pickFile() {
  fileInput.value?.click();
}

async function onFilePicked(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !draft.value.id) return;
  uploading.value = true;
  try {
    const dataBase64 = await fileToBase64(file);
    const { data } = await api.post<{ attachment: LibraryAttachment; card: LibraryCard }>(
      `/library/${draft.value.id}/attachments/upload`,
      {
        filename: file.name,
        contentType: file.type,
        title: file.name.replace(/\.[^.]+$/, ''),
        type: file.type === 'application/pdf' ? 'file' : 'image',
        dataBase64,
      },
    );
    draft.value = { ...data.card, attachments: data.card.attachments ?? [] };
    await load();
    notify('Вкладення додано');
  } catch {
    notify('Не вдалося завантажити файл', 'error');
  } finally {
    uploading.value = false;
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const b64 = result.includes(',') ? result.split(',')[1]! : result;
      resolve(b64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function addLink() {
  if (!draft.value.id) return;
  linking.value = true;
  try {
    const { data } = await api.post<{ attachment: LibraryAttachment; card: LibraryCard }>(
      `/library/${draft.value.id}/attachments/link`,
      { type: 'link', title: linkTitle.value.trim() || 'Посилання', url: linkUrl.value.trim() },
    );
    draft.value = { ...data.card, attachments: data.card.attachments ?? [] };
    linkDialog.value = false;
    linkTitle.value = '';
    linkUrl.value = '';
    await load();
    notify('Посилання додано');
  } catch {
    notify('Не вдалося додати посилання (потрібен https://)', 'error');
  } finally {
    linking.value = false;
  }
}

async function removeAttachment(id: string) {
  if (!draft.value.id) return;
  removingId.value = id;
  try {
    const { data } = await api.delete<LibraryCard>(`/library/${draft.value.id}/attachments/${id}`);
    draft.value = { ...data, attachments: data.attachments ?? [] };
    await load();
  } catch {
    notify('Не вдалося видалити вкладення', 'error');
  } finally {
    removingId.value = null;
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
    version: 2,
    cards: cards.value.map((card) => ({
      slug: card.slug,
      title: card.title,
      description: card.description,
      aliases: card.aliases,
      body: card.body,
      status: card.status,
      attachments: (card.attachments ?? [])
        .filter((a) => a.url)
        .map((a) => ({
          type: a.type,
          title: a.title,
          url: a.url,
        })),
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
.library-page__lead {
  margin: 0 0 12px;
  max-width: 42rem;
  font-size: 0.95rem;
  line-height: 1.45;
  color: #425466;
}

.library-grid {
  display: grid;
  gap: 14px;
  grid-template-columns: 1fr;
}

@media (min-width: 960px) {
  .library-grid {
    grid-template-columns: 1fr 1fr;
  }
}

.library-card-tile {
  width: 100%;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
  padding: 0;
}

.library-card-tile__text {
  min-width: 0;
}

.library-card-desc {
  color: #1c3348;
  line-height: 1.45;
  font-size: 0.875rem;
}

.library-card-thumb {
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid #e3eaf2;
  max-height: 140px;
  background: #f7f9fc;
}

.library-card-thumb img {
  display: block;
  width: 100%;
  height: 140px;
  object-fit: cover;
}

.library-dialog {
  background: #f4f7fb;
  color: #0a2540;
}

.library-dialog-title {
  padding: 20px 24px 8px;
  font-size: 20px;
  font-weight: 650;
  color: #0a2540;
}

.library-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 8px 16px 16px;
}

.library-lead {
  margin: 0;
  color: #1c3348;
  line-height: 1.5;
}

.library-body :deep(textarea) {
  min-height: 200px;
}

.library-attach-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.library-attach-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #fff;
  border: 1px solid #e3eaf2;
}

.library-attach-row__preview {
  width: 56px;
  height: 56px;
  border-radius: 8px;
  background: #f7f9fc;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  flex-shrink: 0;
}

.library-attach-row__preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.library-attach-row__meta {
  flex: 1;
  min-width: 0;
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

/* Reuse Agent & SLA widget vocabulary */
.settings-agent {
  display: flex;
  flex-direction: column;
}

.settings-widget {
  background: #fff;
  border: 1px solid #d9e2ec;
  border-radius: 14px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px rgba(15, 23, 42, 0.04);
  overflow: hidden;
}

.settings-widget--accent {
  border-color: #f5c4a8;
  background: linear-gradient(180deg, #fffaf6 0%, #fff 55%);
}

.settings-widget__head {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 16px 16px 0;
}

.settings-widget__head--row {
  align-items: center;
  justify-content: space-between;
  padding-bottom: 16px;
}

.settings-widget__head-text {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  min-width: 0;
  flex: 1;
}

.settings-widget__icon {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.settings-widget__icon--violet { background: #ecebff; color: #4f46e5; }
.settings-widget__icon--blue { background: #e8f1ff; color: #2563eb; }
.settings-widget__icon--orange { background: #ffe8d6; color: #c2410c; }
.settings-widget__icon--green { background: #e6f7ef; color: #0f766e; }
.settings-widget__icon--amber { background: #fff3d6; color: #b45309; }

.settings-widget__title {
  margin: 0;
  font-size: 1.02rem;
  font-weight: 650;
  letter-spacing: -0.015em;
  color: #0a2540;
  line-height: 1.3;
}

.settings-widget__desc {
  margin: 4px 0 0;
  font-size: 0.875rem;
  line-height: 1.45;
  color: #425466;
}

.settings-widget__body {
  display: grid;
  gap: 16px;
  padding: 14px 16px 16px;
}

.settings-widget__body--grid {
  grid-template-columns: 1fr;
}

.settings-widget__switch {
  flex-shrink: 0;
}

.settings-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.settings-field--full {
  grid-column: 1 / -1;
}

.settings-field__label {
  font-size: 0.8125rem;
  font-weight: 650;
  color: #0a2540;
}

.settings-field__hint {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.45;
  color: #4b5565;
}

.settings-field__control :deep(.v-field) {
  background: #fff;
  border-radius: 10px !important;
}

.settings-callout {
  margin: 0;
  padding: 12px 14px;
  border-radius: 10px;
  background: #fff;
  border: 1px solid #f0d0b8;
}

.settings-callout--warn {
  border-color: #f5d48a;
  background: #fffbeb;
}

.settings-callout p {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.45;
  color: #3d2c22;
}
</style>
