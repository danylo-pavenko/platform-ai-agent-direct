<template>
  <v-container fluid class="sandbox-root pa-0" :class="{ 'mobile': mobile }">
    <!-- Mobile header -->
    <div v-if="mobile" class="sandbox-mobile-header d-flex align-center pa-2 ga-2">
      <v-btn
        icon="mdi-menu"
        variant="text"
        size="small"
        @click="showCasesDrawer = true"
      />
      <div class="text-subtitle-2 flex-grow-1">Пісочниця</div>
      <v-btn
        icon="mdi-tune"
        variant="text"
        size="small"
        @click="showPromptPanel = !showPromptPanel"
      />
    </div>

    <div class="sandbox-layout" :class="{ 'with-prompt': showPromptPanel && !mobile }">
      <!-- Left: Cases panel (desktop) / Drawer (mobile) -->
      <v-navigation-drawer
        v-if="mobile"
        v-model="showCasesDrawer"
        temporary
        location="left"
        width="300"
      >
        <cases-panel />
      </v-navigation-drawer>

      <div v-else class="cases-sidebar">
        <cases-panel />
      </div>

      <!-- Center: Chat -->
      <div class="chat-area d-flex flex-column">
        <!-- Chat header -->
        <div class="chat-header d-flex align-center pa-3 ga-2">
          <v-avatar size="36" color="pink-lighten-4">
            <v-icon color="pink-darken-1">mdi-account</v-icon>
          </v-avatar>
          <div class="flex-grow-1">
            <div class="text-subtitle-2">Тестовий клієнт</div>
            <div class="text-caption text-grey">sandbox_test • Пісочниця</div>
          </div>

          <!-- Replay controls -->
          <template v-if="replayMode">
            <v-chip color="warning" size="small" variant="flat">
              <v-icon start size="14">mdi-replay</v-icon>
              Прогонка {{ replayStep + 1 }}/{{ replayMessages.length }}
            </v-chip>
            <v-btn
              icon="mdi-stop"
              color="error"
              variant="text"
              size="small"
              @click="stopReplay"
            />
          </template>
          <template v-else>
            <v-btn
              v-if="chatMessages.length > 0"
              icon="mdi-content-save-outline"
              variant="text"
              size="small"
              title="Зберегти як кейс"
              @click="showSaveDialog = true"
            />
            <v-btn
              icon="mdi-delete-outline"
              variant="text"
              size="small"
              title="Скинути діалог"
              :disabled="chatMessages.length === 0"
              @click="resetChat"
            />
            <v-btn
              v-if="!mobile"
              :icon="showPromptPanel ? 'mdi-text-box-minus' : 'mdi-text-box-edit'"
              variant="text"
              size="small"
              title="Промпт"
              @click="showPromptPanel = !showPromptPanel"
            />
          </template>
        </div>

        <v-divider />

        <!-- Messages area (Instagram DM style) -->
        <div ref="messagesArea" class="messages-area flex-grow-1 overflow-y-auto">
          <!-- Empty state -->
          <div v-if="chatMessages.length === 0 && !loading" class="empty-state">
            <div class="ig-logo-placeholder mb-3">
              <v-icon size="48" color="grey-lighten-1">mdi-instagram</v-icon>
            </div>
            <div class="text-body-1 text-grey-darken-1 mb-1">Тестовий чат</div>
            <div class="text-body-2 text-grey mb-4" style="max-width: 300px; text-align: center;">
              Пишіть як клієнт і дивіться як відповідає AI-агент
            </div>
            <div class="d-flex flex-wrap ga-2 justify-center">
              <v-chip
                v-for="hint in quickHints"
                :key="hint"
                size="small"
                variant="outlined"
                class="cursor-pointer"
                @click="sendQuickHint(hint)"
              >
                {{ hint }}
              </v-chip>
            </div>
          </div>

          <!-- Chat messages -->
          <div v-if="chatMessages.length > 0 || loading" class="messages-list pa-3">
            <template v-for="(msg, idx) in chatMessages" :key="idx">
              <!-- Date separator (first message) -->
              <div v-if="idx === 0" class="date-separator text-center mb-3">
                <span class="text-caption text-grey bg-white px-2">Сьогодні</span>
              </div>

              <!-- Message bubble -->
              <div
                class="msg-row mb-2"
                :class="msg.role === 'user' ? 'msg-sent' : 'msg-received'"
              >
                <div
                  class="msg-bubble"
                  :class="msg.role === 'user' ? 'bubble-sent' : 'bubble-received'"
                >
                  <div class="msg-text" v-html="formatMessage(msg.content)" />
                  <div class="msg-time text-caption">
                    {{ formatTime(msg.timestamp) }}
                  </div>
                </div>
              </div>
            </template>

            <!-- Typing indicator -->
            <div v-if="loading" class="msg-row msg-received mb-2">
              <div class="msg-bubble bubble-received typing-bubble">
                <div class="typing-dots">
                  <span /><span /><span />
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Replay step confirmation -->
        <div v-if="replayMode && !replayWaitingResponse" class="replay-bar pa-3 d-flex align-center ga-2">
          <v-icon size="18" color="warning">mdi-replay</v-icon>
          <div class="flex-grow-1 text-body-2">
            <template v-if="replayStep < replayMessages.length">
              Наступне питання: <strong>{{ replayMessages[replayStep] }}</strong>
            </template>
            <template v-else>
              Прогонка завершена!
            </template>
          </div>
          <v-btn
            v-if="replayStep < replayMessages.length"
            color="primary"
            size="small"
            @click="sendReplayStep"
          >
            Далі
          </v-btn>
          <v-btn
            variant="outlined"
            size="small"
            @click="stopReplay"
          >
            Стоп
          </v-btn>
        </div>

        <!-- Input area -->
        <div v-if="!replayMode" class="input-area pa-2 pa-md-3">
          <div class="d-flex ga-2 align-end">
            <v-textarea
              v-model="inputText"
              placeholder="Напишіть повідомлення як клієнт..."
              variant="outlined"
              density="compact"
              rows="1"
              max-rows="4"
              auto-grow
              hide-details
              :disabled="loading"
              @keydown.enter.exact.prevent="sendMessage"
              @keydown.ctrl.enter="insertNewline"
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
      </div>

      <!-- Right: Prompt panel (desktop only, or mobile bottom sheet) -->
      <v-bottom-sheet v-if="mobile" v-model="showPromptPanel" inset>
        <v-card class="pa-3 prompt-mobile-sheet">
          <prompt-editor />
        </v-card>
      </v-bottom-sheet>

      <div v-else-if="showPromptPanel" class="prompt-sidebar d-flex flex-column">
        <prompt-editor />
      </div>
    </div>

    <!-- Save case dialog -->
    <v-dialog v-model="showSaveDialog" max-width="400">
      <v-card>
        <v-card-title class="text-subtitle-1">Зберегти як кейс</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="saveCaseName"
            label="Назва кейсу"
            variant="outlined"
            density="compact"
            autofocus
            placeholder="напр. Питання про доставку"
            @keydown.enter="saveCase"
          />
          <div class="text-caption text-grey">
            Збережуться {{ clientMessagesFromChat.length }} питань клієнта.
            Відповіді агента будуть скинуті при прогонці.
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="showSaveDialog = false">Скасувати</v-btn>
          <v-btn color="primary" :disabled="!saveCaseName.trim()" @click="saveCase">
            Зберегти
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Save prompt override as a new version dialog -->
    <v-dialog v-model="showSaveVersionDialog" max-width="480" persistent>
      <v-card>
        <v-card-title class="text-subtitle-1">Зберегти як нову версію промпту</v-card-title>
        <v-card-text>
          <div class="text-caption text-grey mb-3">
            Поточний текст буде збережено як <strong>чернетку</strong>. Активувати її потрібно вручну у розділі "Промпти".
          </div>
          <v-text-field
            v-model="saveVersionSummary"
            label="Опис змін"
            variant="outlined"
            density="compact"
            autofocus
            placeholder="напр. Додав правило про безкоштовну доставку"
            @keydown.enter="saveOverrideAsVersion"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="savingVersion" @click="showSaveVersionDialog = false">Скасувати</v-btn>
          <v-btn
            color="primary"
            :loading="savingVersion"
            :disabled="!saveVersionSummary.trim()"
            @click="saveOverrideAsVersion"
          >
            Зберегти чернетку
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
import { ref, computed, nextTick, onMounted, defineComponent, h } from 'vue';
import { useDisplay } from 'vuetify';
import api from '@/api';

