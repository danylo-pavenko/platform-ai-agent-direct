<template>
  <v-container fluid class="page-shell">
    <PageHeader
      title="Промпти"
      subtitle="Версії системного промпту. Текст відкривається окремо, список його не вантажить."
    >
      <template #actions>
        <v-btn
          color="primary"
          class="tap-target"
          :prepend-icon="mobile ? undefined : 'mdi-plus'"
          :icon="mobile ? 'mdi-plus' : undefined"
          aria-label="Нова версія"
          @click="openNewDialog"
        >
          <span v-if="!mobile">Нова версія</span>
        </v-btn>
      </template>
    </PageHeader>

    <v-progress-linear v-if="loading" indeterminate class="mb-4" />

    <v-alert v-else-if="prompts.length === 0" type="info" variant="tonal" class="mb-4">
      Версій ще немає. Створіть першу — вона стане чернеткою, доки її не активуєте.
    </v-alert>

    <template v-else>
      <div class="prompt-stats mb-4">
        <section class="settings-widget" :class="activePrompt ? 'settings-widget--ok' : ''">
          <div class="settings-widget__head">
            <div class="settings-widget__icon settings-widget__icon--green">
              <v-icon size="20">mdi-check-decagram</v-icon>
            </div>
            <div class="min-width-0">
              <h3 class="settings-widget__title">
                {{ activePrompt ? `Активна v${activePrompt.version}` : 'Немає активної' }}
              </h3>
              <p class="settings-widget__desc">
                {{ activePrompt ? formatDate(activePrompt.createdAt) : 'Активуйте одну з версій нижче' }}
              </p>
            </div>
          </div>
          <div class="settings-widget__body">
            <p class="prompt-summary mb-3">
              {{ activePrompt?.changeSummary || 'Без опису змін' }}
            </p>
            <v-btn
              v-if="activePrompt"
              variant="tonal"
              color="primary"
              class="tap-target"
              prepend-icon="mdi-text-box-outline"
              @click="openViewer(activePrompt)"
            >
              Відкрити текст
            </v-btn>
          </div>
        </section>

        <section class="settings-widget">
          <div class="settings-widget__head">
            <div class="settings-widget__icon settings-widget__icon--blue">
              <v-icon size="20">mdi-source-branch</v-icon>
            </div>
            <div>
              <h3 class="settings-widget__title">{{ prompts.length }}</h3>
              <p class="settings-widget__desc">версій у історії</p>
            </div>
          </div>
        </section>

        <section class="settings-widget">
          <div class="settings-widget__head">
            <div class="settings-widget__icon settings-widget__icon--violet">
              <v-icon size="20">mdi-text</v-icon>
            </div>
            <div class="min-width-0">
              <h3 class="settings-widget__title">{{ formatChars(activePrompt?.contentChars) }}</h3>
              <p class="settings-widget__desc">символів в активній версії</p>
            </div>
          </div>
        </section>
      </div>

      <div class="prompt-grid">
        <article
          v-for="item in prompts"
          :key="item.id"
          class="settings-widget prompt-card"
          :class="{ 'settings-widget--ok': item.isActive }"
        >
          <div class="settings-widget__head settings-widget__head--row">
            <div class="settings-widget__head-text">
              <div
                class="settings-widget__icon"
                :class="item.isActive ? 'settings-widget__icon--green' : 'settings-widget__icon--slate'"
              >
                <v-icon size="20">{{ item.isActive ? 'mdi-check' : 'mdi-file-document-outline' }}</v-icon>
              </div>
              <div class="min-width-0">
                <h3 class="settings-widget__title">v{{ item.version }}</h3>
                <p class="settings-widget__desc">{{ formatDate(item.createdAt) }}</p>
              </div>
            </div>
            <v-chip
              :color="item.isActive ? 'success' : 'default'"
              size="small"
              variant="tonal"
              label
            >
              {{ item.isActive ? 'Активний' : 'Чернетка' }}
            </v-chip>
          </div>
          <div class="settings-widget__body">
            <div class="d-flex flex-wrap ga-2 mb-2">
              <v-chip size="small" variant="outlined" label>
                {{ authorLabel(item.author) }}
              </v-chip>
              <v-chip size="small" variant="tonal" label prepend-icon="mdi-text">
                {{ formatChars(item.contentChars) }} симв.
              </v-chip>
            </div>
            <p class="prompt-summary mb-0">{{ item.changeSummary || 'Без опису змін' }}</p>
          </div>
          <div class="prompt-card-actions">
            <v-btn
              variant="tonal"
              color="primary"
              class="tap-target"
              prepend-icon="mdi-text-box-outline"
              @click="openViewer(item)"
            >
              Текст
            </v-btn>
            <v-btn
              v-if="!item.isActive"
              variant="outlined"
              color="primary"
              class="tap-target"
              :loading="activatingId === item.id"
              @click="activatePrompt(item.id)"
            >
              Активувати
            </v-btn>
          </div>
        </article>
      </div>
    </template>

    <v-dialog
      v-model="viewerOpen"
      class="prompt-viewer-dialog"
      :fullscreen="mobile"
      max-width="920"
      scrollable
    >
      <v-card class="prompt-viewer">
        <v-card-title class="d-flex align-center ga-2 flex-wrap">
          <span>v{{ viewerPrompt?.version }}</span>
          <v-chip
            v-if="viewerPrompt"
            size="small"
            :color="viewerPrompt.isActive ? 'success' : 'default'"
            variant="tonal"
            label
          >
            {{ viewerPrompt.isActive ? 'Активний' : 'Чернетка' }}
          </v-chip>
          <v-spacer />
          <v-btn
            icon="mdi-close"
            variant="text"
            class="tap-target"
            aria-label="Закрити"
            @click="viewerOpen = false"
          />
        </v-card-title>
        <v-card-subtitle v-if="viewerPrompt" class="pb-2">
          {{ formatDate(viewerPrompt.createdAt) }}
          · {{ authorLabel(viewerPrompt.author) }}
          · {{ formatChars(viewerPrompt.contentChars) }} символів
        </v-card-subtitle>
        <v-card-text class="prompt-viewer-body">
          <p v-if="viewerPrompt?.changeSummary" class="prompt-summary prompt-summary--full mb-3">
            {{ viewerPrompt.changeSummary }}
          </p>
          <div v-if="viewerLoading" class="d-flex justify-center pa-8">
            <v-progress-circular indeterminate color="primary" />
          </div>
          <pre v-else class="prompt-viewer-text">{{ viewerContent }}</pre>
        </v-card-text>
      </v-card>
    </v-dialog>

    <!-- New/Edit prompt dialog -->
    <v-dialog
      v-model="dialogOpen"
      :fullscreen="mobile"
      :max-width="mobile ? undefined : 1000"
      scrollable
      persistent
    >
      <v-card
        class="agent-dialog-card"
        :class="{ 'agent-dialog-card--fullscreen': mobile }"
        :style="mobile ? undefined : { maxHeight: '90vh' }"
      >
        <v-card-title class="d-flex align-center ga-2 flex-shrink-0">
          Нова версія промпту
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="small" @click="closeDialog" :disabled="saving" />
        </v-card-title>

        <!-- Tabs: manual edit vs meta-agent -->
        <v-tabs v-model="editTab" color="primary" density="compact" class="px-2 px-sm-4 flex-shrink-0">
          <v-tab value="manual">
            <v-icon start size="18">mdi-pencil</v-icon>
            Вручну
          </v-tab>
          <v-tab value="agent">
            <v-icon start size="18">mdi-robot-outline</v-icon>
            Агент
          </v-tab>
        </v-tabs>

        <v-divider />

        <v-card-text class="agent-dialog-body">
          <!-- Manual tab -->
          <div v-if="editTab === 'manual'" class="manual-tab">
            <v-expansion-panels v-model="markdownHintOpen" class="manual-tab-hint mb-2">
              <v-expansion-panel value="hint">
                <v-expansion-panel-title class="text-body-2 py-2 min-h-0">
                  <v-icon start size="18" color="info">mdi-language-markdown-outline</v-icon>
                  Формат Markdown
                </v-expansion-panel-title>
                <v-expansion-panel-text>
                  <div class="text-body-2">
                    Зберігайте промпт у форматі <strong>Markdown</strong>.
                  </div>
                  <div class="text-caption mt-1">
                    Використовуйте <code>#</code>, <code>##</code> для заголовків,
                    <code>**жирний**</code>, <code>- список</code>, <code>`код`</code>,
                    <code>```блок```</code>. Це покращує структуру тексту для агента
                    та узгоджується з нашими шаблонами knowledge-файлів.
                  </div>
                </v-expansion-panel-text>
              </v-expansion-panel>
            </v-expansion-panels>

            <v-textarea
              v-model="newContent"
              label="Зміст промпту (Markdown)"
              variant="outlined"
              class="manual-tab-editor"
              :rows="mobile ? 12 : 18"
              no-resize
              hide-details
              :loading="seedingEditor"
              :placeholder="seedingEditor ? 'Завантажую активну версію…' : ''"
            />
          </div>

          <!-- Agent tab -->
          <div v-if="editTab === 'agent'" class="agent-tab">
            <v-alert type="info" variant="tonal" density="compact" class="mb-3 text-body-2">
              Опишіть зміни — агент запропонує правки. Після «Застосувати» перейдіть на вкладку «Вручну» і збережіть версію.
            </v-alert>

            <!-- Agent messages -->
            <div ref="agentMessagesEl" class="agent-messages mb-3">
              <div v-if="agentMessages.length === 0 && !agentLoading" class="text-center text-grey pa-6">
                <v-icon size="32" color="grey-lighten-1" class="mb-2">mdi-robot-happy-outline</v-icon>
                <div class="text-body-2">Напишіть що змінити, наприклад:</div>
                <div class="text-caption mt-1">"Додай правило про безкоштовну доставку від 2000 грн"</div>
              </div>

              <div
                v-for="(msg, idx) in agentMessages"
                :key="idx"
                class="mb-2 d-flex"
                :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
              >
                <div :style="{ maxWidth: mobile ? '90%' : '80%' }">
                  <div class="text-caption text-grey mb-1" :class="msg.role === 'user' ? 'text-right' : ''">
                    {{ msg.role === 'user' ? 'Ви' : 'Мета-агент' }}
                  </div>
                  <v-card
                    :color="msg.role === 'user' ? 'primary' : 'grey-lighten-4'"
                    variant="flat"
                    rounded="lg"
                    class="pa-3"
                  >
                    <div
                      class="meta-agent-md"
                      :class="{ 'meta-agent-md--on-primary': msg.role === 'user' }"
                      v-html="formatMetaAgentMarkdown(msg.content)"
                    />
                  </v-card>
                </div>
              </div>

              <div v-if="agentLoading" class="d-flex justify-start mb-2">
                <v-card color="grey-lighten-4" variant="flat" rounded="lg" class="pa-3 d-flex align-center">
                  <v-progress-circular indeterminate size="16" width="2" color="primary" />
                  <span class="text-body-2 text-grey ml-2">Аналізую...</span>
                </v-card>
              </div>
            </div>

            <!-- Suggested diff -->
            <v-card v-if="agentDiff" variant="outlined" class="mb-3 pa-3">
              <div class="d-flex align-center mb-2 flex-wrap ga-2">
                <div class="d-flex align-center">
                  <v-icon color="warning" size="18" class="mr-2">mdi-file-compare</v-icon>
                  <span class="text-subtitle-2">Пропоновані зміни</span>
                </div>
                <v-spacer v-if="!mobile" />
                <div class="d-flex ga-2" :class="mobile ? 'w-100' : ''">
                  <v-btn
                    size="small"
                    color="primary"
                    variant="flat"
                    :block="mobile"
                    :disabled="agentLoading"
                    @click="applyAgentDiff"
                  >
                    <v-icon start size="16">mdi-check</v-icon>
                    Застосувати
                  </v-btn>
                  <v-btn
                    size="small"
                    variant="outlined"
                    :block="mobile"
                    @click="agentDiff = null"
                  >
                    Відхилити
                  </v-btn>
                </div>
              </div>
              <v-alert type="info" variant="tonal" density="compact" class="mb-2 text-body-2">
                {{ agentDiff.summary }}
              </v-alert>
              <div class="diff-columns d-flex ga-2" :class="mobile ? 'flex-column' : 'flex-wrap'">
                <div class="flex-grow-1 diff-column">
                  <div class="text-caption font-weight-bold text-error mb-1">БУЛО</div>
                  <pre class="diff-block diff-before">{{ agentDiff.before }}</pre>
                </div>
                <div class="flex-grow-1 diff-column">
                  <div class="text-caption font-weight-bold text-success mb-1">СТАЛО</div>
                  <pre class="diff-block diff-after">{{ agentDiff.after }}</pre>
                </div>
              </div>
            </v-card>

            <!-- Agent input -->
            <div class="agent-chat-input d-flex ga-2 align-end">
              <v-textarea
                v-model="agentInput"
                placeholder="Опишіть зміни до промпту..."
                variant="outlined"
                density="compact"
                rows="1"
                max-rows="4"
                auto-grow
                hide-details
                :disabled="agentLoading"
                @keydown.enter.exact.prevent="sendToAgent"
                @keydown.shift.enter.stop
              />
              <v-btn
                color="primary"
                icon="mdi-send"
                class="agent-send-btn"
                :loading="agentLoading"
                :disabled="!agentInput.trim()"
                aria-label="Надіслати"
                @click="sendToAgent"
              />
            </div>
          </div>
        </v-card-text>

        <div v-if="editTab === 'manual'" class="agent-dialog-summary">
          <v-text-field
            v-model="newChangeSummary"
            label="Опис змін"
            placeholder="Коротко, що змінилось — для історії версій"
            hint="Необов'язково"
            persistent-hint
            variant="outlined"
            density="compact"
            hide-details="auto"
            clearable
          />
        </div>

        <v-divider />
        <v-card-actions class="agent-dialog-footer dialog-actions-stack">
          <div v-if="editTab === 'agent'" class="text-caption text-grey w-100 mb-1 d-sm-none">
            Збереження — на вкладці «Вручну» після застосування змін
          </div>
          <div
            v-else-if="editTab === 'manual' && newContent.trim()"
            class="text-caption text-grey w-100 mb-1 d-sm-none text-center"
          >
            {{ formatContentStats(newContent) }}
          </div>
          <v-spacer class="d-none d-sm-flex" />
          <v-btn variant="text" @click="closeDialog" :disabled="saving">
            Скасувати
          </v-btn>
          <v-btn
            v-if="editTab === 'manual'"
            color="primary"
            :loading="saving"
            :disabled="!newContent.trim() || seedingEditor"
            @click="createPrompt"
          >
            Зберегти нову версію
          </v-btn>
          <v-btn
            v-else
            color="primary"
            variant="tonal"
            @click="editTab = 'manual'"
          >
            Перейти до збереження
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-alert v-if="error" type="error" density="compact" class="mt-4">
      {{ error }}
    </v-alert>

    <v-snackbar v-model="snackbar" :color="snackbarColor" :timeout="3000">
      {{ snackbarText }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { computed, ref, nextTick, onMounted } from 'vue';
import { useDisplay } from 'vuetify';
import api from '@/api';
import { formatMetaAgentMarkdown } from '@/lib/metaAgentMarkdown';
import PageHeader from '@/components/PageHeader.vue';

const { mobile } = useDisplay();

interface Prompt {
  id: string;
  version: number;
  changeSummary: string | null;
  author: string;
  isActive: boolean;
  createdAt: string;
  contentChars: number;
}

interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface SuggestedDiff {
  before: string;
  after: string;
  summary: string;
}

const prompts = ref<Prompt[]>([]);
const loading = ref(false);
const error = ref('');

const dialogOpen = ref(false);
const editTab = ref('manual');
const markdownHintOpen = ref<string[]>([]);
const newContent = ref('');
const newChangeSummary = ref('');
const saving = ref(false);
const activatingId = ref<string | null>(null);

// Agent state
const agentMessages = ref<AgentMessage[]>([]);
const agentInput = ref('');
const agentLoading = ref(false);
const agentDiff = ref<SuggestedDiff | null>(null);
const agentMessagesEl = ref<HTMLElement | null>(null);

// Snackbar
const snackbar = ref(false);
const snackbarText = ref('');
const snackbarColor = ref('success');

const contentCache = new Map<string, string>();
const viewerOpen = ref(false);
const viewerId = ref<string | null>(null);
const viewerContent = ref('');
const viewerLoading = ref(false);
const seedingEditor = ref(false);

const activePrompt = computed(() => prompts.value.find((item) => item.isActive) ?? null);
const viewerPrompt = computed(
  () => prompts.value.find((item) => item.id === viewerId.value) ?? null,
);

function showSnack(text: string, color = 'success') {
  snackbarText.value = text;
  snackbarColor.value = color;
  snackbar.value = true;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('uk-UA');
}

function formatContentStats(content: string): string {
  const chars = content.length;
  const lines = content.split('\n').length;
  return `${chars.toLocaleString('uk-UA')} символів · ${lines} рядків`;
}

function formatChars(value: number | null | undefined): string {
  return (value ?? 0).toLocaleString('uk-UA');
}

function authorLabel(author: string): string {
  if (author === 'meta_agent') return 'Мета-агент';
  if (author === 'human') return 'Людина';
  return author || '—';
}

async function ensurePromptContent(id: string): Promise<string> {
  const cached = contentCache.get(id);
  if (cached != null) return cached;
  const { data } = await api.get(`/prompts/${id}`);
  const content = typeof data?.content === 'string' ? data.content : '';
  contentCache.set(id, content);
  return content;
}

async function openViewer(item: Prompt) {
  viewerId.value = item.id;
  viewerOpen.value = true;
  viewerContent.value = contentCache.get(item.id) ?? '';
  if (contentCache.has(item.id)) {
    viewerLoading.value = false;
    return;
  }
  viewerLoading.value = true;
  try {
    viewerContent.value = await ensurePromptContent(item.id);
  } catch {
    viewerContent.value = '';
    error.value = 'Не вдалося відкрити текст промпту';
    viewerOpen.value = false;
  } finally {
    viewerLoading.value = false;
  }
}

async function openNewDialog() {
  newContent.value = '';
  newChangeSummary.value = '';
  markdownHintOpen.value = mobile.value ? [] : ['hint'];
  agentMessages.value = [];
  agentInput.value = '';
  agentDiff.value = null;
  editTab.value = 'manual';
  dialogOpen.value = true;
  const active = activePrompt.value;
  if (!active) return;
  seedingEditor.value = true;
  try {
    newContent.value = await ensurePromptContent(active.id);
  } catch {
    error.value = 'Не вдалося взяти текст активної версії';
  } finally {
    seedingEditor.value = false;
  }
}

function closeDialog() {
  dialogOpen.value = false;
}

async function fetchPrompts() {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/prompts');
    const raw = data?.data;
    prompts.value = Array.isArray(raw) ? raw : [];
  } catch {
    error.value = 'Не вдалося завантажити промпти';
    prompts.value = [];
  } finally {
    loading.value = false;
  }
}

