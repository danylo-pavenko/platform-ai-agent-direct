<template>
  <v-container fluid class="d-flex flex-column pa-2 pa-md-4" style="height: calc(100vh - 64px);">
    <!-- Header -->
    <div class="d-flex align-center ga-3 mb-3 px-1">
      <div class="flex-grow-1">
        <div class="page-title" style="font-size: 18px;">Навчання агента</div>
        <div class="page-subtitle d-none d-sm-block">Опишіть зміни - мета-агент запропонує правки до промпту</div>
      </div>
      <v-btn
        variant="tonal"
        size="small"
        icon="mdi-delete-outline"
        :disabled="messages.length === 0"
        @click="clearChat"
      />
    </div>

    <!-- Main content -->
    <div class="flex-grow-1 d-flex flex-column flex-md-row ga-2 ga-md-3" style="min-height: 0; overflow: hidden;">
      <!-- Chat panel -->
      <v-card
        class="d-flex flex-column"
        :class="currentDiffs.length > 0 ? 'chat-with-diff' : 'flex-grow-1'"
        flat
        style="min-height: 0;"
      >
        <!-- Messages -->
        <div
          ref="messagesContainer"
          class="flex-grow-1 overflow-y-auto pa-3 pa-md-4"
          style="min-height: 0;"
        >
          <!-- Empty state -->
          <div
            v-if="messages.length === 0 && !loading"
            class="d-flex flex-column align-center justify-center text-center"
            style="height: 100%;"
          >
            <v-icon size="48" color="grey-lighten-1" class="mb-3">mdi-chat-outline</v-icon>
            <div class="text-body-1 text-grey-darken-1 mb-1">Почніть розмову</div>
            <div class="text-body-2 text-grey px-4" style="max-width: 360px;">
              Наприклад: "Додай правило про безкоштовну доставку від 2000 грн"
            </div>
          </div>

          <!-- Messages -->
          <div
            v-for="(msg, idx) in messages"
            :key="idx"
            class="mb-3 d-flex"
            :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
          >
            <div :style="{ maxWidth: mobile ? '90%' : '75%' }">
              <div
                class="text-caption text-grey mb-1"
                :class="msg.role === 'user' ? 'text-right' : ''"
              >
                {{ msg.role === 'user' ? 'Ви' : 'Мета-агент' }}
              </div>
              <v-card
                :color="msg.role === 'user' ? 'primary' : 'grey-lighten-4'"
                :variant="msg.role === 'user' ? 'flat' : 'flat'"
                rounded="lg"
                class="pa-3"
              >
                <div
                  class="text-body-2 msg-content"
                  :class="{ 'text-white': msg.role === 'user' }"
                  v-html="formatMessage(msg.content)"
                />
              </v-card>
            </div>
          </div>

          <!-- Loading -->
          <div v-if="loading" class="d-flex justify-start mb-3">
            <v-card color="grey-lighten-4" variant="flat" rounded="lg" class="pa-3 d-flex align-center">
              <v-progress-circular indeterminate size="18" width="2" color="primary" />
              <span class="text-body-2 text-grey ml-2">Аналізую промпт...</span>
            </v-card>
          </div>
        </div>

        <!-- Input -->
        <v-divider />
        <div class="pa-2 pa-md-3">
          <div class="d-flex ga-2 align-end">
            <v-textarea
              v-model="inputText"
              placeholder="Опишіть зміни до промпту..."
              variant="outlined"
              density="compact"
              rows="1"
              max-rows="4"
              auto-grow
              hide-details
              :disabled="loading"
              @keydown.ctrl.enter="sendMessage"
              @keydown.meta.enter="sendMessage"
            />
            <v-btn
              color="primary"
              icon="mdi-send"
              :loading="loading"
              :disabled="!inputText.trim()"
              size="small"
              @click="sendMessage"
            />
          </div>
        </div>
      </v-card>

      <!-- Diff panel(s) -->
      <v-card v-if="currentDiffs.length > 0" class="diff-panel d-flex flex-column" flat style="min-height: 0;">
        <v-card-title class="text-subtitle-2 pa-3 d-flex align-center">
          <v-icon start color="warning" size="20">mdi-file-compare</v-icon>
          Пропоновані зміни
          <v-chip v-if="currentDiffs.length > 1" size="x-small" color="warning" variant="tonal" class="ml-2">
            {{ currentDiffs.length }} зміни
          </v-chip>
        </v-card-title>

        <div class="flex-grow-1 overflow-y-auto px-3 pb-3">
          <div
            v-for="(diff, idx) in currentDiffs"
            :key="idx"
            class="diff-item mb-4"
            :class="{ 'diff-item-applied': appliedResults.has(idx) }"
          >
            <!-- Зміна N / Applied badge -->
            <div class="d-flex align-center ga-2 mb-2">
              <span class="text-caption font-weight-bold text-grey">
                {{ currentDiffs.length > 1 ? `ЗМІНА ${idx + 1}` : 'ЗМІНА' }}
              </span>
              <v-chip
                v-if="appliedResults.get(idx)?.activated"
                size="x-small"
                color="success"
                variant="flat"
              >
                <v-icon start size="10">mdi-check</v-icon>
                v{{ appliedResults.get(idx)?.version }} активна
              </v-chip>
              <v-chip
                v-else-if="appliedResults.has(idx)"
                size="x-small"
                color="info"
                variant="tonal"
              >
                <v-icon start size="10">mdi-file-document-edit-outline</v-icon>
                чернетка v{{ appliedResults.get(idx)?.version }}
              </v-chip>
            </div>

            <v-alert v-if="diff.summary" type="info" variant="tonal" density="compact" class="mb-2 text-body-2">
              {{ diff.summary }}
            </v-alert>

            <div class="text-caption font-weight-bold mb-1 text-error d-flex align-center">
              <v-icon size="14" color="error" class="mr-1">mdi-minus-circle</v-icon>
              БУЛО
            </div>
            <pre class="diff-block diff-before mb-2">{{ diff.before || '(порожньо - нове правило)' }}</pre>

            <div class="text-caption font-weight-bold mb-1 text-success d-flex align-center">
              <v-icon size="14" color="success" class="mr-1">mdi-plus-circle</v-icon>
              СТАЛО
            </div>
            <pre class="diff-block diff-after mb-2">{{ diff.after }}</pre>

            <!-- Per-diff action row: default is safe draft, activation opt-in -->
            <div class="d-flex justify-end ga-2 flex-wrap">
              <template v-if="!appliedResults.has(idx)">
                <v-btn
                  color="primary"
                  size="x-small"
                  variant="tonal"
                  :loading="applyingIndex === idx"
                  :disabled="applyingIndex !== null && applyingIndex !== idx"
                  @click="applyDiffAt(idx, { activate: false })"
                >
                  <v-icon start size="14">mdi-file-document-edit-outline</v-icon>
                  Зберегти як чернетку
                </v-btn>
                <v-btn
                  color="warning"
                  size="x-small"
                  variant="outlined"
                  :disabled="applyingIndex !== null"
                  @click="openActivateConfirm(idx)"
                >
                  <v-icon start size="14">mdi-flash</v-icon>
                  Зберегти і активувати
                </v-btn>
              </template>
              <v-btn
                v-else-if="!appliedResults.get(idx)?.activated"
                color="warning"
                size="x-small"
                variant="outlined"
                :loading="activatingPromptId === appliedResults.get(idx)?.promptId"
                :disabled="activatingPromptId !== null"
                @click="openActivateConfirm(idx)"
              >
                <v-icon start size="14">mdi-flash</v-icon>
                Активувати зараз
              </v-btn>
            </div>
          </div>
        </div>

        <v-divider />
        <div class="pa-3">
          <div
            v-if="activeBaseVersion !== null"
            class="text-caption text-grey mb-2"
          >
            Зміни застосовуються до активної v{{ activeBaseVersion }}. Чернетки не впливають на прод — активуйте явно.
          </div>
          <div class="d-flex ga-2 align-center">
            <v-btn variant="outlined" size="small" :disabled="applyingIndex !== null" @click="rejectDiff">
              {{ appliedResults.size > 0 ? 'Закрити' : 'Відхилити всі' }}
            </v-btn>
            <v-spacer />
            <v-btn
              v-if="unappliedDiffs.length > 1"
              color="primary"
              size="small"
              variant="tonal"
              :loading="applyingIndex !== null"
              @click="applyAllDiffs"
            >
              <v-icon start size="16">mdi-check-all</v-icon>
              Зберегти всі як чернетки ({{ unappliedDiffs.length }})
            </v-btn>
          </div>
        </div>
      </v-card>
    </div>

    <!-- Activate confirmation -->
    <v-dialog v-model="activateDialogOpen" max-width="480" persistent>
      <v-card>
        <v-card-title class="text-subtitle-1">
          Активувати зміну одразу?
        </v-card-title>
        <v-card-text class="text-body-2">
          Активна версія промпту буде змінена миттєво — бот почне використовувати новий текст з наступного повідомлення клієнта.
          Попередня активна версія залишиться в історії як неактивна, її можна буде повернути.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmActivate = null">Скасувати</v-btn>
          <v-btn
            color="warning"
            variant="flat"
            :loading="applyingIndex !== null || activatingPromptId !== null"
            @click="confirmActivateNow"
          >
            Так, активувати
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="snackbar" :color="snackbarColor" :timeout="3000">
      {{ snackbarText }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue';
import { useDisplay } from 'vuetify';
import api from '@/api';

const { mobile } = useDisplay();

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface SuggestedDiff {
  before: string;
  after: string;
  summary: string;
}

interface AppliedResult {
  promptId: string;
  version: number;
  activated: boolean;
}

const messages = ref<ChatMessage[]>([]);
const inputText = ref('');
const loading = ref(false);
const currentDiffs = ref<SuggestedDiff[]>([]);
// Maps diff index → what was created when the user applied it.
// Used to render "v{N} • чернетка" badge and the "Активувати зараз" button.
const appliedResults = ref<Map<number, AppliedResult>>(new Map());
const applyingIndex = ref<number | null>(null);
const activatingPromptId = ref<string | null>(null);
const messagesContainer = ref<HTMLElement | null>(null);

// Optimistic concurrency: the id of the active prompt at the moment the
// user's diff was generated. Sent with /apply so a stale diff (another admin
// activated something in between) is rejected with 409 instead of silently
// rebasing onto the new active.
const activeBasePromptId = ref<string | null>(null);
const activeBaseVersion = ref<number | null>(null);

// Confirmation dialog for direct activation.
const confirmActivate = ref<{ diffIdx: number } | null>(null);

const snackbar = ref(false);
const snackbarText = ref('');
const snackbarColor = ref('success');

const unappliedDiffs = computed(() =>
  currentDiffs.value.filter((_, i) => !appliedResults.value.has(i)),
);

const activateDialogOpen = computed({
  get: () => confirmActivate.value !== null,
  set: (v) => { if (!v) confirmActivate.value = null; },
});

function showSnackbar(text: string, color = 'success') {
  snackbarText.value = text;
  snackbarColor.value = color;
  snackbar.value = true;
}

/** Format message text: convert markdown-like markers to styled HTML */
function formatMessage(text: string): string {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/```([\s\S]*?)```/g, '<pre class="code-inline">$1</pre>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^(---\s*.+?\s*---)/gm, '<strong class="text-primary">$1</strong>');
  html = html.replace(/^(ПОЯСНЕННЯ(?:\s*\d+)?:)/gm, '<strong class="text-info">$1</strong>');
  html = html.replace(/\n/g, '<br>');

  return html;
}

async function scrollToBottom() {
  await nextTick();
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }
}

