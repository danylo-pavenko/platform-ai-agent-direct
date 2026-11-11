<template>
  <v-container
    fluid
    class="agent-page-shell page-shell pa-2 pa-md-4"
  >
    <div class="agent-page-header-compact d-flex align-center ga-2 mb-2 mb-md-3 px-1 flex-shrink-0">
      <div class="flex-grow-1 min-width-0">
        <div class="page-title" style="font-size: 18px;">Навчання агента</div>
        <div class="page-subtitle d-none d-sm-block">
          Поведінка бота → правки промпту. Факти й події → картка бібліотеки. Метрики — у AI-помічнику.
        </div>
        <div v-if="mobile" class="page-subtitle-mobile d-sm-none">
          Промпт або картка · потім застосувати
        </div>
      </div>
      <v-btn
        v-if="loading"
        variant="tonal"
        color="error"
        size="small"
        class="flex-shrink-0"
        @click="cancelStream"
      >
        Скасувати
      </v-btn>
      <v-btn
        variant="tonal"
        size="small"
        prepend-icon="mdi-plus-circle-outline"
        class="flex-shrink-0 d-none d-sm-flex"
        @click="newSessionDialogOpen = true"
      >
        Нова сесія
      </v-btn>
      <v-btn
        variant="tonal"
        size="small"
        icon="mdi-plus-circle-outline"
        class="flex-shrink-0 d-sm-none"
        aria-label="Нова сесія"
        @click="newSessionDialogOpen = true"
      />
    </div>

    <div v-if="sessionLoaded" class="px-1 mb-2 flex-shrink-0">
      <div class="d-flex align-center ga-2 flex-wrap text-caption text-grey">
        <v-chip size="x-small" variant="tonal" color="primary">
          {{ sessionTitle || 'Поточна сесія' }}
        </v-chip>
        <span>{{ exchangeCount }}/{{ contextLimit }} запитів</span>
        <span v-if="messageCount > 0" class="text-grey-lighten-1">· {{ messageCount }} повід.</span>
        <v-chip
          v-if="linkedConversationId"
          size="x-small"
          variant="tonal"
          color="info"
          closable
          @click:close="clearConversationLink"
        >
          Діалог {{ linkedConversationId.slice(0, 8) }}…
        </v-chip>
      </div>
      <v-alert
        v-if="contextNearFull"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-2 text-body-2"
      >
        Сесія довга — старі повідомлення стискаються в підсумок. Можна
        <a href="#" class="text-warning" @click.prevent="newSessionDialogOpen = true">почати нову сесію</a>.
      </v-alert>
    </div>

    <div class="flex-grow-1 d-flex flex-column flex-md-row ga-2 ga-md-3" style="min-height: 0; overflow: hidden;">
      <v-card
        class="d-flex flex-column flex-grow-1"
        flat
        style="min-height: 0;"
      >
        <div
          ref="messagesContainer"
          class="flex-grow-1 overflow-y-auto pa-3 pa-md-4"
          style="min-height: 0;"
        >
          <div v-if="sessionLoading" class="d-flex justify-center align-center pa-6" style="height: 100%;">
            <v-progress-circular indeterminate color="primary" size="32" />
          </div>

          <div
            v-else-if="messages.length === 0 && !loading"
            class="d-flex flex-column align-center justify-center text-center"
            style="height: 100%;"
          >
            <v-icon size="48" color="grey-lighten-1" class="mb-3">mdi-chat-outline</v-icon>
            <div class="text-body-1 text-grey-darken-1 mb-1">Почніть розмову</div>
            <div class="text-body-2 text-grey px-4 mb-3" style="max-width: 420px;">
              Два шляхи: змінити поведінку бота (промпт) або додати факт/подію (картка бібліотеки).
            </div>
            <div class="d-flex flex-wrap justify-center ga-2 px-2" style="max-width: 480px;">
              <v-chip
                v-for="chip in suggestionChips"
                :key="chip.label"
                size="small"
                variant="outlined"
                class="hint-chip-touch"
                @click="applyChip(chip)"
              >
                {{ chip.label }}
              </v-chip>
            </div>
          </div>

          <div
            v-for="(msg, idx) in messages"
            :key="idx"
            class="mb-3 d-flex"
            :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
          >
            <div :style="{ maxWidth: mobile ? '92%' : '75%' }">
              <div
                class="text-caption text-grey mb-1"
                :class="msg.role === 'user' ? 'text-right' : ''"
              >
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

          <div v-if="loading" class="mb-3 d-flex justify-start">
            <div :style="{ maxWidth: mobile ? '92%' : '75%' }">
              <div class="text-caption text-grey mb-1">Мета-агент</div>
              <v-card color="grey-lighten-4" variant="flat" rounded="lg" class="pa-3">
                <div v-if="streamStageLabel" class="text-caption text-grey mb-2">
                  {{ streamStageLabel }}
                </div>
                <div
                  v-if="streamingText"
                  class="meta-agent-md"
                  v-html="formatMetaAgentMarkdown(streamingText)"
                />
                <div v-else class="typing-dots">
                  <span /><span /><span />
                </div>
              </v-card>
            </div>
          </div>

          <div
            v-if="!loading && (currentDiffs.length > 0 || savedLibraryCards.length > 0 || showInsightsCta)"
            class="teach-result-cards mt-2"
          >
            <v-card
              v-if="currentDiffs.length > 0"
              variant="outlined"
              rounded="lg"
              class="pa-3 mb-2"
            >
              <div class="text-subtitle-2 mb-1">Правки промпту ({{ currentDiffs.length }})</div>
              <div class="text-body-2 text-medium-emphasis mb-2">
                {{ currentDiffs[0]?.summary || 'Зміни поведінки бота' }}
                <span v-if="currentDiffs.length > 1"> · +{{ currentDiffs.length - 1 }}</span>
              </div>
              <div class="d-flex flex-wrap ga-2">
                <v-btn
                  size="small"
                  variant="tonal"
                  @click="diffSheetOpen = true"
                >
                  Переглянути
                </v-btn>
                <v-btn
                  size="small"
                  color="warning"
                  variant="flat"
                  :loading="batchApplying"
                  :disabled="unappliedDiffs.length === 0"
                  @click="openBatchActivateConfirm"
                >
                  Застосувати і активувати
                </v-btn>
              </div>
            </v-card>

            <v-card
              v-for="card in savedLibraryCards"
              :key="card.id"
              variant="outlined"
              rounded="lg"
              class="pa-3 mb-2"
            >
              <div class="text-subtitle-2 mb-1">{{ card.title || card.slug }}</div>
              <div class="text-caption text-medium-emphasis mb-2">{{ card.slug }}</div>
              <div class="d-flex flex-wrap ga-2">
                <v-btn
                  size="small"
                  color="primary"
                  variant="flat"
                  :loading="publishingLibraryId === card.id"
                  :disabled="card.published"
                  @click="publishLibraryCard(card)"
                >
                  {{ card.published ? 'Опубліковано' : 'Опублікувати' }}
                </v-btn>
                <v-btn
                  size="small"
                  variant="tonal"
                  :to="{ name: 'library' }"
                >
                  Відкрити в Бібліотеці
                </v-btn>
              </div>
            </v-card>

            <v-card
              v-if="showInsightsCta"
              variant="tonal"
              color="info"
              rounded="lg"
              class="pa-3 mb-2"
            >
              <div class="text-body-2 mb-2">Метрики дивись у AI-помічнику — тут лише правки промпту й бібліотека.</div>
              <v-btn size="small" color="info" variant="flat" :to="{ name: 'insights' }">
                Відкрити AI-помічник
              </v-btn>
            </v-card>
          </div>

          <div
            v-if="lastError && !loading"
            class="teach-stream-toast mt-2 d-flex align-center ga-2 flex-wrap"
          >
            <span class="text-caption text-error">{{ lastError }}</span>
            <v-btn
              v-if="lastFailedMessage"
              size="x-small"
              variant="text"
              color="error"
              @click="retryLast"
            >
              Повторити
            </v-btn>
            <v-btn
              size="x-small"
              variant="text"
              @click="lastError = null; lastErrorDetail = null"
            >
              Закрити
            </v-btn>
          </div>
        </div>

        <v-divider />
        <div class="agent-chat-input teach-composer-sticky pa-2 pa-md-3">
          <div
            v-if="messages.length > 0 && !loading"
            class="d-flex flex-wrap ga-1 mb-2"
          >
            <v-chip
              v-for="chip in suggestionChips"
              :key="chip.label"
              size="x-small"
              variant="tonal"
              @click="applyChip(chip)"
            >
              {{ chip.label }}
            </v-chip>
          </div>
          <div class="d-flex ga-2 align-end">
            <v-textarea
              v-model="inputText"
              placeholder="Опишіть зміну поведінки або факт/подію…"
              variant="outlined"
              density="compact"
              rows="1"
              max-rows="4"
              auto-grow
              hide-details
              :disabled="loading || sessionLoading"
              @keydown.enter.exact.prevent="sendMessage"
              @keydown.shift.enter.stop
            />
            <v-btn
              color="primary"
              icon="mdi-send"
              class="agent-send-btn"
              :loading="loading"
              :disabled="!inputText.trim() || sessionLoading"
              aria-label="Надіслати"
              @click="sendMessage"
            />
          </div>
          <div v-if="!mobile" class="text-caption text-grey mt-1 d-none d-md-block">
            Enter — надіслати, Shift+Enter — новий рядок
          </div>
        </div>
      </v-card>

      <v-card
        v-if="currentDiffs.length > 0 && !mobile"
        class="diff-panel d-flex flex-column flex-grow-1"
        flat
        style="min-height: 0;"
      >
        <meta-agent-diff-panel
          :diffs="currentDiffs"
          :applied-results="appliedResults"
          :applying-index="applyingIndex"
          :activating-prompt-id="activatingPromptId"
          :active-base-version="activeBaseVersion"
          :unapplied-count="unappliedDiffs.length"
          :batch-applying="batchApplying"
          show-title
          @apply="applyDiffAt"
          @activate-confirm="openActivateConfirm"
          @reject="rejectDiff"
          @apply-all="applyAllDiffs"
          @apply-and-activate="openBatchActivateConfirm"
          @save-and-sandbox="saveAndOpenSandbox"
        />
      </v-card>
    </div>

    <v-chip
      v-if="mobile && currentDiffs.length > 0 && !diffSheetOpen"
      class="diff-open-chip"
      color="warning"
      variant="flat"
      prepend-icon="mdi-file-compare"
      @click="diffSheetOpen = true"
    >
      Зміни ({{ currentDiffs.length }})
    </v-chip>

    <v-bottom-sheet
      v-if="mobile"
      v-model="diffSheetOpen"
      inset
      scrollable
    >
      <v-card class="diff-sheet-card">
        <meta-agent-diff-panel
          :diffs="currentDiffs"
          :applied-results="appliedResults"
          :applying-index="applyingIndex"
          :activating-prompt-id="activatingPromptId"
          :active-base-version="activeBaseVersion"
          :unapplied-count="unappliedDiffs.length"
          :batch-applying="batchApplying"
          sheet
          stack-actions
          show-title
          @apply="applyDiffAt"
          @activate-confirm="openActivateConfirm"
          @reject="onMobileRejectDiff"
          @apply-all="applyAllDiffs"
          @apply-and-activate="openBatchActivateConfirm"
          @save-and-sandbox="saveAndOpenSandbox"
          @close="diffSheetOpen = false"
        />
      </v-card>
    </v-bottom-sheet>

    <v-dialog v-model="newSessionDialogOpen" max-width="440" class="dialog-actions-stack">
      <v-card>
        <v-card-title class="text-subtitle-1">Почати нову сесію?</v-card-title>
        <v-card-text class="text-body-2">
          Поточна сесія буде збережена. Нова сесія — чистий контекст без підсумку попередніх правок.
        </v-card-text>
        <v-card-actions class="dialog-actions-stack">
          <v-spacer class="d-none d-sm-flex" />
          <v-btn variant="text" @click="newSessionDialogOpen = false">Скасувати</v-btn>
          <v-btn color="primary" variant="flat" :loading="startingNewSession" @click="confirmNewSession">
            Нова сесія
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="activateDialogOpen" max-width="480" persistent class="dialog-actions-stack">
      <v-card>
        <v-card-title class="text-subtitle-1">
          Активувати зміну одразу?
        </v-card-title>
        <v-card-text class="text-body-2">
          Активна версія промпту буде змінена миттєво — бот почне використовувати новий текст з наступного повідомлення клієнта.
        </v-card-text>
        <v-card-actions class="dialog-actions-stack">
          <v-spacer class="d-none d-sm-flex" />
          <v-btn variant="text" @click="confirmActivate = null">Скасувати</v-btn>
          <v-btn
            color="warning"
            variant="flat"
            :loading="applyingIndex !== null || activatingPromptId !== null || batchApplying"
            @click="confirmActivateNow"
          >
            Так, активувати
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="stalePromptDialogOpen" max-width="440" class="dialog-actions-stack">
      <v-card>
        <v-card-title class="text-subtitle-1">Промпт уже змінився</v-card-title>
        <v-card-text class="text-body-2">
          Активна версія оновилась з моменту генерації правок
          <span v-if="stalePromptVersion"> (зараз v{{ stalePromptVersion }})</span>.
          Перезавантажте базу й сформулюйте запит ще раз.
        </v-card-text>
        <v-card-actions class="dialog-actions-stack">
          <v-spacer class="d-none d-sm-flex" />
          <v-btn variant="text" @click="stalePromptDialogOpen = false">Закрити</v-btn>
          <v-btn color="primary" variant="flat" @click="reloadAfterStalePrompt">
            Перезавантажити
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar
      v-model="snackbar"
      :color="snackbarColor"
      :timeout="snackbarActions ? 8000 : 3500"
      location="bottom"
      :style="{ marginBottom: mobile ? 'env(safe-area-inset-bottom)' : undefined }"
    >
      <div class="d-flex align-center flex-wrap ga-2">
        <span>{{ snackbarText }}</span>
        <template v-if="snackbarActions">
          <v-btn
            size="small"
            variant="text"
            @click="router.push({ name: 'sandbox' }); snackbar = false"
          >
            Пісочниця
          </v-btn>
          <v-btn
            size="small"
            variant="text"
            @click="router.push({ name: 'prompts' }); snackbar = false"
          >
            Промпти
          </v-btn>
        </template>
      </div>
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDisplay } from 'vuetify';
import api from '@/api';
import { formatMetaAgentMarkdown } from '@/lib/metaAgentMarkdown';
import MetaAgentDiffPanel from '@/components/MetaAgentDiffPanel.vue';
import { streamTeachChat } from '@/composables/useMetaAgentTeachStream';

