<template>
  <v-container fluid class="agent-page-shell insights-page pa-2 pa-md-4">
    <header class="insights-header px-1 mb-2 mb-md-3">
      <div class="insights-header-row d-flex align-center ga-3">
        <div class="flex-grow-1 min-width-0">
          <h1 class="page-title">AI-помічник</h1>
          <div class="page-subtitle d-none d-sm-block">
            Запитайте про бізнес, клієнтів, CRM, інтеграції та роботу AI-агента
          </div>
        </div>
        <div class="insights-header-actions d-flex align-center ga-2">
          <v-btn-toggle
            v-model="period"
            mandatory
            density="compact"
            variant="outlined"
            divided
            :disabled="loading"
            aria-label="Період аналітики"
          >
            <v-btn v-for="option in periodOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </v-btn>
          </v-btn-toggle>
          <v-btn
            icon="mdi-delete-outline"
            variant="text"
            size="small"
            :disabled="messages.length === 0 || loading"
            aria-label="Очистити чат"
            title="Очистити чат"
            @click="clearChat"
          />
        </div>
      </div>

      <div v-if="snapshot" class="insights-summary mt-2" aria-label="Коротка статистика">
        <span>
          <strong>{{ snapshot.conversations.active }}</strong>
          {{ period === 'all' ? 'діалогів' : 'діалогів за період' }}
          <template v-if="period !== 'all' && snapshot.totalsAllTime">
            <span class="text-medium-emphasis"> / {{ snapshot.totalsAllTime.conversations }} усього</span>
          </template>
        </span>
        <span>
          <strong>{{ snapshot.messages.total }}</strong>
          {{ period === 'all' ? 'повідомлень' : 'повідомлень за період' }}
          <template v-if="period !== 'all' && snapshot.totalsAllTime">
            <span class="text-medium-emphasis"> / {{ snapshot.totalsAllTime.messages }} усього</span>
          </template>
        </span>
        <span>
          <strong>{{ snapshot.clients.active }}</strong>
          {{ period === 'all' ? 'клієнтів' : 'активних клієнтів' }}
          <template v-if="period !== 'all'">
            <span class="text-medium-emphasis"> / {{ snapshot.clients.total ?? snapshot.totalsAllTime?.clients ?? 0 }} усього</span>
          </template>
        </span>
        <span v-if="topIntent">
          Топ тема: <strong>{{ intentLabel(topIntent.intent) }}</strong>
        </span>
        <span>
          CRM:
          <strong :class="snapshot.crm.writeReady ? 'text-success' : 'text-warning'">
            {{ snapshot.crm.writeReady ? 'готова до запису' : 'потребує уваги' }}
          </strong>
        </span>
        <span>Оновлено {{ formattedSnapshotTime }}</span>
      </div>
      <v-alert
        v-if="snapshot && period !== 'all' && snapshot.conversations.active === 0 && (snapshot.totalsAllTime?.conversations ?? 0) > 0"
        type="info"
        variant="tonal"
        density="compact"
        class="mt-2"
      >
        За вибраний період активних діалогів немає, але в базі є
        <strong>{{ snapshot.totalsAllTime?.conversations ?? 0 }}</strong>.
        Спробуйте «30 днів», «90 днів» або «Весь час» — або запитайте помічника про всі діалоги.
      </v-alert>
      <div v-else-if="!snapshot && snapshotLoading" class="insights-summary mt-2 text-medium-emphasis">
        Оновлюємо статистику…
      </div>
    </header>

    <section class="insights-chat flex-grow-1 d-flex flex-column">
      <div
        ref="messagesContainer"
        class="insights-messages flex-grow-1 overflow-y-auto pa-3 pa-md-5"
        aria-live="polite"
        @click="handleMessageLink"
      >
        <div
          v-if="messages.length === 0 && !loading"
          class="insights-empty d-flex flex-column justify-center"
        >
          <div class="insights-orbit mb-4" aria-hidden="true">
            <v-icon size="28">mdi-chart-timeline-variant-shimmer</v-icon>
          </div>
          <h2>Що хочете дізнатися про свій бізнес?</h2>
          <p>
            Помічник поєднує показники, клієнтські діалоги, CRM-статус і поточні
            налаштування, щоб дати конкретну відповідь та наступні кроки.
          </p>
          <div class="insights-suggestions mt-5" aria-label="Приклади запитів">
            <button
              v-for="suggestion in suggestions"
              :key="suggestion.title"
              type="button"
              @click="useSuggestion(suggestion.prompt)"
            >
              <span class="d-flex align-center ga-3">
                <v-icon :icon="suggestion.icon" size="19" />
                <span>
                  <span class="insights-suggestion-title">{{ suggestion.title }}</span>
                  <span class="insights-suggestion-copy">{{ suggestion.copy }}</span>
                </span>
              </span>
              <v-icon size="16">mdi-arrow-up-right</v-icon>
            </button>
          </div>
        </div>

        <div
          v-for="(message, index) in messages"
          :key="`${message.role}-${index}`"
          class="insights-message"
          :class="`insights-message--${message.role}`"
        >
          <div class="insights-message-label">
            {{ message.role === 'user' ? 'Ви' : 'AI-помічник' }}
          </div>
          <div class="insights-bubble">
            <div
              class="meta-agent-md"
              :class="{ 'meta-agent-md--on-primary': message.role === 'user' }"
              v-html="formatMetaAgentMarkdown(message.content)"
            />
          </div>
          <button
            v-if="message.role === 'assistant'"
            type="button"
            class="insights-copy-action"
            :aria-label="copiedIndex === index ? 'Відповідь скопійовано' : 'Скопіювати відповідь'"
            @click="copyMessage(message.content, index)"
          >
            <v-icon size="14">
              {{ copiedIndex === index ? 'mdi-check' : 'mdi-content-copy' }}
            </v-icon>
            {{ copiedIndex === index ? 'Скопійовано' : 'Копіювати' }}
          </button>
        </div>

        <div v-if="loading" class="insights-message insights-message--assistant">
          <div class="insights-message-label">AI-помічник</div>
          <div class="insights-bubble insights-typing" aria-label="AI-помічник формує відповідь">
            <span /><span /><span />
          </div>
        </div>
      </div>

      <v-alert
        v-if="error"
        type="error"
        variant="tonal"
        density="compact"
        closable
        class="insights-error ma-2 mb-0"
        @click:close="error = ''"
      >
        {{ error }}
      </v-alert>

      <div v-if="messages.length > 0 && !loading" class="insights-followups">
        <span>Можна запитати далі:</span>
        <button
          v-for="followUp in followUps"
          :key="followUp"
          type="button"
          @click="useSuggestion(followUp)"
        >
          {{ followUp }}
        </button>
      </div>

      <div class="agent-chat-input insights-input pa-2 pa-md-3">
        <div class="d-flex ga-2 align-end">
          <v-textarea
            v-model="inputText"
            placeholder="Наприклад: що зараз варто покращити в бізнесі?"
            rows="1"
            max-rows="4"
            auto-grow
            hide-details
            aria-label="Запит до AI-помічника"
            :disabled="loading"
            @keydown.enter.exact.prevent="sendMessage"
            @keydown.shift.enter.stop
          />
          <v-btn
            color="primary"
            icon="mdi-arrow-up"
            class="agent-send-btn"
            :loading="loading"
            :disabled="!inputText.trim() || loading"
            aria-label="Надіслати"
            @click="sendMessage"
          />
        </div>
        <div class="insights-input-note">
          Цифри в шапці — за вибраний період; «усього» — вся база.
          Діалог активний, якщо була активність у періоді. Контакти клієнтів маскуються.
          <span v-if="historyTrimmed">
            Для нової відповіді враховуються останні 19 повідомлень.
          </span>
        </div>
      </div>
    </section>
  </v-container>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import api from '@/api';