const { mobile } = useDisplay();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface SandboxCase {
  id: string;
  name: string;
  messages: string[];
  createdAt: string;
  updatedAt: string;
}

interface PromptOption {
  id: string;
  version: number;
  changeSummary: string | null;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const chatMessages = ref<ChatMessage[]>([]);
const inputText = ref('');
const loading = ref(false);
const messagesArea = ref<HTMLElement | null>(null);

// Cases
const cases = ref<SandboxCase[]>([]);
const showCasesDrawer = ref(false);
const showSaveDialog = ref(false);
const saveCaseName = ref('');
const selectedCaseId = ref<string | null>(null);

// Prompt
const showPromptPanel = ref(false);
const prompts = ref<PromptOption[]>([]);
const selectedPromptId = ref<string | null>(null);
const promptOverride = ref('');
const useCustomPrompt = ref(false);

// Prompt agent (meta-agent mini-chat inside prompt panel)
const promptAgentMessages = ref<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
const promptAgentInput = ref('');
const promptAgentLoading = ref(false);
const promptAgentDiff = ref<{ before: string; after: string; summary: string } | null>(null);
const promptAgentTab = ref<'edit' | 'agent'>('edit');

// Save-as-version dialog state (for persisting the edited override to DB
// as a draft prompt version that can later be activated from /prompts).
const showSaveVersionDialog = ref(false);
const saveVersionSummary = ref('');
const savingVersion = ref(false);

// Replay
const replayMode = ref(false);
const replayMessages = ref<string[]>([]);
const replayStep = ref(0);
const replayWaitingResponse = ref(false);

// Request cancellation
const currentAbortController = ref<AbortController | null>(null);

// Snackbar
const snackbar = ref(false);
const snackbarText = ref('');
const snackbarColor = ref('success');

const MAX_CASES = 15;

const quickHints = [
  'Привіт! Що є в наявності?',
  'Скільки коштує доставка?',
  'Є щось зі знижкою?',
  'Хочу замовити',
];

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

const clientMessagesFromChat = computed(() =>
  chatMessages.value.filter((m) => m.role === 'user').map((m) => m.content),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function showSnack(text: string, color = 'success') {
  snackbarText.value = text;
  snackbarColor.value = color;
  snackbar.value = true;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

function formatMessage(text: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const inline = (s: string) => {
    let out = escape(s);
    out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(
      /(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g,
      '<a href="$1" target="_blank" rel="noopener">$1</a>',
    );
    return out;
  };

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let listOpen = false;
  let paraBuf: string[] = [];

  const flushPara = () => {
    if (paraBuf.length === 0) return;
    html.push(`<p>${paraBuf.join('<br>')}</p>`);
    paraBuf = [];
  };
  const closeList = () => {
    if (listOpen) {
      html.push('</ul>');
      listOpen = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      closeList();
      continue;
    }
    closeList();
    paraBuf.push(inline(line));
  }
  flushPara();
  closeList();

  return html.join('');
}

async function scrollToBottom() {
  await nextTick();
  if (messagesArea.value) {
    messagesArea.value.scrollTop = messagesArea.value.scrollHeight;
  }
}

function insertNewline() {
  inputText.value += '\n';
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

async function sendChatMessage(text: string) {
  // Cancel any in-flight request before starting a new one
  if (currentAbortController.value) {
    currentAbortController.value.abort();
  }
  const controller = new AbortController();
  currentAbortController.value = controller;

  chatMessages.value.push({
    role: 'user',
    content: text,
    timestamp: new Date(),
  });
  loading.value = true;
  await scrollToBottom();

  try {
    const payload: Record<string, unknown> = {
      messages: chatMessages.value.map((m) => ({ role: m.role, content: m.content })),
    };
    if (useCustomPrompt.value && promptOverride.value.trim()) {
      payload.promptOverride = promptOverride.value;
    } else if (selectedPromptId.value) {
      payload.systemPromptId = selectedPromptId.value;
    }

    const { data } = await api.post('/sandbox/chat', payload, { signal: controller.signal });

    chatMessages.value.push({
      role: 'assistant',
      content: data.reply,
      timestamp: new Date(),
    });
  } catch (e: any) {
    // Silently ignore aborted requests (stop replay / switch scenario)
    if (e.name === 'CanceledError' || e.code === 'ERR_CANCELED' || e.name === 'AbortError') return;
    const errorMsg = e.response?.data?.error || 'Помилка зв\'язку';
    chatMessages.value.push({
      role: 'assistant',
      content: `⚠️ ${errorMsg}`,
      timestamp: new Date(),
    });
    showSnack(errorMsg, 'error');
  } finally {
    currentAbortController.value = null;
    loading.value = false;
    await scrollToBottom();
  }
}

function sendMessage() {
  const text = inputText.value.trim();
  if (!text || loading.value) return;
  inputText.value = '';
  sendChatMessage(text);
}

function sendQuickHint(text: string) {
  sendChatMessage(text);
}

function resetChat() {
  // Abort any in-flight request
  if (currentAbortController.value) {
    currentAbortController.value.abort();
    currentAbortController.value = null;
  }
  loading.value = false;
  chatMessages.value = [];
  replayMode.value = false;
  replayStep.value = 0;
}

// ---------------------------------------------------------------------------
// Cases CRUD
// ---------------------------------------------------------------------------

async function loadCases() {
  try {
    const { data } = await api.get('/sandbox/cases');
    cases.value = data;
  } catch {
    showSnack('Не вдалося завантажити кейси', 'error');
  }
}

async function saveCase() {
  if (!saveCaseName.value.trim() || clientMessagesFromChat.value.length === 0) return;

  try {
    await api.post('/sandbox/cases', {
      name: saveCaseName.value.trim(),
      messages: clientMessagesFromChat.value,
    });
    showSnack('Кейс збережено');
    showSaveDialog.value = false;
    saveCaseName.value = '';
    await loadCases();
  } catch (e: any) {
    showSnack(e.response?.data?.error || 'Не вдалося зберегти', 'error');
  }
}

async function deleteCase(id: string) {
  try {
    await api.delete(`/sandbox/cases/${id}`);
    cases.value = cases.value.filter((c) => c.id !== id);
    if (selectedCaseId.value === id) selectedCaseId.value = null;
    showSnack('Кейс видалено');
  } catch {
    showSnack('Не вдалося видалити', 'error');
  }
}

function loadCaseToChat(c: SandboxCase) {
  selectedCaseId.value = c.id;
  // Populate chat input with the first message of the case
  if (c.messages.length > 0) {
    inputText.value = c.messages[0];
  }
  if (mobile.value) showCasesDrawer.value = false;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

function startReplay(c: SandboxCase) {
  resetChat();
  replayMessages.value = [...c.messages];
  replayStep.value = 0;
  replayMode.value = true;
  selectedCaseId.value = c.id;
  if (mobile.value) showCasesDrawer.value = false;
}

async function sendReplayStep() {
  if (replayStep.value >= replayMessages.value.length) return;

  const text = replayMessages.value[replayStep.value];
  replayWaitingResponse.value = true;
  await sendChatMessage(text);
  replayWaitingResponse.value = false;
  replayStep.value++;
}

function stopReplay() {
  // Abort any in-flight request
  if (currentAbortController.value) {
    currentAbortController.value.abort();
    currentAbortController.value = null;
  }
  loading.value = false;
  replayMode.value = false;
  replayStep.value = 0;
  replayMessages.value = [];
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

async function loadPrompts() {
  try {
    const { data } = await api.get('/sandbox/prompts');
    prompts.value = Array.isArray(data) ? data : [];
    const active = prompts.value.find((p: PromptOption) => p.isActive);
    if (active) selectedPromptId.value = active.id;
  } catch {
    prompts.value = [];
  }
}

async function loadPromptContent(id: string) {
  try {
    const { data } = await api.get(`/prompts/${id}`);
    promptOverride.value = data.content || '';
    useCustomPrompt.value = true;
  } catch {
    showSnack('Не вдалося завантажити промпт', 'error');
  }
}

// ---------------------------------------------------------------------------
// Prompt Agent (meta-agent mini-chat)
// ---------------------------------------------------------------------------

async function sendToPromptAgent() {
  const text = promptAgentInput.value.trim();
  if (!text || promptAgentLoading.value) return;

  promptAgentMessages.value.push({ role: 'user', content: text });
  promptAgentInput.value = '';
  promptAgentLoading.value = true;
  promptAgentDiff.value = null;

  try {
    // When the user has an edited override, reason over THAT — not the DB-active
    // prompt — so suggestions reference fragments the user actually sees.
    const payload: Record<string, unknown> = {
      message: text,
      history: promptAgentMessages.value.slice(0, -1),
    };
    if (useCustomPrompt.value && promptOverride.value.trim()) {
      payload.currentPromptContent = promptOverride.value;
    }

    const { data } = await api.post('/meta-agent/chat', payload);

    promptAgentMessages.value.push({ role: 'assistant', content: data.reply });

    if (data.suggestedDiff) {
      promptAgentDiff.value = data.suggestedDiff;
    }
  } catch (e: any) {
    const errorMsg = e.response?.data?.error || 'Помилка зв\'язку з мета-агентом';
    promptAgentMessages.value.push({ role: 'assistant', content: `Помилка: ${errorMsg}` });
  } finally {
    promptAgentLoading.value = false;
  }
}

function openSaveVersionDialog() {
  if (!promptOverride.value.trim()) {
    showSnack('Порожній промпт — нема чого зберігати', 'error');
    return;
  }
  saveVersionSummary.value = '';
  showSaveVersionDialog.value = true;
}

async function saveOverrideAsVersion() {
  const summary = saveVersionSummary.value.trim();
  if (!summary || !promptOverride.value.trim()) return;

  savingVersion.value = true;
  try {
    // Creates a draft (isActive: false) — explicit activation still happens
    // on the Prompts page. Sandbox is for editing and verifying, not for
    // silent prod rollouts.
    const { data } = await api.post('/prompts', {
      content: promptOverride.value,
      changeSummary: summary,
    });
    showSaveVersionDialog.value = false;
    saveVersionSummary.value = '';
    await loadPrompts();
    selectedPromptId.value = data.id;
    showSnack(`Чернетку v${data.version} збережено. Активуйте у розділі "Промпти".`);
  } catch (e: any) {
    showSnack(e.response?.data?.error || 'Не вдалося зберегти', 'error');
  } finally {
    savingVersion.value = false;
  }
}

function applyPromptAgentDiff() {
  if (!promptAgentDiff.value) return;
  const { before, after } = promptAgentDiff.value;

  // Load current prompt into override if not already editing
  if (!useCustomPrompt.value) {
    // Need to load the prompt content first
    const activeId = selectedPromptId.value || prompts.value.find((p) => p.isActive)?.id;
    if (activeId) {
      loadPromptContent(activeId).then(() => {
        doApplyDiff(before, after);
      });
      return;
    }
  }
  doApplyDiff(before, after);
}

function doApplyDiff(before: string, after: string) {
  if (before && promptOverride.value.includes(before)) {
    promptOverride.value = promptOverride.value.replace(before, after);
  } else {
    promptOverride.value = promptOverride.value + '\n\n' + after;
  }
  useCustomPrompt.value = true;
  promptAgentDiff.value = null;
  promptAgentTab.value = 'edit';
  showSnack('Зміни застосовано до промпту');
}

// ---------------------------------------------------------------------------
// Sub-components (inline to keep single file)
// ---------------------------------------------------------------------------

const CasesPanel = defineComponent({
  name: 'CasesPanel',
  setup() {
    return () =>
      h('div', { class: 'cases-panel d-flex flex-column', style: 'height: 100%;' }, [
        // Header
        h('div', { class: 'pa-3 d-flex align-center ga-2' }, [
          h('div', { class: 'text-subtitle-2 flex-grow-1' }, 'Тестові кейси'),
          h('span', { class: 'text-caption text-grey' }, `${cases.value.length}/${MAX_CASES}`),
          h('button', {
            class: 'new-chat-btn',
            title: 'Новий чат',
            onClick: () => { resetChat(); selectedCaseId.value = null; if (mobile.value) showCasesDrawer.value = false; },
            innerHTML: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
          }),
        ]),
        h('hr', { class: 'v-divider' }),
        // List
        h(
          'div',
          { class: 'cases-list flex-grow-1 overflow-y-auto pa-2' },
          cases.value.length === 0
            ? [
                h('div', { class: 'pa-4 text-center text-body-2 text-grey' }, [
                  h('div', { class: 'mb-2' }, '🧪'),
                  'Збережіть діалог як кейс для повторного тестування',
                ]),
              ]
            : cases.value.map((c) =>
                h(
                  'div',
                  {
                    key: c.id,
                    class: [
                      'case-card d-flex align-center ga-2 cursor-pointer',
                      selectedCaseId.value === c.id ? 'case-selected' : '',
                    ],
                    onClick: () => loadCaseToChat(c),
                  },
                  [
                    h('div', { class: 'case-body flex-grow-1' }, [
                      h('div', {
                        class: 'case-name text-body-2 font-weight-medium',
                        title: c.name,
                      }, c.name),
                      h('div', { class: 'text-caption text-grey' }, `${c.messages.length} питань`),
                    ]),
                    h('div', { class: 'case-actions d-flex align-center ga-1' }, [
                      h('button', {
                        class: 'case-action-btn',
                        title: 'Запустити прогонку',
                        onClick: (e: Event) => { e.stopPropagation(); startReplay(c); },
                        innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
                      }),
                      h('button', {
                        class: 'case-action-btn text-error',
                        title: 'Видалити',
                        onClick: (e: Event) => { e.stopPropagation(); deleteCase(c.id); },
                        innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
                      }),
                    ]),
                  ],
                ),
              ),
        ),
      ]);
  },
});

const PromptEditor = defineComponent({
  name: 'PromptEditor',
  setup() {
    return () =>
      h('div', { class: 'prompt-editor d-flex flex-column', style: 'height: 100%;' }, [
        // Header with tabs
        h('div', { class: 'pa-3 pb-0' }, [
          h('div', { class: 'text-subtitle-2 mb-2' }, 'Системний промпт'),
        ]),
        h('div', { class: 'prompt-tabs d-flex px-3 mb-2' }, [
          h('button', {
            class: ['prompt-tab', promptAgentTab.value === 'edit' ? 'prompt-tab-active' : ''],
            onClick: () => { promptAgentTab.value = 'edit'; },
          }, 'Редагування'),
          h('button', {
            class: ['prompt-tab', promptAgentTab.value === 'agent' ? 'prompt-tab-active' : ''],
            onClick: () => { promptAgentTab.value = 'agent'; },
          }, 'Через агента'),
        ]),

        // Edit tab
        promptAgentTab.value === 'edit'
          ? h('div', { class: 'flex-grow-1 d-flex flex-column px-3 pb-3', style: 'min-height: 0; overflow: hidden;' }, [
              // Prompt version selector
              h('select', {
                class: 'prompt-select mb-2',
                value: selectedPromptId.value ?? '',
                onChange: (e: Event) => {
                  const id = (e.target as HTMLSelectElement).value;
                  selectedPromptId.value = id || null;
                  useCustomPrompt.value = false;
                },
              }, [
                h('option', { value: '' }, 'Активний промпт'),
                ...prompts.value.map((p) =>
                  h('option', { value: p.id, key: p.id },
                    `v${p.version}${p.isActive ? ' (активний)' : ''} - ${p.changeSummary || 'без опису'}`,
                  ),
                ),
              ]),
              h('div', { class: 'mb-2 d-flex ga-2 flex-wrap' }, [
                h('button', {
                  class: 'text-caption text-primary cursor-pointer prompt-action-link',
                  onClick: () => {
                    const id = selectedPromptId.value || prompts.value.find((p) => p.isActive)?.id;
                    if (id) loadPromptContent(id);
                  },
                }, 'Редагувати копію'),
                useCustomPrompt.value && promptOverride.value.trim()
                  ? h('button', {
                      class: 'text-caption text-primary cursor-pointer prompt-action-link',
                      onClick: () => openSaveVersionDialog(),
                    }, 'Зберегти як нову версію')
                  : null,
                useCustomPrompt.value
                  ? h('button', {
                      class: 'text-caption text-grey cursor-pointer prompt-action-link',
                      onClick: () => {
                        useCustomPrompt.value = false;
                        promptOverride.value = '';
                      },
                    }, 'Скинути')
                  : null,
              ]),
              useCustomPrompt.value
                ? h('textarea', {
                    class: 'prompt-textarea flex-grow-1',
                    value: promptOverride.value,
                    onInput: (e: Event) => {
                      promptOverride.value = (e.target as HTMLTextAreaElement).value;
                    },
                    placeholder: 'Вставте або відредагуйте промпт...',
                  })
                : h('div', { class: 'text-caption text-grey' },
                    'Використовується обраний промпт з бази. Натисніть "Редагувати копію" для внесення змін.',
                  ),
            ])
          : null,

        // Agent tab
        promptAgentTab.value === 'agent'
          ? h('div', { class: 'flex-grow-1 d-flex flex-column px-3 pb-3', style: 'min-height: 0; overflow: hidden;' }, [
              h('div', { class: 'text-caption text-grey mb-2' },
                'Опишіть що змінити - агент запропонує правки',
              ),
              // Messages
              h('div', { class: 'prompt-agent-messages flex-grow-1 mb-2' },
                promptAgentMessages.value.length === 0 && !promptAgentLoading.value
                  ? [h('div', { class: 'text-center text-grey pa-3 text-caption' }, 'Напишіть що змінити в промпті')]
                  : [
                      ...promptAgentMessages.value.map((msg, idx) =>
                        h('div', {
                          key: idx,
                          class: ['prompt-agent-msg mb-1', msg.role === 'user' ? 'msg-user' : 'msg-bot'],
                        }, [
                          h('span', { class: 'text-caption font-weight-medium' },
                            msg.role === 'user' ? 'Ви: ' : 'Агент: ',
                          ),
                          h('span', { class: 'text-caption' }, msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content),
                        ]),
                      ),
                      promptAgentLoading.value
                        ? h('div', { class: 'text-caption text-grey d-flex align-center ga-1' }, [
                            h('span', { class: 'prompt-agent-spinner' }),
                            'Аналізую...',
                          ])
                        : null,
                    ],
              ),
              // Diff
              promptAgentDiff.value
                ? h('div', { class: 'prompt-agent-diff mb-2' }, [
                    h('div', { class: 'text-caption font-weight-bold mb-1' }, promptAgentDiff.value.summary),
                    h('div', { class: 'd-flex ga-1' }, [
                      h('button', {
                        class: 'prompt-agent-apply-btn',
                        onClick: () => applyPromptAgentDiff(),
                      }, 'Застосувати'),
                      h('button', {
                        class: 'prompt-agent-reject-btn',
                        onClick: () => { promptAgentDiff.value = null; },
                      }, 'Відхилити'),
                    ]),
                  ])
                : null,
              // Input
              h('div', { class: 'd-flex ga-1 align-end' }, [
                h('input', {
                  class: 'prompt-agent-input',
                  value: promptAgentInput.value,
                  placeholder: 'Додай правило про...',
                  disabled: promptAgentLoading.value,
                  onInput: (e: Event) => { promptAgentInput.value = (e.target as HTMLInputElement).value; },
                  onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') sendToPromptAgent(); },
                }),
                h('button', {
                  class: 'prompt-agent-send-btn',
                  disabled: !promptAgentInput.value.trim() || promptAgentLoading.value,
                  onClick: () => sendToPromptAgent(),
                  innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>',
                }),
              ]),
            ])
          : null,
      ]);
  },
});

// Register inline components
const casesPanel = CasesPanel;
const promptEditor = PromptEditor;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(async () => {
  await Promise.all([loadCases(), loadPrompts()]);
});
</script>

<style scoped>
.sandbox-root {
  height: 100dvh;
  overflow: hidden;
}
.sandbox-root.mobile {
  height: calc(100dvh - 56px);
}

.sandbox-mobile-header {
  background: rgb(var(--v-theme-surface));
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  flex: 0 0 auto;
}

.sandbox-layout {
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.sandbox-root.mobile .sandbox-layout {
  height: calc(100% - 48px);
}

.cases-sidebar {
  width: 280px;
  min-width: 280px;
  flex: 0 0 280px;
  border-right: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  overflow: hidden;
  background: rgb(var(--v-theme-surface));
  display: flex;
  flex-direction: column;
}

.chat-area {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  background: #fafafa;
}

.prompt-sidebar {
  width: 360px;
  min-width: 320px;
  flex: 0 0 360px;
  border-left: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
@media (max-width: 1280px) {
  .prompt-sidebar {
    width: 320px;
    flex-basis: 320px;
  }
}

.chat-header {
  background: rgb(var(--v-theme-surface));
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

/* Instagram DM style messages */
.messages-area {
  flex: 1 1 auto;
  min-height: 0;
  background: #fafafa;
}

.empty-state {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.messages-list {
  display: flex;
  flex-direction: column;
}

.msg-row {
  display: flex;
  max-width: 100%;
}
.msg-sent {
  justify-content: flex-end;
}
.msg-received {
  justify-content: flex-start;
}

.msg-bubble {
  max-width: 75%;
  padding: 8px 14px;
  border-radius: 18px;
  position: relative;
  word-wrap: break-word;
  overflow-wrap: anywhere;
}
@media (min-width: 1400px) {
  .msg-bubble { max-width: 640px; }
}

.bubble-sent {
  background: #3797f0;
  color: #fff;
  border-bottom-right-radius: 4px;
}

.bubble-received {
  background: #efefef;
  color: #262626;
  border-bottom-left-radius: 4px;
}

.msg-text {
  font-size: 14px;
  line-height: 1.45;
}
.msg-text :deep(p) {
  margin: 0;
}
.msg-text :deep(p + p),
.msg-text :deep(p + ul),
.msg-text :deep(ul + p) {
  margin-top: 6px;
}
.msg-text :deep(strong) {
  font-weight: 600;
}
.msg-text :deep(code) {
  background: rgba(0,0,0,0.1);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 0.9em;
}
.msg-text :deep(ul) {
  margin: 4px 0 0 0;
  padding-left: 18px;
}
.msg-text :deep(li) {
  margin-bottom: 2px;
}
.msg-text :deep(a) {
  color: inherit;
  text-decoration: underline;
  word-break: break-all;
}
.bubble-sent .msg-text :deep(a) {
  color: #fff;
}
.bubble-sent .msg-text :deep(code) {
  background: rgba(255,255,255,0.2);
}

.msg-time {
  font-size: 11px;
  opacity: 0.6;
  margin-top: 2px;
  text-align: right;
}
.bubble-sent .msg-time {
  color: rgba(255,255,255,0.7);
}

/* Typing indicator */
.typing-bubble {
  padding: 12px 18px;
}
.typing-dots {
  display: flex;
  gap: 4px;
  align-items: center;
}
.typing-dots span {
  width: 8px;
  height: 8px;
  background: #999;
  border-radius: 50%;
  animation: typing-bounce 1.4s infinite both;
}
.typing-dots span:nth-child(2) { animation-delay: 0.2s; }
.typing-dots span:nth-child(3) { animation-delay: 0.4s; }

@keyframes typing-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

/* Date separator */
.date-separator {
  position: relative;
}
.date-separator::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 1px;
  background: #dbdbdb;
}
.date-separator span {
  position: relative;
  z-index: 1;
}

/* Input area */
.input-area {
  background: rgb(var(--v-theme-surface));
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

/* Replay bar */
.replay-bar {
  background: #fff8e1;
  border-top: 1px solid #ffe082;
}

/* Cases panel items */
.cases-panel {
  min-height: 0;
}
.cases-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.case-card {
  padding: 10px 12px;
  background: #fff;
  border: 1px solid rgba(var(--v-border-color), 0.18);
  border-radius: 10px;
  transition: border-color 0.15s, box-shadow 0.15s, background-color 0.15s, transform 0.1s;
  min-width: 0;
  box-shadow: 0 1px 2px rgba(10, 37, 64, 0.04);
}
.case-card:hover {
  border-color: rgba(var(--v-theme-primary), 0.35);
  box-shadow: 0 2px 8px rgba(10, 37, 64, 0.08);
}
.case-card:active {
  transform: translateY(1px);
}
.case-selected {
  border-color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.05);
  box-shadow: 0 2px 8px rgba(var(--v-theme-primary), 0.15);
}
.case-body {
  min-width: 0;
  overflow: hidden;
}
.case-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.25;
  margin-bottom: 2px;
}
.case-actions {
  flex-shrink: 0;
}

.new-chat-btn {
  border: none;
  background: rgba(var(--v-theme-primary), 0.1);
  color: rgb(var(--v-theme-primary));
  cursor: pointer;
  padding: 0;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  line-height: 0;
  transition: background-color 0.15s;
}
.new-chat-btn :deep(svg) {
  display: block;
}
.new-chat-btn:hover {
  background: rgba(var(--v-theme-primary), 0.2);
}

.case-action-btn {
  border: none;
  background: none;
  cursor: pointer;
  padding: 0;
  border-radius: 4px;
  color: #666;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  line-height: 0;
}
.case-action-btn :deep(svg) {
  display: block;
}
.case-action-btn:hover {
  background: rgba(0,0,0,0.06);
}
.case-action-btn.text-error {
  color: #d32f2f;
}

/* Prompt panel */
.prompt-editor {
  min-height: 0;
}
.prompt-select {
  width: 100%;
  max-width: 100%;
  padding: 8px 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
  font-size: 13px;
  background: #fff;
  outline: none;
  box-sizing: border-box;
  text-overflow: ellipsis;
}
.prompt-select:focus {
  border-color: rgb(var(--v-theme-primary));
}

.prompt-action-link {
  border: none;
  background: none;
  text-decoration: underline;
  cursor: pointer;
}

.prompt-textarea {
  width: 100%;
  min-height: 0;
  flex: 1 1 auto;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
  padding: 12px;
  font-size: 12px;
  line-height: 1.5;
  font-family: 'Roboto Mono', 'Menlo', monospace;
  resize: none;
  outline: none;
  box-sizing: border-box;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  background: #fafafa;
}
.prompt-textarea:focus {
  border-color: rgb(var(--v-theme-primary));
  background: #fff;
}

/* Cursor pointer helper */
.cursor-pointer {
  cursor: pointer;
}

/* Prompt panel tabs */
.prompt-tabs {
  gap: 0;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.prompt-tab {
  border: none;
  background: none;
  cursor: pointer;
  padding: 6px 12px;
  font-size: 12px;
  color: #666;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
}
.prompt-tab:hover {
  color: #333;
}
.prompt-tab-active {
  color: rgb(var(--v-theme-primary));
  border-bottom-color: rgb(var(--v-theme-primary));
  font-weight: 500;
}

/* Prompt agent mini-chat */
.prompt-agent-messages {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
  padding: 8px;
  overflow-y: auto;
  min-height: 80px;
  background: #fafafa;
  word-break: break-word;
}
.prompt-agent-msg {
  padding: 4px 8px;
  border-radius: 6px;
  line-height: 1.4;
}
.prompt-agent-msg.msg-user {
  background: rgba(var(--v-theme-primary), 0.06);
}
.prompt-agent-msg.msg-bot {
  background: #f5f5f5;
}

.prompt-agent-diff {
  background: #fffde7;
  border: 1px solid #fff9c4;
  border-radius: 8px;
  padding: 8px;
}
.prompt-agent-apply-btn {
  border: none;
  background: rgb(var(--v-theme-primary));
  color: #fff;
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
}
.prompt-agent-apply-btn:hover {
  opacity: 0.9;
}
.prompt-agent-reject-btn {
  border: 1px solid #ccc;
  background: #fff;
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  color: #666;
}

.prompt-agent-input {
  flex: 1;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  outline: none;
}
.prompt-agent-input:focus {
  border-color: rgb(var(--v-theme-primary));
}
.prompt-agent-send-btn {
  border: none;
  background: rgb(var(--v-theme-primary));
  color: #fff;
  cursor: pointer;
  padding: 6px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
}
.prompt-agent-send-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.prompt-agent-send-btn :deep(svg) {
  display: block;
}

.prompt-agent-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(var(--v-theme-primary), 0.2);
  border-top-color: rgb(var(--v-theme-primary));
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Mobile adjustments */
@media (max-width: 960px) {
  .msg-bubble {
    max-width: 85%;
  }
}

.prompt-mobile-sheet {
  height: 70dvh;
  display: flex;
  flex-direction: column;
}
</style>