const { mobile } = useDisplay();
const route = useRoute();
const router = useRouter();

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  suggestedDiffs?: SuggestedDiff[];
  libraryDrafts?: LibraryCardHint[];
}

interface TeachSessionState {
  id: string;
  title: string | null;
  messageCount: number;
  exchangeCount: number;
  contextLimit: number;
  contextWarnAt: number;
  contextFull: boolean;
  contextNearFull: boolean;
  messages: ChatMessage[];
}

interface SuggestedDiff {
  before: string;
  after: string;
  summary: string;
}

interface LibraryCardHint {
  id: string;
  slug: string;
  title?: string;
  published?: boolean;
}

interface AppliedResult {
  promptId: string;
  version: number;
  activated: boolean;
}

const suggestionChips = [
  {
    label: 'Коротше',
    text: 'Пиши коротше в Instagram DM: менше абзаців, без води, одна чітка відповідь на питання клієнта.',
  },
  {
    label: 'Подія',
    text: 'Додай у бібліотеку картку про подію/акцію (дати, умови, що казати клієнту). Не дублюй це в системний промпт.',
  },
  {
    label: 'Бібліотека',
    text: 'Винеси факт / прайс поза CRM / виняток у картку бібліотеки з aliases; за потреби короткий diff «читай через read_library».',
  },
  {
    label: 'Доставка',
    text: 'Онови правила доставки: уточни вартість, терміни та безкоштовну доставку, якщо це вже є в знаннях магазину.',
  },
  {
    label: 'Тон',
    text: 'Зроби тон спілкування теплішим і коротшим у Instagram DM, без агресивних продажних тригерів.',
  },
  {
    label: 'Ескалація',
    text: 'Покращ правила ескалації до менеджера: коли передавати, що писати клієнту, що не обіцяти.',
  },
  {
    label: 'CRM',
    text: 'Опиши поведінку агента через існуючі CRM/tools платформи (замовлення, бриф, запис) — без вигаданих API.',
  },
  {
    label: 'Аудит',
    text: 'Зроби аудит поточного промпту: знайди слабкі місця (суперечності, дірки, ризики) і запропонуй пріоритетний список правок з diffs.',
  },
];

