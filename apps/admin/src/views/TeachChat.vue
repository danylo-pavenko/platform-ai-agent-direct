<template>
  <v-container
    fluid
    class="agent-page-shell pa-2 pa-md-4"
  >
    <!-- Header -->
    <div class="agent-page-header-compact d-flex align-center ga-2 mb-2 mb-md-3 px-1 flex-shrink-0">
      <div class="flex-grow-1 min-width-0">
        <div class="page-title" style="font-size: 18px;">Навчання агента</div>
        <div class="page-subtitle d-none d-sm-block">Опишіть зміни - мета-агент запропонує правки до промпту</div>
        <div v-if="mobile" class="page-subtitle-mobile d-sm-none">
          Опишіть зміни — агент запропонує правки
        </div>
      </div>
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

    <!-- Session info -->
    <div v-if="sessionLoaded" class="px-1 mb-2 flex-shrink-0">
      <div class="d-flex align-center ga-2 flex-wrap text-caption text-grey">
        <v-chip size="x-small" variant="tonal" color="primary">
          {{ sessionTitle || 'Поточна сесія' }}
        </v-chip>
        <span>{{ exchangeCount }}/{{ contextLimit }} запитів</span>
        <span v-if="messageCount > 0" class="text-grey-lighten-1">· {{ messageCount }} повід.</span>
      </div>
      <v-alert
        v-if="contextNearFull && !contextFull"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-2 text-body-2"
      >
        Контекст сесії майже заповнений. Рекомендуємо
        <a href="#" class="text-warning" @click.prevent="newSessionDialogOpen = true">почати нову сесію</a>.
      </v-alert>
      <v-alert
        v-if="contextFull"
        type="error"
        variant="tonal"
        density="compact"
        class="mt-2 text-body-2"
      >
        Досягнуто ліміт {{ contextLimit }} запитів у сесії. Почніть нову сесію, щоб продовжити.
      </v-alert>
    </div>

    <!-- Main content -->
    <div class="flex-grow-1 d-flex flex-column flex-md-row ga-2 ga-md-3" style="min-height: 0; overflow: hidden;">
      <!-- Chat panel -->
      <v-card
        class="d-flex flex-column flex-grow-1"
        flat
        style="min-height: 0;"
      >
        <!-- Messages -->
        <div
          ref="messagesContainer"
          class="flex-grow-1 overflow-y-auto pa-3 pa-md-4"
          style="min-height: 0;"
        >
          <div v-if="sessionLoading" class="d-flex justify-center align-center pa-6" style="height: 100%;">
            <v-progress-circular indeterminate color="primary" size="32" />
          </div>

          <!-- Empty state -->
          <div
            v-else-if="messages.length === 0 && !loading"
            class="d-flex flex-column align-center justify-center text-center"
            style="height: 100%;"
          >
            <v-icon size="48" color="grey-lighten-1" class="mb-3">mdi-chat-outline</v-icon>
            <div class="text-body-1 text-grey-darken-1 mb-1">Почніть розмову</div>
            <div class="text-body-2 text-grey px-4" style="max-width: 360px;">
              Наприклад: «Додай правило про безкоштовну доставку від 2000 грн»
            </div>
            <v-chip
              v-if="mobile"
              class="hint-chip-touch mt-3"
              size="small"
              variant="outlined"
              @click="inputText = 'Додай правило про безкоштовну доставку від 2000 грн'"
            >
              Спробувати приклад
            </v-chip>
          </div>

          <!-- Messages -->
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

          <!-- Typing indicator -->
          <div v-if="loading" class="mb-3 d-flex justify-start">
            <div :style="{ maxWidth: mobile ? '92%' : '75%' }">
              <div class="text-caption text-grey mb-1">Мета-агент</div>
              <v-card color="grey-lighten-4" variant="flat" rounded="lg" class="pa-3">
                <div class="typing-dots">
                  <span /><span /><span />
                </div>
              </v-card>
            </div>
          </div>
        </div>

        <!-- Input -->
        <v-divider />
        <div class="agent-chat-input pa-2 pa-md-3">
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
              :disabled="loading || contextFull || sessionLoading"
              @keydown.enter.exact.prevent="sendMessage"
              @keydown.shift.enter.stop
            />
            <v-btn
              color="primary"
              icon="mdi-send"
              class="agent-send-btn"
              :loading="loading"
              :disabled="!inputText.trim() || contextFull || sessionLoading"
              aria-label="Надіслати"
              @click="sendMessage"
            />
          </div>
          <div v-if="!mobile" class="text-caption text-grey mt-1 d-none d-md-block">
            Enter — надіслати, Shift+Enter — новий рядок
          </div>
        </div>
      </v-card>

      <!-- Desktop: inline diff panel -->
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
          show-title
          @apply="applyDiffAt"
          @activate-confirm="openActivateConfirm"
          @reject="rejectDiff"
          @apply-all="applyAllDiffs"
        />
      </v-card>
    </div>

    <!-- Mobile: reopen diff chip when sheet closed -->
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

    <!-- Mobile: diff bottom sheet -->
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
          sheet
          stack-actions
          show-title
          @apply="applyDiffAt"
          @activate-confirm="openActivateConfirm"
          @reject="onMobileRejectDiff"
          @apply-all="applyAllDiffs"
          @close="diffSheetOpen = false"
        />
      </v-card>
    </v-bottom-sheet>

    <!-- New session confirmation -->
    <v-dialog v-model="newSessionDialogOpen" max-width="440" class="dialog-actions-stack">
      <v-card>
        <v-card-title class="text-subtitle-1">Почати нову сесію?</v-card-title>
        <v-card-text class="text-body-2">
          Поточна сесія буде збережена в історії. Ви почнете з чистого контексту — це рекомендовано,
          коли діалог стає довгим і мета-агенту важче враховувати всі попередні повідомлення.
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

    <!-- Context full — must start new session -->
    <v-dialog v-model="contextFullDialogOpen" max-width="440" persistent class="dialog-actions-stack">
      <v-card>
        <v-card-title class="text-subtitle-1">Контекст сесії заповнений</v-card-title>
        <v-card-text class="text-body-2">
          У цій сесії вже {{ contextLimit }} запитів до мета-агента. Щоб продовжити навчання,
          почніть нову сесію — попередня залишиться збереженою в базі.
        </v-card-text>
        <v-card-actions class="dialog-actions-stack">
          <v-btn color="primary" variant="flat" :loading="startingNewSession" @click="confirmNewSession">
            Почати нову сесію
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Activate confirmation -->
    <v-dialog v-model="activateDialogOpen" max-width="480" persistent class="dialog-actions-stack">
      <v-card>
        <v-card-title class="text-subtitle-1">
          Активувати зміну одразу?
        </v-card-title>
        <v-card-text class="text-body-2">
          Активна версія промпту буде змінена миттєво — бот почне використовувати новий текст з наступного повідомлення клієнта.
          Попередня активна версія залишиться в історії як неактивна, її можна буде повернути.
        </v-card-text>
        <v-card-actions class="dialog-actions-stack">
          <v-spacer class="d-none d-sm-flex" />
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

    <v-snackbar
      v-model="snackbar"
      :color="snackbarColor"
      :timeout="3000"
      location="bottom"
      :style="{ marginBottom: mobile ? 'env(safe-area-inset-bottom)' : undefined }"
    >
      {{ snackbarText }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, watch } from 'vue';
