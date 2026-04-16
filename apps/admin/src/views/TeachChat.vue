<template>
  <v-container fluid class="d-flex flex-column pa-2 pa-md-4" style="height: calc(100vh - 64px);">
    <!-- Header -->
    <v-card class="mb-2 mb-md-3" flat>
      <v-card-text class="d-flex align-center ga-2 pa-2 pa-md-3">
        <v-icon color="primary" size="24">mdi-robot-outline</v-icon>
        <div class="flex-grow-1">
          <div class="text-subtitle-2 text-md-subtitle-1 font-weight-bold">Навчання агента</div>
          <div class="text-caption text-grey d-none d-sm-block">
            Опишіть зміни — мета-агент запропонує правки до промпту
          </div>
        </div>
        <v-btn
          variant="text"
          size="small"
          icon="mdi-delete-outline"
          :disabled="messages.length === 0"
          @click="clearChat"
        />
      </v-card-text>
    </v-card>

    <!-- Main content -->
    <div class="flex-grow-1 d-flex flex-column flex-md-row ga-2 ga-md-3" style="min-height: 0; overflow: hidden;">
      <!-- Chat panel -->
      <v-card
        class="d-flex flex-column"
        :class="currentDiff ? 'chat-with-diff' : 'flex-grow-1'"
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

      <!-- Diff panel -->
      <v-card v-if="currentDiff" class="diff-panel d-flex flex-column" flat style="min-height: 0;">
        <v-card-title class="text-subtitle-2 pa-3 d-flex align-center">
          <v-icon start color="warning" size="20">mdi-file-compare</v-icon>
          Пропоновані зміни
        </v-card-title>

        <div class="flex-grow-1 overflow-y-auto px-3 pb-3">
          <v-alert type="info" variant="tonal" density="compact" class="mb-3 text-body-2">
            {{ currentDiff.summary }}
          </v-alert>

          <div class="text-caption font-weight-bold mb-1 text-error d-flex align-center">
            <v-icon size="14" color="error" class="mr-1">mdi-minus-circle</v-icon>
            БУЛО
          </div>
          <pre class="diff-block diff-before mb-3">{{ currentDiff.before }}</pre>

          <div class="text-caption font-weight-bold mb-1 text-success d-flex align-center">
            <v-icon size="14" color="success" class="mr-1">mdi-plus-circle</v-icon>
            СТАЛО
          </div>
          <pre class="diff-block diff-after">{{ currentDiff.after }}</pre>
        </div>

        <v-divider />
        <div class="pa-3 d-flex ga-2">
          <v-btn variant="outlined" size="small" :disabled="applying" @click="rejectDiff">
            Відхилити
          </v-btn>
          <v-spacer />
          <v-btn color="primary" size="small" :loading="applying" @click="applyDiff">
            <v-icon start size="16">mdi-check</v-icon>
            Застосувати
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
import { ref, nextTick } from 'vue';
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
const currentDiff = ref<SuggestedDiff | null>(null);
const applying = ref(false);
const messagesContainer = ref<HTMLElement | null>(null);

const snackbar = ref(false);
const snackbarText = ref('');
const snackbarColor = ref('success');

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

  // Bold: **text** or ЗАГОЛОВКИ
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Code blocks: ```...```
  html = html.replace(/```([\s\S]*?)```/g, '<pre class="code-inline">$1</pre>');

  // Inline code: `text`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Section headers: --- БУЛО --- / --- СТАЛО --- / ПОЯСНЕННЯ:
  html = html.replace(/^(---\s*.+?\s*---)/gm, '<strong class="text-primary">$1</strong>');
  html = html.replace(/^(ПОЯСНЕННЯ:)/gm, '<strong class="text-info">$1</strong>');

  // Line breaks
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
  currentDiff.value = null;
  await scrollToBottom();

  try {
    const { data } = await api.post('/meta-agent/chat', {
      message: text,
      history: messages.value.slice(0, -1),
    });

    messages.value.push({ role: 'assistant', content: data.reply });

    if (data.suggestedDiff) {
      currentDiff.value = data.suggestedDiff;
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

async function applyDiff() {
  if (!currentDiff.value) return;
  applying.value = true;
  try {
    await api.post('/meta-agent/apply', {
      after: currentDiff.value.after,
      summary: currentDiff.value.summary,
    });
    showSnackbar('Промпт оновлено!');
    currentDiff.value = null;
  } catch (e: any) {
    showSnackbar(e.response?.data?.error || 'Не вдалося застосувати', 'error');
  } finally {
    applying.value = false;
  }
}

function rejectDiff() {
  currentDiff.value = null;
}

function clearChat() {
  messages.value = [];
  currentDiff.value = null;
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