const messages = ref<ChatMessage[]>([]);
const sessionId = ref<string | null>(null);
const sessionTitle = ref<string | null>(null);
const messageCount = ref(0);
const exchangeCount = ref(0);
const contextLimit = ref(40);
const contextNearFull = ref(false);
const sessionLoaded = ref(false);
const sessionLoading = ref(true);
const startingNewSession = ref(false);
const inputText = ref('');
const loading = ref(false);
const streamStageLabel = ref('');
const streamingText = ref('');
const lastError = ref<string | null>(null);
const lastErrorDetail = ref<string | null>(null);
const lastFailedMessage = ref<string | null>(null);
const currentDiffs = ref<SuggestedDiff[]>([]);
const savedLibraryCards = ref<LibraryCardHint[]>([]);
const showInsightsCta = ref(false);
const publishingLibraryId = ref<string | null>(null);
const appliedResults = ref<Map<number, AppliedResult>>(new Map());
const applyingIndex = ref<number | null>(null);
const batchApplying = ref(false);
const activatingPromptId = ref<string | null>(null);
const messagesContainer = ref<HTMLElement | null>(null);
const diffSheetOpen = ref(false);
const linkedConversationId = ref<string | null>(null);

const activeBasePromptId = ref<string | null>(null);
const activeBaseVersion = ref<number | null>(null);