import { useDisplay } from 'vuetify';
import api from '@/api';
import { formatMetaAgentMarkdown } from '@/lib/metaAgentMarkdown';
import MetaAgentDiffPanel from '@/components/MetaAgentDiffPanel.vue';

const { mobile } = useDisplay();

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
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

interface AppliedResult {
  promptId: string;
  version: number;
  activated: boolean;
}

const messages = ref<ChatMessage[]>([]);
const sessionId = ref<string | null>(null);
const sessionTitle = ref<string | null>(null);
const messageCount = ref(0);
const exchangeCount = ref(0);
const contextLimit = ref(15);
const contextNearFull = ref(false);
const contextFull = ref(false);
const sessionLoaded = ref(false);
const sessionLoading = ref(true);
const startingNewSession = ref(false);
const inputText = ref('');
const loading = ref(false);
const currentDiffs = ref<SuggestedDiff[]>([]);
const appliedResults = ref<Map<number, AppliedResult>>(new Map());
const applyingIndex = ref<number | null>(null);
const activatingPromptId = ref<string | null>(null);
const messagesContainer = ref<HTMLElement | null>(null);
const diffSheetOpen = ref(false);

const activeBasePromptId = ref<string | null>(null);
const activeBaseVersion = ref<number | null>(null);

const confirmActivate = ref<{ diffIdx: number } | null>(null);
const newSessionDialogOpen = ref(false);
const contextFullDialogOpen = ref(false);

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