import { formatMetaAgentMarkdown } from '@/lib/metaAgentMarkdown';

type Period = '7d' | '30d' | '90d' | 'all';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface InsightsSnapshot {
  generatedAt: string;
  period: Period;
  periodLabel?: string;
  messages: { total: number; botReplies?: number; managerReplies?: number };
  conversations: {
    active: number;
    byIntent: Array<{ intent: string; count: number }>;
  };
  clients: { active: number; total: number };
  totalsAllTime?: {
    conversations: number;
    messages: number;
    botReplies: number;
    managerReplies: number;
    clients: number;
  };
  configuration: {
    agent: { mode: string };
  };
  crm: {
    writeReady: boolean;
    writeIssue: string | null;
    latestSync: {
      status: string;
      finishedAt: string | null;
    } | null;
  };
}

const CHAT_STORAGE_PREFIX = 'tenant_insights_chat_';
const router = useRouter();
const period = ref<Period>('30d');
const snapshot = ref<InsightsSnapshot | null>(null);
const snapshotLoading = ref(false);
const messages = ref<ChatMessage[]>([]);
const inputText = ref('');
const loading = ref(false);
const error = ref('');
const messagesContainer = ref<HTMLElement | null>(null);
const copiedIndex = ref<number | null>(null);
let snapshotRequestId = 0;