const confirmActivate = ref<{ diffIdx: number } | 'batch' | null>(null);
const newSessionDialogOpen = ref(false);
const stalePromptDialogOpen = ref(false);
const stalePromptVersion = ref<number | null>(null);

const snackbar = ref(false);
const snackbarText = ref('');
const snackbarColor = ref('success');
const snackbarActions = ref(false);

let abortController: AbortController | null = null;
/** Optimistic user bubble for the in-flight request (cleared on done / cancel / error). */
let inFlightOptimisticUser: ChatMessage | null = null;
let streamTerminalReceived = false;

const unappliedDiffs = computed(() =>
  currentDiffs.value.filter((_, i) => !appliedResults.value.has(i)),
);

const activateDialogOpen = computed({
  get: () => confirmActivate.value !== null,
  set: (v) => { if (!v) confirmActivate.value = null; },
});

watch(mobile, (isMobile) => {
  if (!isMobile) diffSheetOpen.value = false;
});

function showSnackbar(text: string, color = 'success', withActions = false) {
  snackbarText.value = text;
  snackbarColor.value = color;
  snackbarActions.value = withActions;
  snackbar.value = true;
}

function looksLikeInsightsRequest(text: string): boolean {
  return /скільки|статистик|метрик|конверсі|повідомлень|діалогів|insights/i.test(text);
}

