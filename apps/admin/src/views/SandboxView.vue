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
      <div class="flex-grow-1 min-width-0">
        <div class="text-subtitle-2 text-truncate">Тестування агента</div>
        <div class="text-caption text-grey text-truncate">Симуляція чату з клієнтом</div>
      </div>
      <v-btn-toggle
        v-model="mobileTab"
        mandatory
        density="compact"
        variant="outlined"
        divided
        class="sandbox-mobile-tabs"
      >
        <v-btn size="x-small" value="chat">Чат</v-btn>
        <v-btn size="x-small" value="prompt">Промпт</v-btn>
      </v-btn-toggle>
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
        <div class="chat-header d-flex align-center pa-2 pa-md-3 ga-2">
          <v-avatar size="36" color="pink-lighten-4">
            <v-icon color="pink-darken-1">mdi-account</v-icon>
          </v-avatar>
          <div class="flex-grow-1">
            <div class="text-subtitle-2">Тестовий клієнт</div>
            <div class="text-caption text-grey">
              {{ persona === 'returning' ? 'sandbox_returning' : 'sandbox_test' }} · симуляція IG
            </div>
            <div class="d-flex flex-wrap ga-1 mt-1">
              <v-chip size="x-small" variant="tonal" color="primary">
                {{ sandboxMeta?.agentMode || '…' }}
              </v-chip>
              <v-chip size="x-small" variant="tonal" color="success">
                CRM reads: live
              </v-chip>
              <v-chip size="x-small" variant="tonal" color="warning">
                writes: dry-run
              </v-chip>
              <v-chip
                v-if="sandboxMeta?.locationLabel"
                size="x-small"
                variant="outlined"
              >
                {{ sandboxMeta.locationLabel }}
              </v-chip>
              <v-chip
                v-if="selectedPromptLabel"
                size="x-small"
                variant="outlined"
              >
                {{ selectedPromptLabel }}
              </v-chip>
            </div>
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
              @click="openResetDialog"
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
            <div class="text-body-1 text-grey-darken-1 mb-1">Симуляція чату з клієнтом</div>
            <div class="text-body-2 text-grey mb-3" style="max-width: 340px; text-align: center;">
              Тут відповідає клієнтський агент (не мета-агент). Навчання лише редагує промпт —
              перевіряй відповіді тут.
            </div>
            <div class="d-flex flex-wrap ga-2 justify-center mb-3">
              <v-btn
                size="small"
                variant="tonal"
                color="secondary"
                prepend-icon="mdi-brain"
                :to="{ name: 'teach' }"
              >
                Відкрити навчання
              </v-btn>
            </div>
            <div class="text-caption text-grey mb-2">Сценарії</div>
            <div class="d-flex flex-wrap ga-2 justify-center">
              <v-chip
                v-for="hint in scenarioHints"
                :key="hint.text"
                size="small"
                variant="outlined"
                class="cursor-pointer hint-chip-touch"
                @click="sendQuickHint(hint.text)"
              >
                {{ hint.label }}
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
                <div v-if="loadingStage" class="text-caption text-grey mb-1">{{ loadingStage }}</div>
                <div class="typing-dots">
                  <span /><span /><span />
                </div>
              </div>
            </div>

            <!-- Failure (always) + copy debug (only with ?debug_enabled=true) -->
            <div v-if="lastFailure || (debugEnabled && lastDebug?.copyBundle)" class="mt-2 sandbox-failure-block">
              <v-alert
                v-if="lastFailure"
                type="error"
                variant="tonal"
                density="compact"
                class="mb-2"
              >
                <div class="font-weight-medium mb-1">Агент не зміг нормально відповісти</div>
                <div class="text-body-2">{{ lastFailure.reasonUk }}</div>
                <div v-if="lastFailure.errorDetail" class="text-caption text-medium-emphasis mt-1">
                  Технічно: {{ lastFailure.errorDetail }}
                </div>
              </v-alert>

              <v-expansion-panels
                v-if="debugEnabled && lastDebug?.copyBundle"
                class="sandbox-debug-panels"
                variant="accordion"
                :model-value="lastFailure ? [0] : []"
              >
                <v-expansion-panel>
                  <v-expansion-panel-title class="text-caption">
                    Debug для Cursor (скопіюй і надішли в чат)
                  </v-expansion-panel-title>
                  <v-expansion-panel-text>
                    <div class="d-flex justify-end mb-1">
                      <v-btn
                        size="small"
                        variant="tonal"
                        color="primary"
                        prepend-icon="mdi-content-copy"
                        @click="copyDebugBundle"
                      >
                        Копіювати
                      </v-btn>
                    </div>
                    <pre class="sandbox-debug-pre sandbox-debug-pre--copy">{{ lastDebug.copyBundle }}</pre>
                  </v-expansion-panel-text>
                </v-expansion-panel>
              </v-expansion-panels>
            </div>

            <!-- Tool debug -->
            <v-expansion-panels
              v-if="debugEnabled && lastDebug?.tools?.length"
              class="mt-2 sandbox-debug-panels"
              variant="accordion"
            >
              <v-expansion-panel>
                <v-expansion-panel-title class="text-caption">
                  Що зробив агент ({{ lastDebug.tools.length }} tools)
                </v-expansion-panel-title>
                <v-expansion-panel-text>
                  <div
                    v-for="(t, i) in lastDebug.tools"
                    :key="i"
                    class="sandbox-debug-tool mb-2"
                  >
                    <div class="text-caption font-weight-medium">
                      {{ t.name }}
                      <v-chip
                        v-if="t.dryRun"
                        size="x-small"
                        color="warning"
                        variant="tonal"
                        class="ml-1"
                      >
                        dry-run
                      </v-chip>
                    </div>
                    <pre class="sandbox-debug-pre">{{ formatDebugArgs(t.args) }}</pre>
                    <pre class="sandbox-debug-pre sandbox-debug-pre--result">{{ t.resultPreview }}</pre>
                  </div>
                </v-expansion-panel-text>
              </v-expansion-panel>
            </v-expansion-panels>
          </div>
        </div>

        <div
          v-if="sandboxMeta?.warnings?.length"
          class="px-3 py-1"
        >
          <v-alert
            v-for="(w, i) in sandboxMeta.warnings"
            :key="i"
            type="warning"
            variant="tonal"
            density="compact"
            class="mb-1 text-caption"
          >
            {{ w }}
          </v-alert>
        </div>

        <!-- Persona + scenarios bar -->
        <div v-if="!replayMode" class="persona-bar px-2 px-md-3 pt-2 d-flex flex-wrap align-center ga-2">
          <v-btn-toggle
            v-model="persona"
            mandatory
            density="compact"
            variant="outlined"
            divided
            color="primary"
          >
            <v-btn size="x-small" value="new">Новий клієнт</v-btn>
            <v-btn size="x-small" value="returning">Повторний + історія</v-btn>
          </v-btn-toggle>
        </div>

        <!-- Replay step confirmation -->
        <div v-if="replayMode && !replayWaitingResponse" class="replay-bar pa-2 pa-md-3 d-flex align-center ga-2 flex-wrap">
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
        <div v-if="!replayMode" class="input-area agent-chat-input pa-2 pa-md-3">
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
              class="agent-send-btn"
              :loading="loading"
              :disabled="!inputText.trim()"
              aria-label="Надіслати"
              @click="sendMessage"
            />
          </div>
        </div>
      </div>

      <!-- Right: Prompt panel (desktop only, or mobile bottom sheet) -->
      <v-bottom-sheet
        v-if="mobile"
        :model-value="mobileTab === 'prompt' || showPromptPanel"
        inset
        scrollable
        @update:model-value="(v: boolean) => { if (!v) { mobileTab = 'chat'; showPromptPanel = false; } }"
      >
        <v-card class="prompt-mobile-sheet">
          <div class="prompt-sheet-handle" />
          <div class="prompt-sheet-header d-flex align-center pa-3 pb-2">
            <div class="flex-grow-1">
              <div class="text-subtitle-2">Системний промпт</div>
              <div class="text-caption text-grey">Редагування та помічник промпту</div>
            </div>
            <v-btn
              icon="mdi-close"
              variant="text"
              size="small"
              aria-label="Закрити"
              @click="showPromptPanel = false"
            />
          </div>
          <v-divider />
          <div class="prompt-sheet-body pa-3 pt-2">
            <prompt-editor />
          </div>
        </v-card>
      </v-bottom-sheet>

      <div v-else-if="showPromptPanel" class="prompt-sidebar d-flex flex-column">
        <prompt-editor />
      </div>
    </div>

    <!-- Reset chat confirmation -->
    <v-dialog v-model="showResetDialog" max-width="400">
      <v-card>
        <v-card-title class="text-subtitle-1">Скинути діалог?</v-card-title>
        <v-card-text class="text-body-2">
          Усі повідомлення тестового чату будуть видалені. Прогонку кейсу також буде зупинено.
        </v-card-text>
        <v-card-actions class="dialog-actions-stack">
          <v-spacer class="d-none d-sm-flex" />
          <v-btn variant="text" @click="showResetDialog = false">Скасувати</v-btn>
          <v-btn color="error" variant="flat" @click="confirmResetChat">Скинути</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

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
        <v-card-actions class="dialog-actions-stack">
          <v-spacer class="d-none d-sm-flex" />
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
            hint="Необов'язково"
            persistent-hint
            variant="outlined"
            density="compact"
            autofocus
            clearable
            placeholder="напр. Додав правило про безкоштовну доставку"
            @keydown.enter="saveOverrideAsVersion"
          />
        </v-card-text>
        <v-card-actions class="dialog-actions-stack">
          <v-spacer class="d-none d-sm-flex" />
          <v-btn variant="text" :disabled="savingVersion" @click="showSaveVersionDialog = false">Скасувати</v-btn>
          <v-btn
            color="primary"
            :loading="savingVersion"
            @click="saveOverrideAsVersion"
          >
            Зберегти чернетку
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar
      v-model="snackbar"
      :color="snackbarColor"
      :timeout="3000"
      location="bottom"
    >
      {{ snackbarText }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, watch, defineComponent, h } from 'vue';
