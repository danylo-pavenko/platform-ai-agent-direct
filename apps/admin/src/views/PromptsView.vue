<template>
  <v-container fluid>
    <v-row class="mb-4" align="center">
      <v-col>
        <div class="page-title">Промпти</div>
      </v-col>
      <v-col cols="auto">
        <v-btn color="primary" prepend-icon="mdi-plus" @click="openNewDialog">
          Нова версія
        </v-btn>
      </v-col>
    </v-row>

    <v-card>
      <v-data-table
        :headers="headers"
        :items="prompts"
        :loading="loading"
        hover
        item-value="id"
        show-expand
      >
        <template #item.version="{ item }">
          <strong>v{{ item.version }}</strong>
        </template>

        <template #item.isActive="{ item }">
          <v-chip
            :color="item.isActive ? 'green' : 'grey'"
            size="small"
            label
          >
            {{ item.isActive ? 'Активний' : 'Неактивний' }}
          </v-chip>
        </template>

        <template #item.createdAt="{ item }">
          {{ formatDate(item.createdAt) }}
        </template>

        <template #item.actions="{ item }">
          <v-btn
            v-if="!item.isActive"
            size="small"
            variant="outlined"
            color="primary"
            :loading="activatingId === item.id"
            @click.stop="activatePrompt(item.id)"
          >
            Активувати
          </v-btn>
        </template>

        <template #expanded-row="{ columns, item }">
          <tr>
            <td :colspan="columns.length" class="pa-4">
              <v-textarea
                :model-value="item.content"
                label="Зміст промпту"
                variant="outlined"
                readonly
                rows="15"
                auto-grow
              />
            </td>
          </tr>
        </template>
      </v-data-table>
    </v-card>

    <!-- New/Edit prompt dialog -->
    <v-dialog v-model="dialogOpen" max-width="1000" persistent>
      <v-card>
        <v-card-title class="d-flex align-center ga-2">
          Нова версія промпту
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="small" @click="closeDialog" :disabled="saving" />
        </v-card-title>

        <!-- Tabs: manual edit vs meta-agent -->
        <v-tabs v-model="editTab" color="primary" density="compact" class="px-4">
          <v-tab value="manual">
            <v-icon start size="18">mdi-pencil</v-icon>
            Вручну
          </v-tab>
          <v-tab value="agent">
            <v-icon start size="18">mdi-robot-outline</v-icon>
            Через агента
          </v-tab>
        </v-tabs>

        <v-divider />

        <v-card-text style="min-height: 400px;">
          <!-- Manual tab -->
          <div v-if="editTab === 'manual'">
            <v-textarea
              v-model="newContent"
              label="Зміст промпту"
              variant="outlined"
              rows="15"
              auto-grow
              class="mb-3"
            />
            <v-text-field
              v-model="newChangeSummary"
              label="Опис змін"
              variant="outlined"
              hide-details
            />
          </div>

          <!-- Agent tab -->
          <div v-if="editTab === 'agent'" class="agent-tab">
            <div class="text-caption text-grey mb-3">
              Опишіть що потрібно змінити — агент запропонує правки до промпту.
              Після застосування змін перейдіть на вкладку "Вручну" для перегляду та збереження.
            </div>

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
                <div style="max-width: 80%;">
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
                      class="text-body-2"
                      :class="{ 'text-white': msg.role === 'user' }"
                      v-html="formatAgentMsg(msg.content)"
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
              <div class="d-flex align-center mb-2">
                <v-icon color="warning" size="18" class="mr-2">mdi-file-compare</v-icon>
                <span class="text-subtitle-2">Пропоновані зміни</span>
                <v-spacer />
                <v-btn
                  size="small"
                  color="primary"
                  variant="flat"
                  :disabled="agentLoading"
                  @click="applyAgentDiff"
                >
                  <v-icon start size="16">mdi-check</v-icon>
                  Застосувати
                </v-btn>
                <v-btn
                  size="small"
                  variant="text"
                  class="ml-1"
                  @click="agentDiff = null"
                >
                  Відхилити
                </v-btn>
              </div>
              <v-alert type="info" variant="tonal" density="compact" class="mb-2 text-body-2">
                {{ agentDiff.summary }}
              </v-alert>
              <div class="d-flex ga-2 flex-wrap">
                <div class="flex-grow-1" style="min-width: 200px;">
                  <div class="text-caption font-weight-bold text-error mb-1">БУЛО</div>
                  <pre class="diff-block diff-before">{{ agentDiff.before }}</pre>
                </div>
                <div class="flex-grow-1" style="min-width: 200px;">
                  <div class="text-caption font-weight-bold text-success mb-1">СТАЛО</div>
                  <pre class="diff-block diff-after">{{ agentDiff.after }}</pre>
                </div>
              </div>
            </v-card>

            <!-- Agent input -->
            <div class="d-flex ga-2 align-end">
              <v-textarea
                v-model="agentInput"
                placeholder="Опишіть зміни до промпту..."
                variant="outlined"
                density="compact"
                rows="1"
                max-rows="3"
                auto-grow
                hide-details
                :disabled="agentLoading"
                @keydown.ctrl.enter="sendToAgent"
                @keydown.meta.enter="sendToAgent"
              />
              <v-btn
                color="primary"
                icon="mdi-send"
                :loading="agentLoading"
                :disabled="!agentInput.trim()"
                size="small"
                @click="sendToAgent"
              />
            </div>
          </div>
        </v-card-text>

        <v-divider />
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="closeDialog" :disabled="saving">
            Скасувати
          </v-btn>
          <v-btn
            color="primary"
            :loading="saving"
            :disabled="!newContent.trim() || !newChangeSummary.trim()"
            @click="createPrompt"
          >
            Зберегти нову версію
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
import { ref, nextTick, onMounted } from 'vue';
import api from '@/api';