function restoreResultFromMessages(sessionMessages: ChatMessage[]) {
  for (let i = sessionMessages.length - 1; i >= 0; i -= 1) {
    const msg = sessionMessages[i];
    if (msg.role !== 'assistant') continue;
    if (msg.suggestedDiffs && msg.suggestedDiffs.length > 0) {
      currentDiffs.value = msg.suggestedDiffs;
      appliedResults.value = new Map();
    }
    if (msg.libraryDrafts && msg.libraryDrafts.length > 0) {
      savedLibraryCards.value = msg.libraryDrafts.map((c) => ({
        ...c,
        published: c.published === true,
      }));
    }
    break;
  }
}

async function scrollToBottom() {
  await nextTick();
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }
}

function applySessionState(session: TeachSessionState, opts?: { restoreResults?: boolean }) {
  sessionId.value = session.id;
  sessionTitle.value = session.title;
  messageCount.value = session.messageCount;
  exchangeCount.value = session.exchangeCount;
  contextLimit.value = session.contextLimit;
  contextNearFull.value = session.contextNearFull;
  const mapped = session.messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.suggestedDiffs?.length ? { suggestedDiffs: m.suggestedDiffs } : {}),
    ...(m.libraryDrafts?.length ? { libraryDrafts: m.libraryDrafts } : {}),
  }));
  messages.value = mapped;
  if (opts?.restoreResults) {
    restoreResultFromMessages(mapped);
  }
}

function applyChip(chip: { label: string; text: string }) {
  inputText.value = chip.text;
}

function clearConversationLink() {
  linkedConversationId.value = null;
  const q = { ...route.query };
  delete q.conversationId;
  router.replace({ query: q });
}

async function loadSession(opts?: { restoreResults?: boolean }) {
  sessionLoading.value = true;
  try {
    const { data } = await api.get('/meta-agent/teach/session');
    applySessionState(data.session, { restoreResults: opts?.restoreResults !== false });
    sessionLoaded.value = true;
    await scrollToBottom();
  } catch (e: any) {
    showSnackbar(e.response?.data?.error || 'Не вдалося завантажити сесію', 'error');
  } finally {
    sessionLoading.value = false;
  }
}

async function confirmNewSession() {
  startingNewSession.value = true;
  try {
    const { data } = await api.post('/meta-agent/teach/session/new');
    applySessionState(data.session);
    currentDiffs.value = [];
    savedLibraryCards.value = [];
    showInsightsCta.value = false;
    appliedResults.value = new Map();
    inputText.value = '';
    lastError.value = null;
    diffSheetOpen.value = false;
    newSessionDialogOpen.value = false;
    showSnackbar('Нову сесію розпочато');
    await scrollToBottom();
  } catch (e: any) {
    showSnackbar(e.response?.data?.error || 'Не вдалося створити сесію', 'error');
  } finally {
    startingNewSession.value = false;
  }
}

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
    activeBasePromptId.value = null;
    activeBaseVersion.value = null;
  }
}

function removeInFlightOptimistic() {
  if (!inFlightOptimisticUser) return;
  const target = inFlightOptimisticUser;
  messages.value = messages.value.filter((m) => m !== target);
  inFlightOptimisticUser = null;
}