const periodOptions: Array<{ value: Period; label: string }> = [
  { value: '7d', label: '7 днів' },
  { value: '30d', label: '30 днів' },
  { value: '90d', label: '90 днів' },
  { value: 'all', label: 'Весь час' },
];

const suggestions = [
  {
    icon: 'mdi-chart-box-outline',
    title: 'Огляд бізнесу',
    copy: 'Показники за період і за весь час',
    prompt:
      'Зроби короткий огляд бізнесу за вибраний період і за весь час: діалоги, повідомлення бота vs менеджера, клієнти. Дай 3 пріоритетні дії.',
  },
  {
    icon: 'mdi-forum-outline',
    title: 'Скільки діалогів?',
    copy: 'За період і загалом у базі',
    prompt:
      'Скільки в мене діалогів і повідомлень за вибраний період і загалом? Скільки відповів бот, а скільки менеджер?',
  },
  {
    icon: 'mdi-account-group-outline',
    title: 'Клієнти та попит',
    copy: 'Хто пише і про що запитує',
    prompt: 'Які клієнти та теми звернень зараз найважливіші? Покажи посилання на діалоги.',
  },
  {
    icon: 'mdi-database-sync-outline',
    title: 'CRM та інтеграції',
    copy: 'Готовність запису і проблемні місця',
    prompt: 'Перевір стан CRM та інтеграцій. Що працює, що потребує уваги і що робити далі?',
  },
];

const followUps = [
  'Який найбільший ризик?',
  'Покажи діалоги для перевірки',
  'Дай план дій на тиждень',
];

const intentLabels: Record<string, string> = {
  new_lead: 'нові ліди',
  service_question: 'питання про послуги',
  product_question: 'питання про товари',
  order: 'замовлення',
  complaint: 'скарги',
  partnership: 'співпраця',
  jobs: 'вакансії',
  spam: 'спам',
  unclassified: 'не класифіковано',
  other: 'інше',
};

const topIntent = computed(() => snapshot.value?.conversations.byIntent[0] ?? null);
const historyTrimmed = computed(() => messages.value.length > 19);
const formattedSnapshotTime = computed(() => {
  if (!snapshot.value?.generatedAt) return '—';
  return new Intl.DateTimeFormat('uk-UA', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(snapshot.value.generatedAt));
});

function intentLabel(intent: string): string {
  return intentLabels[intent] ?? intent.replaceAll('_', ' ');
}

async function scrollToBottom() {
  await nextTick();
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }
}

async function loadSnapshot() {
  const requestId = ++snapshotRequestId;
  snapshotLoading.value = true;
  error.value = '';
  try {
    const { data } = await api.get<InsightsSnapshot>('/insights/snapshot', {
      params: { period: period.value },
    });
    if (requestId === snapshotRequestId) snapshot.value = data;
  } catch (requestError: any) {
    if (requestId === snapshotRequestId) {
      error.value =
        requestError.response?.data?.error ?? 'Не вдалося завантажити аналітику';
    }
  } finally {
    if (requestId === snapshotRequestId) snapshotLoading.value = false;
  }
}

function clearChat() {
  messages.value = [];
  inputText.value = '';
  error.value = '';
  sessionStorage.removeItem(`${CHAT_STORAGE_PREFIX}${period.value}`);
}

function useSuggestion(suggestion: string) {
  inputText.value = suggestion;
  void sendMessage();
}

async function copyMessage(content: string, index: number) {
  try {
    await navigator.clipboard.writeText(content);
    copiedIndex.value = index;
    window.setTimeout(() => {
      if (copiedIndex.value === index) copiedIndex.value = null;
    }, 1_800);
  } catch {
    error.value = 'Не вдалося скопіювати відповідь';
  }
}