/** Fetch currently active prompt id/version for optimistic concurrency. */
async function loadActiveBase() {
  try {
    const { data } = await api.get('/prompts');
    const raw = Array.isArray(data?.data) ? data.data : [];
    const active = raw.find((p: { isActive: boolean }) => p.isActive);
    if (active) {
      activeBasePromptId.value = active.id;
      activeBaseVersion.value = active.version;
    } else {
      activeBasePromptId.value = null;
      activeBaseVersion.value = null;
    }
  } catch {
    // Non-fatal: we'll just skip concurrency check if we couldn't load.
    activeBasePromptId.value = null;
    activeBaseVersion.value = null;
  }
}

async function sendMessage() {
  const text = inputText.value.trim();
  if (!text || loading.value) return;

  messages.value.push({ role: 'user', content: text });
  inputText.value = '';
  loading.value = true;
  currentDiffs.value = [];
  appliedResults.value = new Map();
  await scrollToBottom();

  // Refresh base-id on every new chat turn so 409s track the actual live state.
  await loadActiveBase();

  try {
    const { data } = await api.post('/meta-agent/chat', {
      message: text,
      history: messages.value.slice(0, -1),
    });

    messages.value.push({ role: 'assistant', content: data.reply });

    if (data.suggestedDiffs && data.suggestedDiffs.length > 0) {
      currentDiffs.value = data.suggestedDiffs;
    } else if (data.suggestedDiff) {
      currentDiffs.value = [data.suggestedDiff];
    }
  } catch (e: any) {
    const errorMsg = e.response?.data?.error || 'Помилка зв\'язку з мета-агентом';
    messages.value.push({ role: 'assistant', content: `Помилка: ${errorMsg}` });
    showSnackbar(errorMsg, 'error');
  } finally {
    loading.value = false;
    await scrollToBottom();
  }
}