function cancelStream() {
  abortController?.abort();
  abortController = null;
  loading.value = false;
  streamStageLabel.value = '';
  streamingText.value = '';
  removeInFlightOptimistic();
  void loadSession();
  showSnackbar('Запит скасовано', 'warning');
}

async function sendMessage() {
  const text = inputText.value.trim();
  if (!text || loading.value || sessionLoading.value) return;

  lastError.value = null;
  lastErrorDetail.value = null;
  lastFailedMessage.value = null;
  showInsightsCta.value = looksLikeInsightsRequest(text);
  const optimisticUser: ChatMessage = { role: 'user', content: text };
  inFlightOptimisticUser = optimisticUser;
  streamTerminalReceived = false;
  messages.value.push(optimisticUser);
  inputText.value = '';
  loading.value = true;
  streamStageLabel.value = 'Готую контекст…';
  streamingText.value = '';
  currentDiffs.value = [];
  savedLibraryCards.value = [];
  appliedResults.value = new Map();
  diffSheetOpen.value = false;
  await scrollToBottom();
  await loadActiveBase();

  abortController?.abort();
  abortController = new AbortController();
  const signal = abortController.signal;

  try {
    await streamTeachChat(
      {
        message: text,
        ...(linkedConversationId.value
          ? { conversationId: linkedConversationId.value }
          : {}),
      },
      {
        onStage: (s) => {
          streamStageLabel.value = s.label || s.stage;
        },
        onDelta: (delta) => {
          streamingText.value += delta;
          void scrollToBottom();
        },
        onDone: (payload) => {
          streamTerminalReceived = true;
          inFlightOptimisticUser = null;
          if (payload.session) {
            applySessionState(payload.session as TeachSessionState);
          } else {
            messages.value.push({ role: 'assistant', content: payload.reply });
          }
          if (payload.suggestedDiffs && payload.suggestedDiffs.length > 0) {
            currentDiffs.value = payload.suggestedDiffs;
          } else if (payload.suggestedDiff) {
            currentDiffs.value = [payload.suggestedDiff];
          } else {
            currentDiffs.value = [];
          }
          streamingText.value = '';
          streamStageLabel.value = '';

          const savedCards = payload.savedLibraryDrafts ?? [];
          savedLibraryCards.value = savedCards.map((c) => ({
            id: c.id,
            slug: c.slug,
            title: (c as { title?: string }).title,
            published: false,
          }));

          const replyLower = (payload.reply || '').toLowerCase();
          if (replyLower.includes('/insights') || replyLower.includes('ai-помічник')) {
            showInsightsCta.value = true;
          }

          if (currentDiffs.value.length > 0) {
            showSnackbar('Є правки — перегляньте й застосуйте', 'info');
          } else if (savedLibraryCards.value.length > 0) {
            showSnackbar('Чернетку картки збережено', 'info');
          }
        },
        onError: (err) => {
          streamTerminalReceived = true;
          removeInFlightOptimistic();
          if (err.aborted) {
            return;
          }
          if (err.recoverable) {
            void (async () => {
              await loadSession({ restoreResults: true });
              const last = [...messages.value].reverse().find((m) => m.role === 'assistant');
              if (last?.content?.trim()) {
                lastError.value = null;
                showSnackbar('Відповідь відновлено після обриву стріму', 'info');
              } else {
                lastFailedMessage.value = text;
                lastError.value = 'Стрім обірвався. Спробуйте ще раз.';
                showSnackbar(lastError.value, 'error');
              }
            })();
            return;
          }
          lastFailedMessage.value = text;
          lastError.value = err.error || 'Помилка зв\'язку з мета-агентом';
          const detailParts = [err.fallback, err.errorDetail].filter(
            (p): p is string => typeof p === 'string' && p.trim().length > 0,
          );
          lastErrorDetail.value = detailParts.length > 0 ? detailParts.join(' · ') : null;
          showSnackbar(lastError.value, 'error');
          void loadSession({ restoreResults: true });
        },
      },
      signal,
    );

    // Defense in depth if streamTeachChat ever returns without terminal handlers.
    if (!streamTerminalReceived && !signal.aborted) {
      removeInFlightOptimistic();
      lastFailedMessage.value = text;
      lastError.value = 'Стрім обірвався без відповіді. Спробуйте ще раз.';
      showSnackbar(lastError.value, 'error');
      await loadSession({ restoreResults: true });
    } else if (!streamTerminalReceived && signal.aborted) {
      removeInFlightOptimistic();
      await loadSession({ restoreResults: true });
    }
  } catch (e: any) {
    removeInFlightOptimistic();
    if (e?.name === 'AbortError') {
      await loadSession({ restoreResults: true });
    } else {
      lastFailedMessage.value = text;
      lastError.value = e?.message || 'Помилка стріму';
      await loadSession({ restoreResults: true });
      showSnackbar(lastError.value!, 'error');
    }
  } finally {
    loading.value = false;
    streamStageLabel.value = '';
    streamingText.value = '';
    abortController = null;
    await scrollToBottom();
  }
}