async function createPrompt() {
  saving.value = true;
  error.value = '';
  try {
    const summary = newChangeSummary.value.trim();
    await api.post('/prompts', {
      content: newContent.value.trim(),
      changeSummary: summary || null,
    });
    dialogOpen.value = false;
    await fetchPrompts();
    showSnack('Нову версію промпту збережено');
  } catch {
    error.value = 'Не вдалося створити промпт';
  } finally {
    saving.value = false;
  }
}

async function activatePrompt(id: string) {
  activatingId.value = id;
  error.value = '';
  try {
    const { data } = await api.post(`/prompts/${id}/activate`);
    await fetchPrompts();
    const version = data?.version != null ? `v${data.version}` : 'промпт';
    const gen =
      data?.runtimeGeneration != null ? ` (gen ${data.runtimeGeneration})` : '';
    showSnack(
      `${version} активовано${gen} — наступні повідомлення клієнтів використовуватимуть цю версію`,
    );
  } catch {
    error.value = 'Не вдалося активувати промпт';
  } finally {
    activatingId.value = null;
  }
}

// ── Meta-agent ───────────────────────────────────────────────────────────────

async function scrollAgentMessages() {
  await nextTick();
  if (agentMessagesEl.value) {
    agentMessagesEl.value.scrollTop = agentMessagesEl.value.scrollHeight;
  }
}