function loadStoredChat() {
  const raw = sessionStorage.getItem(`${CHAT_STORAGE_PREFIX}${period.value}`);
  if (!raw) {
    messages.value = [];
    return;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Invalid chat history');
    messages.value = parsed
      .filter(
        (item): item is ChatMessage =>
          item !== null &&
          typeof item === 'object' &&
          ((item as ChatMessage).role === 'user' ||
            (item as ChatMessage).role === 'assistant') &&
          typeof (item as ChatMessage).content === 'string',
      )
      .slice(-40);
  } catch {
    sessionStorage.removeItem(`${CHAT_STORAGE_PREFIX}${period.value}`);
    messages.value = [];
  }
}

async function sendMessage() {
  const text = inputText.value.trim();
  if (!text || loading.value) return;

  messages.value.push({ role: 'user', content: text });
  inputText.value = '';
  loading.value = true;
  error.value = '';
  await scrollToBottom();

  try {
    // Keep complete user/assistant pairs and finish with the current user turn.
    // An odd tail avoids beginning Claude history with an orphan assistant reply.
    const requestMessages = messages.value.slice(-19);
    const { data } = await api.post<{ reply: string; snapshotAt: string }>(
      '/insights/chat',
      {
        period: period.value,
        messages: requestMessages,
      },
    );
    messages.value.push({ role: 'assistant', content: data.reply });
    messages.value = messages.value.slice(-40);
    if (snapshot.value) snapshot.value.generatedAt = data.snapshotAt;
  } catch (requestError: any) {
    messages.value.pop();
    inputText.value = text;
    error.value =
      requestError.response?.data?.error ?? 'AI-помічник зараз недоступний';
  } finally {
    loading.value = false;
    await scrollToBottom();
  }
}

function handleMessageLink(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest<HTMLAnchorElement>('a[href^="/"]');
  if (!anchor) return;
  event.preventDefault();
  void router.push(anchor.getAttribute('href') ?? '/dashboard');
}

watch(period, () => {
  error.value = '';
  copiedIndex.value = null;
  loadStoredChat();
  void loadSnapshot();
  void scrollToBottom();
});

watch(messages, (nextMessages) => {
  if (nextMessages.length === 0) return;
  sessionStorage.setItem(
    `${CHAT_STORAGE_PREFIX}${period.value}`,
    JSON.stringify(nextMessages.slice(-40)),
  );
}, {
  deep: true,
});

onMounted(() => {
  loadStoredChat();
  void loadSnapshot();
  void scrollToBottom();
});
</script>

<style scoped>
.insights-page {
  --insights-ink: #0a2540;
  --insights-muted: #62748a;
  --insights-line: #dbe4ee;
  --insights-accent: #087f6b;
}

.min-width-0 {
  min-width: 0;
}

.page-title {
  margin: 0;
}

.insights-header {
  flex-shrink: 0;
}

.insights-header-actions {
  flex-shrink: 0;
}

.insights-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  color: var(--insights-muted);
  font-size: 0.78rem;
}

.insights-summary span + span {
  position: relative;
}

.insights-summary span + span::before {
  content: '';
  position: absolute;
  left: -10px;
  top: 50%;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: #9aabbd;
}

.insights-summary strong {
  color: var(--insights-ink);
  font-weight: 650;
}

.insights-chat {
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--insights-line);
  border-radius: 18px;
  background:
    radial-gradient(circle at 12% 4%, rgba(0, 212, 170, 0.075), transparent 27%),
    linear-gradient(180deg, #fbfdff 0%, #f7fafc 100%);
}

.insights-messages {
  min-height: 0;
  scroll-behavior: smooth;
}

.insights-empty {
  width: min(680px, 100%);
  min-height: 100%;
  margin: 0 auto;
  color: var(--insights-ink);
  animation: insights-rise 420ms ease-out both;
}

.insights-empty h2 {
  max-width: 560px;
  margin: 0;
  font-family: 'Avenir Next', 'Trebuchet MS', sans-serif;
  font-size: clamp(1.75rem, 4vw, 2.6rem);
  font-weight: 650;
  letter-spacing: -0.035em;
  line-height: 1.08;
}

.insights-empty p {
  max-width: 560px;
  margin: 12px 0 0;
  color: var(--insights-muted);
  line-height: 1.6;
}

.insights-orbit {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  color: var(--insights-accent);
  border: 1px solid rgba(8, 127, 107, 0.22);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.72);
  animation: insights-breathe 3s ease-in-out infinite;
}

.insights-suggestions {
  display: grid;
  width: min(560px, 100%);
  border-top: 1px solid var(--insights-line);
}