function retryLast() {
  if (!lastFailedMessage.value) return;
  inputText.value = lastFailedMessage.value;
  lastError.value = null;
  void sendMessage();
}

function handleStalePromptConflict(e: any) {
  const newActive = e.response?.data?.currentActiveVersion;
  stalePromptVersion.value = typeof newActive === 'number' ? newActive : null;
  stalePromptDialogOpen.value = true;
  currentDiffs.value = [];
  appliedResults.value = new Map();
  diffSheetOpen.value = false;
}

async function reloadAfterStalePrompt() {
  stalePromptDialogOpen.value = false;
  await loadActiveBase();
  showSnackbar('Базу оновлено — сформулюйте запит ще раз', 'info');
}

async function applyDiffAt(idx: number, opts: { activate?: boolean } = {}) {
  const diff = currentDiffs.value[idx];
  if (!diff || applyingIndex.value !== null || batchApplying.value) return;

  const activate = opts.activate === true;
  applyingIndex.value = idx;
  try {
    const publishIds = savedLibraryCards.value
      .filter((c) => !c.published)
      .map((c) => c.id);
    const { data } = await api.post('/meta-agent/apply', {
      before: diff.before,
      after: diff.after,
      summary: diff.summary,
      activate,
      basePromptId: activeBasePromptId.value,
      ...(activate && publishIds.length > 0 ? { publishLibraryIds: publishIds } : {}),
    });

    const next = new Map(appliedResults.value);
    next.set(idx, {
      promptId: data.id,
      version: data.version,
      activated: data.isActive === true,
    });
    appliedResults.value = next;

    if (data.isActive) {
      activeBasePromptId.value = data.id;
      activeBaseVersion.value = data.version;
    }

    if (Array.isArray(data.publishedLibrary) && data.publishedLibrary.length > 0) {
      const publishedIds = new Set(data.publishedLibrary.map((c: { id: string }) => c.id));
      savedLibraryCards.value = savedLibraryCards.value.map((c) =>
        publishedIds.has(c.id) ? { ...c, published: true } : c,
      );
    }

    if (activate) {
      showSnackbar(`v${data.version} активовано`, 'success', true);
    } else {
      showSnackbar(`Чернетку v${data.version} створено`);
    }
  } catch (e: any) {
    const status = e.response?.status;
    const errorMsg = e.response?.data?.error || 'Не вдалося застосувати';
    if (status === 409) {
      handleStalePromptConflict(e);
      await loadActiveBase();
    } else {
      showSnackbar(errorMsg, 'error');
    }
  } finally {
    applyingIndex.value = null;
  }
}

async function applyAllDiffs(opts: { activate?: boolean; openSandbox?: boolean } = {}) {
  const pending = currentDiffs.value
    .map((d, i) => ({ d, i }))
    .filter(({ i }) => !appliedResults.value.has(i));
  if (pending.length === 0 || batchApplying.value) return;

  batchApplying.value = true;
  try {
    const publishIds = savedLibraryCards.value
      .filter((c) => !c.published)
      .map((c) => c.id);
    const { data } = await api.post('/meta-agent/apply-batch', {
      diffs: pending.map(({ d }) => ({
        before: d.before,
        after: d.after,
        summary: d.summary,
      })),
      activate: opts.activate === true,
      basePromptId: activeBasePromptId.value,
      ...(opts.activate && publishIds.length > 0 ? { publishLibraryIds: publishIds } : {}),
    });

    const next = new Map(appliedResults.value);
    for (const { i } of pending) {
      next.set(i, {
        promptId: data.id,
        version: data.version,
        activated: data.isActive === true,
      });
    }
    appliedResults.value = next;

    if (data.isActive) {
      activeBasePromptId.value = data.id;
      activeBaseVersion.value = data.version;
    }

    if (Array.isArray(data.publishedLibrary) && data.publishedLibrary.length > 0) {
      const publishedIds = new Set(data.publishedLibrary.map((c: { id: string }) => c.id));
      savedLibraryCards.value = savedLibraryCards.value.map((c) =>
        publishedIds.has(c.id) ? { ...c, published: true } : c,
      );
    }

    if (opts.activate) {
      showSnackbar(`v${data.version} активовано (${pending.length} змін)`, 'success', true);
    } else {
      showSnackbar(`Чернетку v${data.version} створено (${pending.length} змін)`);
    }

    if (opts.openSandbox) {
      showSnackbar(
        'Далі тестуєш відповіді клієнтському агенту в пісочниці (не мета-агенту)',
        'info',
      );
      await router.push({ name: 'sandbox', query: { promptVersion: String(data.version) } });
    }
  } catch (e: any) {
    const status = e.response?.status;
    const errorMsg = e.response?.data?.error || 'Не вдалося зберегти batch';
    if (status === 409) {
      handleStalePromptConflict(e);
      await loadActiveBase();
    } else {
      showSnackbar(errorMsg, 'error');
    }
  } finally {
    batchApplying.value = false;
  }
}