interface Prompt {
  id: string;
  version: number;
  content: string;
  changeSummary: string;
  author: string;
  isActive: boolean;
  createdAt: string;
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

const headers = [
  { title: 'Версія', key: 'version', width: '100px' },
  { title: 'Автор', key: 'author' },
  { title: 'Опис змін', key: 'changeSummary' },
  { title: 'Дата', key: 'createdAt', width: '180px' },
  { title: 'Статус', key: 'isActive', width: '130px' },
  { title: 'Дії', key: 'actions', sortable: false, width: '150px' },
];

function showSnack(text: string, color = 'success') {
  snackbarText.value = text;
  snackbarColor.value = color;
  snackbar.value = true;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('uk-UA');
}

function formatAgentMsg(text: string): string {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^(---\s*.+?\s*---)/gm, '<strong class="text-primary">$1</strong>');
  html = html.replace(/^(ПОЯСНЕННЯ:)/gm, '<strong class="text-info">$1</strong>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

function openNewDialog() {
  newContent.value = '';
  newChangeSummary.value = '';
  agentMessages.value = [];
  agentInput.value = '';
  agentDiff.value = null;
  editTab.value = 'manual';
  const active = prompts.value.find((p) => p.isActive);
  if (active) {
    newContent.value = active.content;
  }
  dialogOpen.value = true;
}

function closeDialog() {
  dialogOpen.value = false;
}

async function fetchPrompts() {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/prompts');
    prompts.value = data.data;
  } catch {
    error.value = 'Не вдалося завантажити промпти';
  } finally {
    loading.value = false;
  }
}

async function createPrompt() {
  saving.value = true;
  error.value = '';
  try {
    await api.post('/prompts', {
      content: newContent.value.trim(),
      changeSummary: newChangeSummary.value.trim(),
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
    await api.post(`/prompts/${id}/activate`);
    await fetchPrompts();
    showSnack('Промпт активовано');
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
    const { data } = await api.post('/meta-agent/chat', {
      message: text,
      history: agentMessages.value.slice(0, -1),
    });

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
.agent-tab {
  display: flex;
  flex-direction: column;
}

.agent-messages {
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
  padding: 12px;
}

.diff-block {
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Roboto Mono', 'Courier New', monospace;
  max-height: 150px;
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

:deep(.agent-messages code) {
  background: rgba(0,0,0,0.06);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 0.9em;
}
</style>
