<template>
  <v-container fluid class="d-flex flex-column" style="height: calc(100vh - 24px);">
    <!-- Header -->
    <v-card class="mb-3" flat>
      <v-card-text class="d-flex align-center ga-3 pa-3">
        <v-icon color="primary" size="28">mdi-robot-outline</v-icon>
        <div>
          <div class="text-subtitle-1 font-weight-bold">Навчання агента</div>
          <div class="text-caption text-grey">
            Чат з мета-агентом для редагування промпту
          </div>
        </div>
        <v-spacer />
        <v-btn
          variant="text"
          size="small"
          prepend-icon="mdi-delete-outline"
          :disabled="messages.length === 0"
          @click="clearChat"
        >
          Очистити
        </v-btn>
      </v-card-text>
    </v-card>

    <!-- Main content area -->
    <v-row class="flex-grow-1" style="min-height: 0;" no-gutters>
      <!-- Chat panel -->
      <v-col :cols="currentDiff ? 7 : 12" class="d-flex flex-column" style="min-height: 0;">
        <v-card class="flex-grow-1 overflow-hidden d-flex flex-column" flat>
          <!-- Messages -->
          <div
            ref="messagesContainer"
            class="flex-grow-1 overflow-y-auto pa-4"
            style="min-height: 0;"
          >
            <!-- Empty state -->
            <div
              v-if="messages.length === 0 && !loading"
              class="d-flex flex-column align-center justify-center"
              style="height: 100%;"
            >
              <v-icon size="64" color="grey-lighten-1" class="mb-4">
                mdi-chat-outline
              </v-icon>
              <div class="text-h6 text-grey-lighten-1 mb-2">
                Почніть розмову
              </div>
              <div class="text-body-2 text-grey text-center" style="max-width: 400px;">
                Опишіть, що потрібно змінити в промпті агента. Мета-агент
                запропонує зміни, які ви зможете переглянути та застосувати.
              </div>
            </div>

            <!-- Message bubbles -->
            <div
              v-for="(msg, idx) in messages"
              :key="idx"
              class="mb-3 d-flex"
              :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
            >
              <div style="max-width: 80%;">
                <v-card
                  :color="msg.role === 'user' ? 'primary' : 'grey-lighten-3'"
                  :variant="msg.role === 'user' ? 'flat' : 'tonal'"
                  rounded="lg"
                  class="pa-3"
                >
                  <div
                    class="text-body-2"
                    :class="{ 'text-white': msg.role === 'user' }"
                    style="white-space: pre-wrap; word-break: break-word;"
                  >
                    {{ msg.content }}
                  </div>
                </v-card>
                <div
                  class="text-caption text-grey mt-1"
                  :class="msg.role === 'user' ? 'text-right' : ''"
                >
                  {{ msg.role === 'user' ? 'Ви' : 'Мета-агент' }}
                </div>
              </div>
            </div>

            <!-- Loading indicator -->
            <div v-if="loading" class="d-flex justify-start mb-3">
              <v-card color="grey-lighten-3" variant="tonal" rounded="lg" class="pa-3">
                <v-progress-circular indeterminate size="20" width="2" color="primary" />
                <span class="text-body-2 text-grey ml-2">Думаю...</span>
              </v-card>
            </div>
          </div>

          <!-- Input area -->
          <v-divider />
          <div class="pa-3">
            <v-row dense align="center">
              <v-col>
                <v-textarea
                  v-model="inputText"
                  label="Опишіть зміни до промпту..."
                  variant="outlined"
                  density="compact"
                  rows="2"
                  auto-grow
                  hide-details
                  :disabled="loading"
                  @keydown.ctrl.enter="sendMessage"
                  @keydown.meta.enter="sendMessage"
                />
              </v-col>
              <v-col cols="auto">
                <v-btn
                  color="primary"
                  :loading="loading"
                  :disabled="!inputText.trim()"
                  @click="sendMessage"
                >
                  <v-icon start>mdi-send</v-icon>
                  Надіслати
                </v-btn>
              </v-col>
            </v-row>
            <div class="text-caption text-grey mt-1">
              Ctrl+Enter для надсилання
            </div>
          </div>
        </v-card>
      </v-col>

      <!-- Diff panel -->
      <v-col v-if="currentDiff" cols="5" class="pl-3 d-flex flex-column" style="min-height: 0;">
        <v-card class="flex-grow-1 overflow-y-auto" flat>
          <v-card-title class="d-flex align-center">
            <v-icon start color="warning">mdi-file-compare</v-icon>
            Пропоновані зміни
          </v-card-title>

          <v-card-text>
            <!-- Summary -->
            <v-alert type="info" variant="tonal" density="compact" class="mb-4">
              {{ currentDiff.summary }}
            </v-alert>

            <!-- Before -->
            <div class="text-subtitle-2 font-weight-bold mb-1 text-error">
              <v-icon size="small" color="error" class="mr-1">mdi-minus-circle</v-icon>
              БУЛО
            </div>
            <pre class="diff-block diff-before mb-4">{{ currentDiff.before }}</pre>

            <!-- After -->
            <div class="text-subtitle-2 font-weight-bold mb-1 text-success">
              <v-icon size="small" color="success" class="mr-1">mdi-plus-circle</v-icon>
              СТАЛО
            </div>
            <pre class="diff-block diff-after mb-4">{{ currentDiff.after }}</pre>
          </v-card-text>

          <v-divider />

          <v-card-actions class="pa-3">
            <v-btn
              variant="outlined"
              :disabled="applying"
              @click="rejectDiff"
            >
              Відхилити
            </v-btn>
            <v-spacer />
            <v-btn
              color="primary"
              :loading="applying"
              @click="applyDiff"
            >
              <v-icon start>mdi-check</v-icon>
              Застосувати
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-col>
    </v-row>

    <!-- Snackbar -->
    <v-snackbar v-model="snackbar" :color="snackbarColor" :timeout="3000">
      {{ snackbarText }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue';
import api from '@/api';

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

async function scrollToBottom() {
  await nextTick();
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }
}

async function sendMessage() {
  const text = inputText.value.trim();
  if (!text || loading.value) return;

  const userMessage: ChatMessage = { role: 'user', content: text };
  messages.value.push(userMessage);
  inputText.value = '';
  loading.value = true;
  await scrollToBottom();

  try {
    const { data } = await api.post('/meta-agent/chat', {
      message: text,
      history: messages.value.slice(0, -1),
    });

    const assistantMessage: ChatMessage = { role: 'assistant', content: data.reply };
    messages.value.push(assistantMessage);

    if (data.suggestedDiff) {
      currentDiff.value = {
        before: data.suggestedDiff.before,
        after: data.suggestedDiff.after,
        summary: data.suggestedDiff.summary,
      };
    }
  } catch (e: any) {
    const errorMsg = e.response?.data?.message || 'Помилка звʼязку з мета-агентом';
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
    const errorMsg = e.response?.data?.message || 'Не вдалося застосувати зміни';
    showSnackbar(errorMsg, 'error');
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
.diff-block {
  padding: 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
  font-family: 'Roboto Mono', monospace;
  max-height: 300px;
  overflow-y: auto;
}

.diff-before {
  background-color: rgb(var(--v-theme-error), 0.05);
  border: 1px solid rgb(var(--v-theme-error), 0.2);
}

.diff-after {
  background-color: rgb(var(--v-theme-success), 0.05);
  border: 1px solid rgb(var(--v-theme-success), 0.2);
}
</style>