async function saveAndOpenSandbox() {
  await applyAllDiffs({ activate: false, openSandbox: true });
}

function openActivateConfirm(idx: number) {
  confirmActivate.value = { diffIdx: idx };
}

function openBatchActivateConfirm() {
  if (unappliedDiffs.value.length === 0) return;
  confirmActivate.value = 'batch';
}

async function confirmActivateNow() {
  if (!confirmActivate.value) return;
  const target = confirmActivate.value;
  confirmActivate.value = null;

  if (target === 'batch') {
    await applyAllDiffs({ activate: true });
    return;
  }

  const idx = target.diffIdx;
  const existing = appliedResults.value.get(idx);
  if (existing && !existing.activated) {
    await activateExistingDraft(existing.promptId);
    return;
  }

  if (unappliedDiffs.value.length > 1) {
    await applyAllDiffs({ activate: true });
    return;
  }

  await applyDiffAt(idx, { activate: true });
}

async function activateExistingDraft(promptId: string) {
  if (activatingPromptId.value) return;
  activatingPromptId.value = promptId;
  try {
    const { data } = await api.post(`/prompts/${promptId}/activate`);
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
    else if (data?.version != null) activeBaseVersion.value = data.version;
    const version = data?.version != null ? `v${data.version}` : 'Версію';
    showSnackbar(`${version} активовано`, 'success', true);
  } catch (e: any) {
    showSnackbar(e.response?.data?.error || 'Не вдалося активувати', 'error');
  } finally {
    activatingPromptId.value = null;
  }
}

async function publishLibraryCard(card: LibraryCardHint) {
  if (card.published || publishingLibraryId.value) return;
  publishingLibraryId.value = card.id;
  try {
    const { data } = await api.post('/meta-agent/publish-library', {
      publishLibraryIds: [card.id],
    });
    const published = Array.isArray(data?.publishedLibrary) ? data.publishedLibrary : [];
    if (published.some((c: { id: string }) => c.id === card.id)) {
      savedLibraryCards.value = savedLibraryCards.value.map((c) =>
        c.id === card.id ? { ...c, published: true } : c,
      );
      showSnackbar(`Картку «${card.slug}» опубліковано`);
    } else {
      showSnackbar('Картку не знайдено або вже активна', 'warning');
    }
  } catch (e: any) {
    showSnackbar(e.response?.data?.error || 'Не вдалося опублікувати', 'error');
  } finally {
    publishingLibraryId.value = null;
  }
}

function rejectDiff() {
  currentDiffs.value = [];
  appliedResults.value = new Map();
  diffSheetOpen.value = false;
}

function onMobileRejectDiff() {
  rejectDiff();
}

onMounted(async () => {
  const qId = route.query.conversationId;
  if (typeof qId === 'string' && qId.trim()) {
    linkedConversationId.value = qId.trim();
  }
  await Promise.all([loadSession(), loadActiveBase()]);
});

onBeforeUnmount(() => {
  abortController?.abort();
});
</script>

<style scoped>
.diff-panel {
  flex: 1 1 45%;
  min-width: 0;
}

.diff-sheet-card {
  border-radius: 16px 16px 0 0;
  overflow: hidden;
}

.min-width-0 {
  min-width: 0;
}

.teach-composer-sticky {
  flex-shrink: 0;
  padding-bottom: max(8px, env(safe-area-inset-bottom));
  background: rgb(var(--v-theme-surface));
}

.teach-result-cards .v-card {
  border-color: rgba(0, 0, 0, 0.08);
}

.teach-stream-toast {
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(var(--v-theme-error), 0.08);
}

.typing-dots {
  display: flex;
  gap: 5px;
  align-items: center;
  padding: 2px 4px;
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
</style>