import { useDisplay } from 'vuetify';
import { useRoute } from 'vue-router';
import api from '@/api';
import { formatMetaAgentMarkdown } from '@/lib/metaAgentMarkdown';

const { mobile } = useDisplay();
const route = useRoute();

/** Opt-in debug UI: /sandbox?debug_enabled=true */
const debugEnabled = computed(() => {
  const q = route.query.debug_enabled;
  const raw = Array.isArray(q) ? q[0] : q;
  return raw === 'true' || raw === '1';
});

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

interface SandboxToolDebug {
  name: string;
  args: Record<string, unknown>;
  resultPreview: string;
  dryRun?: boolean;
}

interface SandboxDebug {
  agentMode?: string;
  promptVersion?: number | null;
  persona?: string;
  locationLabel?: string | null;
  branchCrmId?: string | null;
  fidelity?: { reads: string; writes: string };
  warnings?: string[];
  stages?: string[];
  tools?: SandboxToolDebug[];
  copyBundle?: string;
  claudeRounds?: unknown[];
  durationMs?: number;
  gateReason?: string;
}

interface SandboxFailure {
  code: string;
  reasonUk: string;
  errorDetail?: string | null;
}

interface SandboxMeta {
  agentMode: string;
  locationLabel: string | null;
  branchCrmId: string | null;
  fidelity: { reads: string; writes: string };
  warnings: string[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const chatMessages = ref<ChatMessage[]>([]);
const inputText = ref('');
const loading = ref(false);
const loadingStage = ref('');
const messagesArea = ref<HTMLElement | null>(null);
const mobileTab = ref<'chat' | 'prompt'>('chat');
const persona = ref<'new' | 'returning'>('new');
const sandboxMeta = ref<SandboxMeta | null>(null);
const lastDebug = ref<SandboxDebug | null>(null);
const lastFailure = ref<SandboxFailure | null>(null);

// Cases
const cases = ref<SandboxCase[]>([]);
const showCasesDrawer = ref(false);
const showSaveDialog = ref(false);
const showResetDialog = ref(false);
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
const promptAgentDiff = ref<Array<{ before: string; after: string; summary: string }> | null>(null);
const promptAgentTab = ref<'edit' | 'agent'>('edit');
const includeConversationContext = ref(true);
const promptAgentMessagesEl = ref<HTMLElement | null>(null);

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

const scenarioHints = [
  { label: 'Запис на завтра', text: 'Добрий день! Хочу записатись на чоловічий манікюр на завтра в обід. Які є вікна?' },
  { label: 'У мого майстра', text: 'Привіт! Хочу як минулого разу, до мого майстра. Що є найближчим часом?' },
  { label: 'Курс', text: 'Цікавлять курси манікюру з нуля. Скільки коштує Base Classic?' },
  { label: 'Скарга', text: 'У мене відшарувався гель-лак на 5 день. Що робити?' },
];

const quickHints = scenarioHints.map((h) => h.text);

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

const clientMessagesFromChat = computed(() =>
  chatMessages.value.filter((m) => m.role === 'user').map((m) => m.content),
);

const selectedPromptLabel = computed(() => {
  if (useCustomPrompt.value) return 'override draft';
  const p = prompts.value.find((x) => x.id === selectedPromptId.value);
  if (p) return `v${p.version}${p.isActive ? ' active' : ''}`;
  const active = prompts.value.find((x) => x.isActive);
  return active ? `v${active.version} active` : null;
});

watch(mobileTab, (tab) => {
  if (tab === 'prompt') showPromptPanel.value = true;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function showSnack(text: string, color = 'success') {
  snackbarText.value = text;
  snackbarColor.value = color;
  snackbar.value = true;
}

function formatDebugArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

async function copyDebugBundle() {
  const text = lastDebug.value?.copyBundle;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showSnack('Debug скопійовано — можна вставити в Cursor');
  } catch {
    showSnack('Не вдалося скопіювати в буфер', 'error');
  }
}

/** Map axios/network failures so we don't show a vague "Помилка зв'язку". */
function classifySandboxNetworkError(e: any): SandboxFailure {
  const status = e.response?.status as number | undefined;
  const code = String(e.code ?? '');
  const msg = String(e.message ?? '');
  const bodyError = typeof e.response?.data?.error === 'string' ? e.response.data.error : null;

  if (code === 'ECONNABORTED' || /timeout/i.test(msg)) {
    return {
      code: 'proxy_timeout',
      reasonUk:
        'Запит обірвався за часом (часто nginx proxy_read_timeout < часу Claude+CRM). Потрібен timeout ≥600s на /api/.',
      errorDetail: bodyError || msg || code,
    };
  }
  if (!e.response && (code === 'ERR_NETWORK' || code === 'ECONNRESET' || code === 'ECONNREFUSED')) {
    return {
      code: 'proxy_cut',
      reasonUk:
        'Зв\'язок обірвано посеред відповіді (типово nginx закрив довгий /sandbox/chat). Перевір proxy_read_timeout і логи backend.',
      errorDetail: bodyError || `${code}: ${msg}`,
    };
  }
  if (status === 502 || status === 504) {
    return {
      code: 'gateway',
      reasonUk: `Шлюз ${status}: проксі не дочекався відповіді backend (підніми proxy_read_timeout).`,
      errorDetail: bodyError || msg,
    };
  }
  if (status === 413) {
    return {
      code: 'payload_too_large',
      reasonUk: 'Занадто великий запит (413).',
      errorDetail: bodyError || msg,
    };
  }
  return {
    code: 'exception',
    reasonUk: bodyError || (status ? `Помилка HTTP ${status}` : 'Помилка зв\'язку з API'),
    errorDetail: bodyError || msg || code || null,
  };
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
  loadingStage.value = 'Думаю…';
  lastDebug.value = null;
  lastFailure.value = null;
  await scrollToBottom();

  try {
    const payload: Record<string, unknown> = {
      messages: chatMessages.value.map((m) => ({ role: m.role, content: m.content })),
      persona: persona.value,
    };
    if (useCustomPrompt.value && promptOverride.value.trim()) {
      payload.promptOverride = promptOverride.value;
    } else if (selectedPromptId.value) {
      payload.systemPromptId = selectedPromptId.value;
    }

    // Claude + CRM tool rounds can take several minutes; nginx default 60s used to cut this short.
    const { data } = await api.post('/sandbox/chat', payload, {
      signal: controller.signal,
      timeout: 600_000,
    });

    if (data.debug?.stages?.length) {
      loadingStage.value = data.debug.stages[data.debug.stages.length - 1];
    }
    lastDebug.value = data.debug ?? null;
    lastFailure.value = data.failure ?? (data.ok === false ? {
      code: 'unknown',
      reasonUk: data.error || 'Агент не зміг відповісти',
      errorDetail: null,
    } : null);

    if (data.debug?.warnings?.length && sandboxMeta.value) {
      sandboxMeta.value = {
        ...sandboxMeta.value,
        warnings: data.debug.warnings,
        locationLabel: data.debug.locationLabel ?? sandboxMeta.value.locationLabel,
        agentMode: data.debug.agentMode ?? sandboxMeta.value.agentMode,
      };
    }

    const replyText = data.reply || lastFailure.value?.reasonUk || 'Порожня відповідь';
    chatMessages.value.push({
      role: 'assistant',
      content: lastFailure.value ? `⚠️ ${replyText}` : replyText,
      timestamp: new Date(),
    });
    if (lastFailure.value) {
      showSnack(lastFailure.value.reasonUk, 'error');
    }
  } catch (e: any) {
    // Silently ignore aborted requests (stop replay / switch scenario)
    if (e.name === 'CanceledError' || e.code === 'ERR_CANCELED' || e.name === 'AbortError') return;
    const body = e.response?.data;
    const networkFailure = classifySandboxNetworkError(e);
    lastDebug.value = body?.debug ?? null;
    const failure: SandboxFailure = body?.failure ?? networkFailure;
    lastFailure.value = failure;
    if (!lastDebug.value?.copyBundle) {
      lastDebug.value = {
        ...(lastDebug.value ?? {}),
        copyBundle: [
          '=== Sandbox agent debug (paste into Cursor) ===',
          `at: ${new Date().toISOString()}`,
          `ok: false`,
          `failure.code: ${failure.code}`,
          `failure.reasonUk: ${failure.reasonUk}`,
          `failure.errorDetail: ${failure.errorDetail ?? '—'}`,
          `httpStatus: ${e.response?.status ?? 'n/a'}`,
          `axiosCode: ${e.code ?? 'n/a'}`,
          `axiosMessage: ${e.message ?? 'n/a'}`,
          '=== end ===',
        ].join('\n'),
      };
    }
    const errorMsg = failure.reasonUk;
    chatMessages.value.push({
      role: 'assistant',
      content: `⚠️ ${errorMsg}`,
      timestamp: new Date(),
    });
    showSnack(errorMsg, 'error');
  } finally {
    currentAbortController.value = null;
    loading.value = false;
    loadingStage.value = '';
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

function openResetDialog() {
  showResetDialog.value = true;
}

function resetChat() {
  if (currentAbortController.value) {
    currentAbortController.value.abort();
    currentAbortController.value = null;
  }
  loading.value = false;
  chatMessages.value = [];
  replayMode.value = false;
  replayStep.value = 0;
}

function confirmResetChat() {
  showResetDialog.value = false;
  resetChat();
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

async function scrollPromptAgentMessages() {
  await nextTick();
  if (promptAgentMessagesEl.value) {
    promptAgentMessagesEl.value.scrollTop = promptAgentMessagesEl.value.scrollHeight;
  }
}

async function sendToPromptAgent() {
  const text = promptAgentInput.value.trim();
  if (!text || promptAgentLoading.value) return;

  promptAgentMessages.value.push({ role: 'user', content: text });
  promptAgentInput.value = '';
  promptAgentLoading.value = true;
  promptAgentDiff.value = null;
  await scrollPromptAgentMessages();

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
    if (includeConversationContext.value && chatMessages.value.length > 0) {
      payload.conversationContext = chatMessages.value.map((m) => ({
        role: m.role,
        content: m.content,
      }));
    }

    const { data } = await api.post('/meta-agent/chat', payload);

    promptAgentMessages.value.push({ role: 'assistant', content: data.reply });

    if (data.suggestedDiffs && data.suggestedDiffs.length > 0) {
      promptAgentDiff.value = data.suggestedDiffs;
    } else {
      promptAgentDiff.value = null;
    }
  } catch (e: any) {
    const errorMsg = e.response?.data?.error || 'Помилка зв\'язку з мета-агентом';
    promptAgentMessages.value.push({ role: 'assistant', content: `Помилка: ${errorMsg}` });
  } finally {
    promptAgentLoading.value = false;
    await scrollPromptAgentMessages();
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
  if (!promptOverride.value.trim()) return;

  savingVersion.value = true;
  try {
    const summary = saveVersionSummary.value.trim();
    // Creates a draft (isActive: false) — explicit activation still happens
    // on the Prompts page. Sandbox is for editing and verifying, not for
    // silent prod rollouts.
    const { data } = await api.post('/prompts', {
      content: promptOverride.value,
      changeSummary: summary || null,
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

function applyPromptAgentDiff(idx: number) {
  if (!promptAgentDiff.value) return;
  const diff = promptAgentDiff.value[idx];
  if (!diff) return;

  const apply = () => {
    doApplyDiff(diff.before, diff.after);
    promptAgentDiff.value = promptAgentDiff.value!.filter((_, i) => i !== idx);
    if (promptAgentDiff.value.length === 0) {
      promptAgentDiff.value = null;
      promptAgentTab.value = 'edit';
    }
    showSnack('Зміну застосовано до промпту');
  };

  if (!useCustomPrompt.value) {
    const activeId = selectedPromptId.value || prompts.value.find((p) => p.isActive)?.id;
    if (activeId) {
      loadPromptContent(activeId).then(() => apply());
      return;
    }
  }
  apply();
}

function rejectDiff(idx: number) {
  if (!promptAgentDiff.value) return;
  promptAgentDiff.value = promptAgentDiff.value.filter((_, i) => i !== idx);
  if (promptAgentDiff.value.length === 0) promptAgentDiff.value = null;
}

function applyAllDiffs() {
  if (!promptAgentDiff.value || promptAgentDiff.value.length === 0) return;
  const diffs = [...promptAgentDiff.value];

  const doApplyAll = () => {
    for (const diff of diffs) {
      doApplyDiff(diff.before, diff.after);
    }
    promptAgentDiff.value = null;
    promptAgentTab.value = 'edit';
    showSnack(`Застосовано ${diffs.length} змін до промпту`);
  };

  if (!useCustomPrompt.value) {
    const activeId = selectedPromptId.value || prompts.value.find((p) => p.isActive)?.id;
    if (activeId) {
      loadPromptContent(activeId).then(() => doApplyAll());
      return;
    }
  }
  doApplyAll();
}

function doApplyDiff(before: string, after: string) {
  if (before && promptOverride.value.includes(before)) {
    promptOverride.value = promptOverride.value.replace(before, after);
  } else {
    promptOverride.value = promptOverride.value + '\n\n' + after;
  }
  useCustomPrompt.value = true;
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
          h('div', { class: 'text-subtitle-2 mb-1' }, 'Системний промпт'),
          h('div', { class: 'prompt-md-hint d-flex align-center ga-1 mb-2' }, [
            h('span', { class: 'prompt-md-hint-icon', innerHTML: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.56 18H3.44A1.44 1.44 0 0 1 2 16.56V7.44A1.44 1.44 0 0 1 3.44 6h17.12A1.44 1.44 0 0 1 22 7.44v9.12A1.44 1.44 0 0 1 20.56 18M6.81 15.19V11.53l1.92 2.44 1.92-2.44v3.66h1.93V8.81h-1.93l-1.92 2.44L6.81 8.81H4.89v6.38h1.92m11.27-3.18V8.81h-1.92v3.2h-1.93l2.89 3.37 2.89-3.37h-1.93Z"/></svg>' }),
            h('span', null, 'Зберігайте у форматі Markdown (#, **, -, `).'),
          ]),
        ]),
        h('div', { class: 'prompt-tabs d-flex px-3 mb-2' }, [
          h('button', {
            class: ['prompt-tab', promptAgentTab.value === 'edit' ? 'prompt-tab-active' : ''],
            onClick: () => { promptAgentTab.value = 'edit'; },
          }, 'Редагування'),
          h('button', {
            class: ['prompt-tab', promptAgentTab.value === 'agent' ? 'prompt-tab-active' : ''],
            onClick: () => { promptAgentTab.value = 'agent'; },
          }, 'Помічник промпту'),
        ]),

        // Edit tab
        promptAgentTab.value === 'edit'
          ? h('div', { class: 'flex-grow-1 d-flex flex-column px-3 pb-3', style: 'min-height: 0; overflow: hidden;' }, [
          h('div', { class: 'text-caption text-grey mb-2' },
            'Щоб порівняти версії промпту: обери іншу версію вище і прожени той самий кейс.',
          ),
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
                    placeholder: 'Вставте або відредагуйте промпт у форматі Markdown...',
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
                'Опишіть що змінити в промпті — помічник запропонує правки (це не клієнтський чат)',
              ),
              // Messages
              h('div', {
                ref: promptAgentMessagesEl,
                class: 'prompt-agent-messages flex-grow-1 mb-2',
              },
                promptAgentMessages.value.length === 0 && !promptAgentLoading.value
                  ? [h('div', { class: 'text-center text-grey pa-3 text-caption' }, 'Напишіть що змінити в промпті')]
                  : [
                      ...promptAgentMessages.value.map((msg, idx) =>
                        h('div', {
                          key: idx,
                          class: ['prompt-agent-msg mb-2', msg.role === 'user' ? 'msg-user' : 'msg-bot'],
                        }, [
                          h('div', { class: 'text-caption font-weight-medium mb-1' },
                            msg.role === 'user' ? 'Ви' : 'Помічник',
                          ),
                          h('div', {
                            class: [
                              'meta-agent-md',
                              msg.role === 'user' ? 'meta-agent-md--on-primary' : '',
                            ],
                            innerHTML: formatMetaAgentMarkdown(msg.content),
                          }),
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
              // Diffs (array — each with individual Apply/Reject + "Apply all" when multiple)
              promptAgentDiff.value && promptAgentDiff.value.length > 0
                ? h('div', { class: 'prompt-agent-diffs mb-2' }, [
                    promptAgentDiff.value.length > 1
                      ? h('div', { class: 'd-flex justify-end mb-1' }, [
                          h('button', {
                            class: 'prompt-agent-apply-all-btn',
                            onClick: () => applyAllDiffs(),
                          }, `Застосувати всі (${promptAgentDiff.value!.length})`),
                        ])
                      : null,
                    ...promptAgentDiff.value.map((diff, i) =>
                      h('div', { key: i, class: 'prompt-agent-diff mb-1' }, [
                        h('div', { class: 'text-caption font-weight-bold mb-1' },
                          diff.summary || `Зміна ${i + 1}`,
                        ),
                        h('div', {
                          class: ['d-flex ga-1', mobile.value ? 'flex-column' : ''],
                        }, [
                          h('button', {
                            class: 'prompt-agent-apply-btn',
                            onClick: () => applyPromptAgentDiff(i),
                          }, 'Застосувати'),
                          h('button', {
                            class: 'prompt-agent-reject-btn',
                            onClick: () => rejectDiff(i),
                          }, 'Відхилити'),
                        ]),
                      ]),
                    ),
                  ])
                : null,
              // Context toggle + Input
              h('div', { class: 'prompt-agent-footer d-flex flex-column ga-1' }, [
                chatMessages.value.length > 0
                  ? h('label', { class: 'prompt-agent-ctx-toggle text-caption d-flex align-center ga-1 cursor-pointer' }, [
                      h('input', {
                        type: 'checkbox',
                        checked: includeConversationContext.value,
                        onChange: (e: Event) => {
                          includeConversationContext.value = (e.target as HTMLInputElement).checked;
                        },
                      }),
                      `Включити контекст чату (${chatMessages.value.length} повід.)`,
                    ])
                  : null,
                h('div', { class: 'd-flex ga-1 align-end' }, [
                  h('textarea', {
                    class: 'prompt-agent-input',
                    value: promptAgentInput.value,
                    rows: 1,
                    placeholder: 'Додай правило про...',
                    disabled: promptAgentLoading.value,
                    onInput: (e: Event) => {
                      promptAgentInput.value = (e.target as HTMLTextAreaElement).value;
                    },
                    onKeydown: (e: KeyboardEvent) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendToPromptAgent();
                      }
                    },
                  }),
                  h('button', {
                    class: 'prompt-agent-send-btn',
                    disabled: !promptAgentInput.value.trim() || promptAgentLoading.value,
                    onClick: () => sendToPromptAgent(),
                    innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>',
                  }),
                ]),
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
  await Promise.all([loadCases(), loadPrompts(), loadSandboxMeta()]);
  const qVersion = route.query.promptVersion;
  if (typeof qVersion === 'string' && qVersion.trim()) {
    const match = prompts.value.find((p) => String(p.version) === qVersion.trim());
    if (match) {
      selectedPromptId.value = match.id;
      useCustomPrompt.value = false;
      showSnack(`Підставлено чернетку v${match.version} для тесту`);
    }
  }
});

async function loadSandboxMeta() {
  try {
    const { data } = await api.get<SandboxMeta>('/sandbox/meta');
    sandboxMeta.value = data;
  } catch {
    sandboxMeta.value = null;
  }
}
</script>

<style scoped>
.sandbox-mobile-header {
  background: rgb(var(--v-theme-surface));
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  flex: 0 0 auto;
}

.sandbox-mobile-tabs {
  flex-shrink: 0;
}

.persona-bar {
  border-top: 1px solid rgba(var(--v-border-color), 0.4);
  background: rgb(var(--v-theme-surface));
}

.sandbox-debug-panels {
  max-width: 100%;
}

.sandbox-debug-pre {
  margin: 4px 0 0;
  padding: 8px;
  font-size: 11px;
  line-height: 1.35;
  white-space: pre-wrap;
  word-break: break-word;
  background: rgba(0, 0, 0, 0.04);
  border-radius: 6px;
  max-height: 160px;
  overflow: auto;
}

.sandbox-debug-pre--result {
  background: rgba(76, 175, 80, 0.08);
}

.sandbox-debug-pre--copy {
  max-height: 280px;
  background: rgba(33, 33, 33, 0.06);
}

.sandbox-failure-block {
  max-width: 100%;
}

.sandbox-layout {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.sandbox-root.mobile .sandbox-layout {
  flex: 1 1 auto;
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
.prompt-md-hint {
  font-size: 11px;
  line-height: 1.3;
  color: #1976d2;
  background: rgba(25, 118, 210, 0.08);
  border-radius: 6px;
  padding: 4px 8px;
}
.prompt-md-hint-icon {
  display: inline-flex;
  align-items: center;
  color: #1976d2;
  flex-shrink: 0;
}
.prompt-md-hint-icon :deep(svg) {
  display: block;
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
  padding: 8px 10px;
  border-radius: 8px;
  line-height: 1.4;
}
.prompt-agent-msg.msg-user {
  background: rgb(var(--v-theme-primary));
  color: #fff;
}
.prompt-agent-msg.msg-user .text-caption {
  color: rgba(255, 255, 255, 0.85);
}
.prompt-agent-msg.msg-bot {
  background: #f5f5f5;
}

.prompt-agent-diffs {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.prompt-agent-diff {
  background: #fffde7;
  border: 1px solid #fff9c4;
  border-radius: 8px;
  padding: 8px;
}

.prompt-agent-apply-all-btn {
  border: none;
  background: #1a73e8;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.prompt-agent-apply-all-btn:hover {
  opacity: 0.9;
}

.prompt-agent-footer {
  flex-shrink: 0;
}

.prompt-agent-ctx-toggle {
  color: #666;
  user-select: none;
  line-height: 1.4;
}
.prompt-agent-apply-btn {
  border: none;
  background: rgb(var(--v-theme-primary));
  color: #fff;
  font-size: 12px;
  padding: 8px 12px;
  min-height: 40px;
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
  padding: 8px 12px;
  min-height: 40px;
  border-radius: 4px;
  cursor: pointer;
  color: #666;
}

.prompt-agent-input {
  flex: 1;
  min-width: 0;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.4;
  font-family: inherit;
  resize: none;
  outline: none;
  max-height: 96px;
  overflow-y: auto;
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
  min-width: 44px;
  min-height: 44px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
  flex-shrink: 0;
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
  max-height: 88dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 16px 16px 0 0;
  padding-bottom: env(safe-area-inset-bottom);
}

.prompt-sheet-handle {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.15);
  margin: 8px auto 0;
  flex-shrink: 0;
}

.prompt-sheet-header {
  flex-shrink: 0;
}

.prompt-sheet-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.prompt-mobile-sheet .prompt-editor {
  min-height: 0;
  flex: 1 1 auto;
  height: min(72dvh, 640px);
}

/* Sheet header already shows title — hide duplicate inside editor */
.prompt-sheet-body .prompt-editor > div:first-child > .text-subtitle-2 {
  display: none;
}

.min-width-0 {
  min-width: 0;
}
</style>