async function applyDiffAt(idx: number, opts: { activate?: boolean } = {}) {
  const diff = currentDiffs.value[idx];
  if (!diff || applyingIndex.value !== null) return;

  const activate = opts.activate === true;
  applyingIndex.value = idx;
  try {
    const { data } = await api.post('/meta-agent/apply', {
      before: diff.before,
      after: diff.after,
      summary: diff.summary,
      activate,
      basePromptId: activeBasePromptId.value,
    });

    const next = new Map(appliedResults.value);
    next.set(idx, {
      promptId: data.id,
      version: data.version,
      activated: data.isActive === true,
    });
    appliedResults.value = next;

    // If we just activated, this version is now the base for any follow-ups.
    if (data.isActive) {
      activeBasePromptId.value = data.id;
      activeBaseVersion.value = data.version;
    }

    showSnackbar(
      activate
        ? `v${data.version} активовано`
        : `Чернетку v${data.version} створено`,
    );
  } catch (e: any) {
    const status = e.response?.status;
    const errorMsg = e.response?.data?.error || 'Не вдалося застосувати';
    if (status === 409) {
      // Someone else activated a new version in the meantime. Clear diffs,
      // refresh base, tell the user to restate the request.
      const newActive = e.response?.data?.currentActiveVersion;
      currentDiffs.value = [];
      appliedResults.value = new Map();
      await loadActiveBase();
      showSnackbar(
        newActive
          ? `Активний промпт змінився на v${newActive}. Переформулюйте запит.`
          : errorMsg,
        'warning',
      );
    } else {
      showSnackbar(errorMsg, 'error');
    }
  } finally {
    applyingIndex.value = null;
  }
}