async function sendToAgent() {
  const text = agentInput.value.trim();
  if (!text || agentLoading.value) return;

  agentMessages.value.push({ role: 'user', content: text });
  agentInput.value = '';
  agentLoading.value = true;
  agentDiff.value = null;
  await scrollAgentMessages();

  try {
    // Send the draft currently being edited so the agent proposes diffs
    // against the visible text, not the stale DB-active prompt.
    const payload: Record<string, unknown> = {
      message: text,
      history: agentMessages.value.slice(0, -1),
    };
    if (newContent.value.trim()) {
      payload.currentPromptContent = newContent.value;
    }

    const { data } = await api.post('/meta-agent/chat', payload);

    agentMessages.value.push({ role: 'assistant', content: data.reply });

    if (data.suggestedDiff) {
      agentDiff.value = data.suggestedDiff;
    }
  } catch (e: any) {
    const errorMsg = e.response?.data?.error || 'Помилка зв\'язку з мета-агентом';
    agentMessages.value.push({ role: 'assistant', content: `Помилка: ${errorMsg}` });
  } finally {
    agentLoading.value = false;
    await scrollAgentMessages();
  }
}

function applyAgentDiff() {
  if (!agentDiff.value) return;

  // Apply diff to newContent: replace "before" with "after"
  const { before, after, summary } = agentDiff.value;

  if (before && newContent.value.includes(before)) {
    newContent.value = newContent.value.replace(before, after);
  } else {
    // If exact match not found, append the new text
    newContent.value = newContent.value + '\n\n' + after;
  }

  // Auto-fill change summary
  if (!newChangeSummary.value.trim()) {
    newChangeSummary.value = summary;
  }

  agentDiff.value = null;
  showSnack('Зміни застосовано до тексту промпту');

  // Switch to manual tab to see the result
  editTab.value = 'manual';
}