.insights-suggestions button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 12px 2px;
  color: var(--insights-ink);
  text-align: left;
  border: 0;
  border-bottom: 1px solid var(--insights-line);
  background: transparent;
  cursor: pointer;
  transition: color 160ms ease, padding 160ms ease;
}

.insights-suggestions button:hover {
  padding-left: 7px;
  color: var(--insights-accent);
}

.insights-suggestion-title,
.insights-suggestion-copy {
  display: block;
}

.insights-suggestion-title {
  font-size: 0.87rem;
  font-weight: 620;
}

.insights-suggestion-copy {
  margin-top: 2px;
  color: var(--insights-muted);
  font-size: 0.74rem;
  line-height: 1.35;
}

.insights-message {
  width: min(780px, 100%);
  margin: 0 auto 18px;
  animation: insights-rise 260ms ease-out both;
}

.insights-message--user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.insights-message-label {
  margin-bottom: 5px;
  color: var(--insights-muted);
  font-size: 0.72rem;
}

.insights-bubble {
  width: fit-content;
  max-width: min(680px, 88%);
  padding: 12px 15px;
  color: var(--insights-ink);
  border: 1px solid var(--insights-line);
  border-radius: 16px 16px 16px 5px;
  background: rgba(255, 255, 255, 0.9);
}

.insights-message--user .insights-bubble {
  color: white;
  border-color: rgb(var(--v-theme-primary));
  border-radius: 16px 16px 5px 16px;
  background: rgb(var(--v-theme-primary));
}

.insights-copy-action {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 5px;
  padding: 3px 2px;
  color: var(--insights-muted);
  font-size: 0.68rem;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.insights-copy-action:hover {
  color: var(--insights-accent);
}

.insights-followups {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  overflow-x: auto;
  color: var(--insights-muted);
  font-size: 0.7rem;
  border-top: 1px solid var(--insights-line);
  background: rgba(248, 251, 253, 0.96);
  scrollbar-width: none;
}

.insights-followups span,
.insights-followups button {
  flex: 0 0 auto;
}

.insights-followups button {
  padding: 5px 9px;
  color: var(--insights-ink);
  font-size: 0.72rem;
  border: 1px solid var(--insights-line);
  border-radius: 7px;
  background: white;
  cursor: pointer;
}

.insights-followups button:hover {
  color: var(--insights-accent);
  border-color: rgba(8, 127, 107, 0.35);
}

.insights-input {
  flex-shrink: 0;
  border-top: 1px solid var(--insights-line);
  background: rgba(255, 255, 255, 0.94);
  backdrop-filter: blur(12px);
}

.insights-input-note {
  margin-top: 6px;
  color: var(--insights-muted);
  font-size: 0.7rem;
}

.insights-input-note span {
  display: block;
  margin-top: 2px;
  color: #9a6b08;
}

.insights-error {
  flex-shrink: 0;
}

.insights-typing {
  display: flex;
  gap: 5px;
  padding-block: 16px;
}

.insights-typing span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--insights-accent);
  animation: insights-dot 1.2s infinite both;
}

.insights-typing span:nth-child(2) {
  animation-delay: 140ms;
}

.insights-typing span:nth-child(3) {
  animation-delay: 280ms;
}

@keyframes insights-rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes insights-breathe {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-3px); }
}

@keyframes insights-dot {
  0%, 70%, 100% { opacity: 0.3; transform: translateY(0); }
  35% { opacity: 1; transform: translateY(-3px); }
}

@media (max-width: 600px) {
  .insights-header-row {
    flex-wrap: wrap;
  }

  .insights-header-actions {
    width: 100%;
    justify-content: space-between;
  }

  .insights-header .v-btn-toggle .v-btn {
    min-width: 42px;
    padding-inline: 8px;
    font-size: 0.72rem;
  }

  .insights-empty {
    justify-content: flex-start !important;
    padding-top: 5vh;
  }

  .insights-empty h2 {
    font-size: 1.7rem;
  }

  .insights-bubble {
    max-width: 94%;
  }

  .insights-summary span:last-child {
    display: none;
  }

  .insights-followups {
    padding-inline: 8px;
  }

  .insights-input-note {
    line-height: 1.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .insights-empty,
  .insights-message,
  .insights-orbit,
  .insights-typing span {
    animation: none;
  }
}
</style>