async function applyAllDiffs() {
  for (let i = 0; i < currentDiffs.value.length; i++) {
    if (!appliedResults.value.has(i)) {
      // Bail out of the loop if one apply failed (409 clears diffs entirely).
      if (currentDiffs.value.length === 0) return;
      await applyDiffAt(i, { activate: false });
    }
  }
  showSnackbar('Всі зміни збережено як чернетки');
}

function openActivateConfirm(idx: number) {
  confirmActivate.value = { diffIdx: idx };
}

async function confirmActivateNow() {
  if (!confirmActivate.value) return;
  const idx = confirmActivate.value.diffIdx;
  confirmActivate.value = null;

  // If this diff was already saved as a draft, just activate that row
  // instead of creating yet another version with identical content.
  const existing = appliedResults.value.get(idx);
  if (existing && !existing.activated) {
    await activateExistingDraft(existing.promptId);
    return;
  }

  await applyDiffAt(idx, { activate: true });
}

async function activateExistingDraft(promptId: string) {
  if (activatingPromptId.value) return;
  activatingPromptId.value = promptId;
  try {
    await api.post(`/prompts/${promptId}/activate`);
    // Mark the local entry as activated so the UI hides the "активувати" button.
    const next = new Map(appliedResults.value);
    for (const [idx, r] of next.entries()) {
      if (r.promptId === promptId) {
        next.set(idx, { ...r, activated: true });
      }
    }
    appliedResults.value = next;
    activeBasePromptId.value = promptId;
    const justActivated = [...appliedResults.value.values()].find((r) => r.promptId === promptId);
    if (justActivated) activeBaseVersion.value = justActivated.version;
    showSnackbar('Версію активовано');
  } catch (e: any) {
    showSnackbar(e.response?.data?.error || 'Не вдалося активувати', 'error');
  } finally {
    activatingPromptId.value = null;
  }
}

function rejectDiff() {
  currentDiffs.value = [];
  appliedResults.value = new Map();
}

function clearChat() {
  messages.value = [];
  currentDiffs.value = [];
  appliedResults.value = new Map();
  inputText.value = '';
}

onMounted(() => {
  loadActiveBase();
});
</script>

<style scoped>
.chat-with-diff {
  flex: 1 1 55%;
  min-width: 0;
}

.diff-panel {
  flex: 1 1 45%;
  min-width: 0;
}

/* Mobile: stack vertically */
@media (max-width: 960px) {
  .chat-with-diff {
    flex: 1 1 60%;
  }
  .diff-panel {
    flex: 0 0 40%;
  }
}

.diff-block {
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Roboto Mono', 'Courier New', monospace;
  max-height: 250px;
  overflow-y: auto;
}

.diff-before {
  background-color: #fef2f2;
  border: 1px solid #fecaca;
}

.diff-after {
  background-color: #f0fdf4;
  border: 1px solid #bbf7d0;
}

:deep(.msg-content) {
  line-height: 1.6;
  word-break: break-word;
}

:deep(.msg-content br + br) {
  display: block;
  content: '';
  margin-top: 4px;
}

:deep(.msg-content code) {
  background: rgba(0,0,0,0.06);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 0.9em;
}

:deep(.msg-content pre.code-inline) {
  background: rgba(0,0,0,0.06);
  padding: 8px 12px;
  border-radius: 6px;
  margin: 8px 0;
  font-size: 12px;
  overflow-x: auto;
}
</style>