watch(currentDiffs, (diffs) => {
  if (mobile.value && diffs.length > 0) {
    diffSheetOpen.value = true;
  }
});

watch(mobile, (isMobile) => {
  if (!isMobile) diffSheetOpen.value = false;
});

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

function applySessionState(session: TeachSessionState) {
  sessionId.value = session.id;
  sessionTitle.value = session.title;
  messageCount.value = session.messageCount;
  exchangeCount.value = session.exchangeCount;
  contextLimit.value = session.contextLimit;
  contextNearFull.value = session.contextNearFull;
  contextFull.value = session.contextFull;
  messages.value = session.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

async function loadSession() {
  sessionLoading.value = true;
  try {
    const { data } = await api.get('/meta-agent/teach/session');
    applySessionState(data.session);
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
    appliedResults.value = new Map();
    inputText.value = '';
    diffSheetOpen.value = false;
    newSessionDialogOpen.value = false;
    contextFullDialogOpen.value = false;
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

async function sendMessage() {
  const text = inputText.value.trim();
  if (!text || loading.value || sessionLoading.value) return;

  if (contextFull.value) {
    contextFullDialogOpen.value = true;
    return;
  }

  const optimisticUser: ChatMessage = { role: 'user', content: text };
  messages.value.push(optimisticUser);
  inputText.value = '';
  loading.value = true;
  currentDiffs.value = [];
  appliedResults.value = new Map();
  diffSheetOpen.value = false;
  await scrollToBottom();

  await loadActiveBase();

  try {
    const { data } = await api.post('/meta-agent/teach/chat', {
      message: text,
    });

    if (data.session) {
      applySessionState(data.session);
    } else {
      messages.value.push({ role: 'assistant', content: data.reply });
    }

    if (data.suggestedDiffs && data.suggestedDiffs.length > 0) {
      currentDiffs.value = data.suggestedDiffs;
    } else if (data.suggestedDiff) {
      currentDiffs.value = [data.suggestedDiff];
    }
  } catch (e: any) {
    const status = e.response?.status;
    const code = e.response?.data?.code;
    if (status === 409 && code === 'CONTEXT_FULL') {
      messages.value = messages.value.filter((m) => m !== optimisticUser);
      contextFull.value = true;
      contextFullDialogOpen.value = true;
      showSnackbar('Контекст сесії заповнений — почніть нову сесію', 'warning');
    } else {
      await loadSession();
      const errorMsg = e.response?.data?.error || 'Помилка зв\'язку з мета-агентом';
      showSnackbar(errorMsg, 'error');
    }
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
      const newActive = e.response?.data?.currentActiveVersion;
      currentDiffs.value = [];
      appliedResults.value = new Map();
      diffSheetOpen.value = false;
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
  diffSheetOpen.value = false;
}

function onMobileRejectDiff() {
  rejectDiff();
}

onMounted(async () => {
  await Promise.all([loadSession(), loadActiveBase()]);
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
