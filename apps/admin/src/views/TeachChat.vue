<template>
  <v-container fluid class="d-flex flex-column pa-2 pa-md-4" style="height: calc(100vh - 64px);">
    <!-- Header -->
    <div class="d-flex align-center ga-3 mb-3 px-1">
      <div class="flex-grow-1">
        <div class="page-title" style="font-size: 18px;">Навчання агента</div>
        <div class="page-subtitle d-none d-sm-block">Опишіть зміни — мета-агент запропонує правки до промпту</div>
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
            :class="{ 'diff-item-applied': appliedIndexes.has(idx) }"
          >
            <!-- Зміна N / Applied badge -->
            <div class="d-flex align-center ga-2 mb-2">
              <span class="text-caption font-weight-bold text-grey">
                {{ currentDiffs.length > 1 ? `ЗМІНА ${idx + 1}` : 'ЗМІНА' }}
              </span>
              <v-chip v-if="appliedIndexes.has(idx)" size="x-small" color="success" variant="flat">
                <v-icon start size="10">mdi-check</v-icon>застосовано
              </v-chip>
            </div>

            <v-alert v-if="diff.summary" type="info" variant="tonal" density="compact" class="mb-2 text-body-2">
              {{ diff.summary }}
            </v-alert>

            <div class="text-caption font-weight-bold mb-1 text-error d-flex align-center">
              <v-icon size="14" color="error" class="mr-1">mdi-minus-circle</v-icon>
              БУЛО
            </div>
            <pre class="diff-block diff-before mb-2">{{ diff.before || '(порожньо — нове правило)' }}</pre>

            <div class="text-caption font-weight-bold mb-1 text-success d-flex align-center">
              <v-icon size="14" color="success" class="mr-1">mdi-plus-circle</v-icon>
              СТАЛО
            </div>
            <pre class="diff-block diff-after mb-2">{{ diff.after }}</pre>

            <!-- Per-diff apply button -->
            <div class="d-flex justify-end">
              <v-btn
                v-if="!appliedIndexes.has(idx)"
                color="primary"
                size="x-small"
                variant="tonal"
                :loading="applyingIndex === idx"
                :disabled="applyingIndex !== null && applyingIndex !== idx"
                @click="applyDiffAt(idx)"
              >
                <v-icon start size="14">mdi-check</v-icon>
                Застосувати
              </v-btn>
            </div>
          </div>
        </div>

        <v-divider />
        <div class="pa-3 d-flex ga-2">
          <v-btn variant="outlined" size="small" :disabled="applyingIndex !== null" @click="rejectDiff">
            {{ appliedIndexes.size > 0 ? 'Закрити' : 'Відхилити всі' }}
          </v-btn>
          <v-spacer />
          <v-btn
            v-if="unappliedDiffs.length > 1"
            color="primary"
            size="small"
            :loading="applyingIndex !== null"
            @click="applyAllDiffs"
          >
            <v-icon start size="16">mdi-check-all</v-icon>
            Застосувати всі ({{ unappliedDiffs.length }})
          </v-btn>
        </div>
      </v-card>
    </div>

    <v-snackbar v-model="snackbar" :color="snackbarColor" :timeout="3000">
      {{ snackbarText }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from 'vue';
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

const messages = ref<ChatMessage[]>([]);
const inputText = ref('');
const loading = ref(false);
const currentDiffs = ref<SuggestedDiff[]>([]);
const appliedIndexes = ref<Set<number>>(new Set());
const applyingIndex = ref<number | null>(null);
const messagesContainer = ref<HTMLElement | null>(null);

const snackbar = ref(false);
const snackbarText = ref('');
const snackbarColor = ref('success');

const unappliedDiffs = computed(() =>
  currentDiffs.value.filter((_, i) => !appliedIndexes.value.has(i)),
);

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

async function sendMessage() {
  const text = inputText.value.trim();
  if (!text || loading.value) return;

  messages.value.push({ role: 'user', content: text });
  inputText.value = '';
  loading.value = true;
  currentDiffs.value = [];
  appliedIndexes.value = new Set();
  await scrollToBottom();

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

async function applyDiffAt(idx: number) {
  const diff = currentDiffs.value[idx];
  if (!diff || applyingIndex.value !== null) return;

  applyingIndex.value = idx;
  try {
    await api.post('/meta-agent/apply', {
      before: diff.before,
      after: diff.after,
      summary: diff.summary,
    });
    appliedIndexes.value = new Set([...appliedIndexes.value, idx]);
    showSnackbar(
      currentDiffs.value.length > 1
        ? `Зміна ${idx + 1} застосована!`
        : 'Промпт оновлено!',
    );
  } catch (e: any) {
    showSnackbar(e.response?.data?.error || 'Не вдалося застосувати', 'error');
  } finally {
    applyingIndex.value = null;
  }
}

async function applyAllDiffs() {
  for (let i = 0; i < currentDiffs.value.length; i++) {
    if (!appliedIndexes.value.has(i)) {
      await applyDiffAt(i);
    }
  }
  showSnackbar('Всі зміни застосовано!');
}

function rejectDiff() {
  currentDiffs.value = [];
  appliedIndexes.value = new Set();
}

function clearChat() {
  messages.value = [];
  currentDiffs.value = [];
  appliedIndexes.value = new Set();
  inputText.value = '';
}
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