onMounted(() => {
  fetchPrompts();
});
</script>

<style scoped>
.manual-tab {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  height: 100%;
}

.manual-tab-hint {
  flex-shrink: 0;
}

.manual-tab-editor {
  flex: 1 1 auto;
  min-height: 0;
}

.manual-tab-editor :deep(.v-input) {
  height: 100%;
}

.manual-tab-editor :deep(.v-field) {
  height: 100%;
}

.manual-tab-editor :deep(.v-field__field) {
  align-items: stretch;
}

.manual-tab-editor :deep(textarea) {
  min-height: min(320px, 45dvh);
  height: 100% !important;
  overflow-y: auto !important;
}

@media (min-width: 600px) {
  .manual-tab-editor :deep(textarea) {
    min-height: min(420px, 52dvh);
  }
}

.agent-tab {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.agent-messages {
  flex: 1 1 auto;
  min-height: 120px;
  max-height: min(320px, 42dvh);
  overflow-y: auto;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
  padding: 12px;
  -webkit-overflow-scrolling: touch;
}

.diff-column {
  min-width: 0;
}

.diff-block {
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Roboto Mono', 'Courier New', monospace;
  max-height: min(150px, 22dvh);
  overflow-y: auto;
}

.change-summary-full {
  white-space: pre-wrap;
  word-break: break-word;
}

.prompt-stats,
.prompt-grid {
  display: grid;
  gap: 14px;
}

.prompt-stats {
  grid-template-columns: 1fr;
}

.prompt-grid {
  grid-template-columns: 1fr;
}

@media (min-width: 720px) {
  .prompt-stats {
    grid-template-columns: minmax(0, 1.6fr) minmax(140px, 0.7fr) minmax(160px, 0.8fr);
  }

  .prompt-grid {
    grid-template-columns: 1fr 1fr;
  }
}

.settings-widget {
  background: #fff;
  border: 1px solid #d9e2ec;
  border-radius: 14px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px rgba(15, 23, 42, 0.04);
  overflow: clip;
  min-width: 0;
}

.settings-widget--ok {
  border-color: #b7e4c7;
  background: linear-gradient(180deg, #f4fbf7 0%, #fff 55%);
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
  color: #0a2540;
}

.settings-widget__icon--violet { background: #ecebff; color: #4f46e5; }
.settings-widget__icon--blue { background: #e8f1ff; color: #2563eb; }
.settings-widget__icon--green { background: #e6f7ef; color: #0f766e; }
.settings-widget__icon--slate { background: #eef2f6; color: #334155; }

.settings-widget__title {
  margin: 0;
  font-size: 1.02rem;
  font-weight: 650;
  letter-spacing: -0.015em;
  color: #0a2540;
  line-height: 1.3;
}

.settings-widget__desc {
  margin: 2px 0 0;
  font-size: 0.82rem;
  line-height: 1.35;
  color: #425466;
}

.settings-widget__body {
  padding: 12px 16px 16px;
}

.prompt-summary {
  margin: 0;
  color: #1c3348;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
  word-break: break-word;
}

.prompt-summary--full {
  display: block;
  -webkit-line-clamp: unset;
  overflow: visible;
  white-space: pre-wrap;
}

.prompt-stats > .settings-widget > .settings-widget__head:last-child {
  padding-bottom: 16px;
}

.prompt-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 16px 16px;
}

.prompt-viewer {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 100dvh;
}

.prompt-viewer-body {
  min-height: 0;
  overflow: auto;
}

.prompt-viewer-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Roboto Mono', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
  color: #0a2540;
  padding: 14px;
  border-radius: 12px;
  border: 1px solid #d9e2ec;
  background: #f7f9fc;
  max-height: min(68dvh, 720px);
  overflow: auto;
}

@media (max-width: 959px) {
  .prompt-viewer {
    height: 100%;
    border-radius: 0;
  }

  .prompt-viewer-text {
    max-height: none;
  }
}

.diff-before {
  background-color: #fef2f2;
  border: 1px solid #fecaca;
}

.diff-after {
  background-color: #f0fdf4;
  border: 1px solid #bbf7d0;
}

@media (max-width: 960px) {
  .agent-messages {
    max-height: min(280px, 38dvh);
  }

  .agent-tab {
    min-height: calc(100dvh - 220px);
  }
}
</style>
