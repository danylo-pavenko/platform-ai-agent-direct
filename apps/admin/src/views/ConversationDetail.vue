<template>
  <v-container fluid class="detail-root pa-0">
    <!-- Mobile header -->
    <div class="detail-mobile-header d-flex align-center pa-2 ga-2" v-if="mobile">
      <v-btn icon variant="text" size="small" @click="router.push({ name: 'conversations' })">
        <v-icon>mdi-arrow-left</v-icon>
      </v-btn>
      <div class="flex-grow-1 text-truncate text-subtitle-2">
        {{ clientName }}
      </div>
      <v-chip v-if="conversation?.state" :color="stateColor(conversation.state)" size="x-small" label>
        {{ stateLabel(conversation.state) }}
      </v-chip>
      <v-btn icon variant="text" size="small" @click="showProfile = !showProfile">
        <v-icon>mdi-account-details</v-icon>
      </v-btn>
    </div>

    <div class="detail-layout" :class="{ 'with-profile': showProfile && !mobile }">
      <!-- Main: chat -->
      <div class="chat-col d-flex flex-column">
        <!-- Desktop header -->
        <div v-if="!mobile" class="chat-header d-flex align-center pa-3 ga-2">
          <v-btn icon variant="text" size="small" @click="router.push({ name: 'conversations' })">
            <v-icon>mdi-arrow-left</v-icon>
          </v-btn>
          <div class="flex-grow-1" style="min-width: 0;">
            <div class="text-subtitle-2 font-weight-bold text-truncate">{{ clientName }}</div>
            <div class="text-caption text-grey">
              {{ conversation?.channel?.toUpperCase() }} · #{{ conversation?.id?.substring(0, 8) }}
            </div>
          </div>
          <v-chip v-if="conversation?.state" :color="stateColor(conversation.state)" size="small" label>
            {{ stateLabel(conversation.state) }}
          </v-chip>
          <v-btn
            :icon="showProfile ? 'mdi-account-details' : 'mdi-account-details-outline'"
            variant="text"
            size="small"
            title="Профіль клієнта"
            @click="showProfile = !showProfile"
          />
        </div>

        <v-divider v-if="!mobile" />

        <!-- Messages -->
        <div
          v-if="loading"
          class="d-flex justify-center align-center flex-grow-1"
        >
          <v-progress-circular indeterminate color="primary" />
        </div>

        <div
          v-else
          ref="messagesContainer"
          class="messages-area flex-grow-1 overflow-y-auto pa-3 pa-md-4"
          style="min-height: 0;"
        >
          <div v-if="messages.length === 0" class="d-flex justify-center align-center" style="height: 100%;">
            <div class="text-body-2 text-grey">Повідомлень поки немає</div>
          </div>

          <div
            v-for="msg in messages"
            :key="msg.id"
            class="mb-3"
            :class="messageAlignment(msg)"
          >
            <div v-if="msg.sender === 'system'" class="text-center">
              <v-chip size="x-small" variant="outlined" class="font-italic">{{ msg.text }}</v-chip>
            </div>
            <div v-else :style="{ maxWidth: mobile ? '88%' : '72%' }">
              <div class="text-caption text-grey mb-1" :class="msg.direction === 'out' ? 'text-right' : ''">
                {{ senderIcon(msg) }} {{ senderLabel(msg) }} · {{ formatTime(msg.createdAt) }}
              </div>
              <v-card :color="bubbleColor(msg)" :variant="msg.direction === 'in' ? 'tonal' : 'flat'" rounded="lg" class="pa-3">
                <div
                  class="text-body-2"
                  :class="{ 'text-white': msg.direction === 'out' }"
                  style="word-break: break-word; line-height: 1.5;"
                >
                  {{ msg.text }}
                </div>
              </v-card>
            </div>
          </div>
        </div>

        <!-- Reply input -->
        <v-divider />
        <div class="pa-2 pa-md-3">
          <div class="d-flex ga-2 align-end">
            <v-textarea
              v-model="replyText"
              placeholder="Повідомлення від менеджера..."
              variant="outlined"
              density="compact"
              rows="1"
              max-rows="4"
              auto-grow
              hide-details
              :disabled="sending"
              @keydown.ctrl.enter="sendReply"
              @keydown.meta.enter="sendReply"
            />
            <v-btn
              color="green"
              icon="mdi-send"
              :loading="sending"
              :disabled="!replyText.trim()"
              size="small"
              @click="sendReply"
            />
          </div>
          <v-alert v-if="sendError" type="error" density="compact" class="mt-2 text-caption">
            {{ sendError }}
          </v-alert>
        </div>
      </div>

      <!-- Profile sidebar (desktop) / bottom sheet (mobile) -->
      <v-bottom-sheet v-if="mobile" v-model="showProfile" inset>
        <v-card class="pa-0">
          <client-profile-panel
            :client="conversation?.client"
            :conversation-id="props.id"
            @updated="onClientUpdated"
          />
        </v-card>
      </v-bottom-sheet>

      <div v-else-if="showProfile" class="profile-col">
        <client-profile-panel
          :client="conversation?.client"
          :conversation-id="props.id"
          @updated="onClientUpdated"
        />
      </div>
    </div>

    <v-snackbar v-model="snackbar" :color="snackbarColor" :timeout="3000">
      {{ snackbarText }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, defineComponent, h } from 'vue';
import { useRouter } from 'vue-router';
import { useDisplay } from 'vuetify';
import api from '@/api';

const { mobile } = useDisplay();
const router = useRouter();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  id: string;
  direction: 'in' | 'out' | 'system';
  sender: 'client' | 'bot' | 'manager' | 'system';
  text: string;
  createdAt: string;
}

interface ClientData {
  id: string;
  igUserId?: string;
  igUsername?: string;
  igFullName?: string;
  displayName?: string;
  phone?: string;
  email?: string;
  deliveryCity?: string;
  deliveryNpBranch?: string;
  deliveryNpType?: string;
  notes?: string;
  tags?: string[];
}

interface ConversationData {
  id: string;
  client: ClientData;
  channel: string;
  state: string;
  messages: Message[];
  orders?: Array<{ id: string; status: string; items: unknown[] }>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const props = defineProps<{ id: string }>();

const conversation = ref<ConversationData | null>(null);
const messages = ref<Message[]>([]);
const loading = ref(false);
const replyText = ref('');
const sending = ref(false);
const sendError = ref('');
const messagesContainer = ref<HTMLElement | null>(null);
const showProfile = ref(true);

const snackbar = ref(false);
const snackbarText = ref('');
const snackbarColor = ref('success');

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

const clientName = computed(() => {
  const c = conversation.value?.client;
  if (!c) return 'Клієнт';
  return c.displayName || c.igFullName || (c.igUsername ? `@${c.igUsername}` : null) || c.igUserId || 'Клієнт';
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function showSnack(text: string, color = 'success') {
  snackbarText.value = text;
  snackbarColor.value = color;
  snackbar.value = true;
}

function stateColor(state: string): string {
  return ({ bot: 'blue', handoff: 'orange', closed: 'grey', paused: 'purple' } as Record<string, string>)[state] || 'grey';
}

function stateLabel(state: string): string {
  return ({ bot: 'Бот', handoff: 'Менеджер', closed: 'Закрито', paused: 'Пауза' } as Record<string, string>)[state] || state;
}

function formatTime(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function messageAlignment(msg: Message): string {
  if (msg.sender === 'system') return 'd-flex justify-center';
  return msg.direction === 'in' ? 'd-flex justify-start' : 'd-flex justify-end';
}

function bubbleColor(msg: Message): string {
  if (msg.direction === 'in') return 'grey-lighten-3';
  if (msg.sender === 'manager') return 'green';
  return 'blue';
}

function senderIcon(msg: Message): string {
  return ({ client: '👤', bot: '🤖', manager: '💬', system: '⚙️' } as Record<string, string>)[msg.sender] || '';
}

function senderLabel(msg: Message): string {
  return ({ client: 'Клієнт', bot: 'Бот', manager: 'Менеджер', system: 'Система' } as Record<string, string>)[msg.sender] || msg.sender;
}

async function scrollToBottom() {
  await nextTick();
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchConversation() {
  loading.value = true;
  try {
    const { data } = await api.get(`/conversations/${props.id}`);
    conversation.value = data;
    messages.value = data.messages || [];
    await scrollToBottom();
  } catch {
    router.push({ name: 'conversations' });
  } finally {
    loading.value = false;
  }
}

async function sendReply() {
  if (!replyText.value.trim()) return;
  sending.value = true;
  sendError.value = '';
  try {
    const { data } = await api.post(`/conversations/${props.id}/reply`, {
      text: replyText.value.trim(),
    });
    messages.value.push(data);
    replyText.value = '';
    await scrollToBottom();
  } catch (e: any) {
    sendError.value = e.response?.data?.error || 'Помилка відправлення';
  } finally {
    sending.value = false;
  }
}

function onClientUpdated(updated: ClientData) {
  if (conversation.value) {
    conversation.value.client = { ...conversation.value.client, ...updated };
  }
  showSnack('Профіль оновлено');
}

onMounted(() => {
  fetchConversation();
});

// ---------------------------------------------------------------------------
// ClientProfilePanel (inline component)
// ---------------------------------------------------------------------------

const ClientProfilePanel = defineComponent({
  name: 'ClientProfilePanel',
  props: {
    client: { type: Object as () => ClientData | undefined, default: undefined },
    conversationId: { type: String, required: true },
  },
  emits: ['updated'],
  setup(props, { emit }) {
    const editing = ref(false);
    const saving = ref(false);
    const importing = ref(false);
    const newTag = ref('');

    const form = ref<Partial<ClientData>>({});

    function startEdit() {
      form.value = {
        displayName: props.client?.displayName ?? '',
        phone: props.client?.phone ?? '',
        email: props.client?.email ?? '',
        deliveryCity: props.client?.deliveryCity ?? '',
        deliveryNpBranch: props.client?.deliveryNpBranch ?? '',
        deliveryNpType: props.client?.deliveryNpType ?? '',
        notes: props.client?.notes ?? '',
        tags: [...(props.client?.tags ?? [])],
      };
      editing.value = true;
    }

    function cancelEdit() {
      editing.value = false;
      form.value = {};
      newTag.value = '';
    }

    function addTag() {
      const tag = newTag.value.trim().toLowerCase().replace(/\s+/g, '_');
      if (!tag) return;
      if (!Array.isArray(form.value.tags)) form.value.tags = [];
      if (!form.value.tags.includes(tag)) {
        form.value.tags.push(tag);
      }
      newTag.value = '';
    }

    function removeTag(tag: string) {
      if (Array.isArray(form.value.tags)) {
        form.value.tags = form.value.tags.filter((t) => t !== tag);
      }
    }

    async function saveProfile() {
      if (!props.client?.id) return;
      saving.value = true;
      try {
        const { data } = await api.put(`/conversations/clients/${props.client.id}`, form.value);
        emit('updated', data);
        editing.value = false;
        form.value = {};
      } catch (e: any) {
        alert(e.response?.data?.error || 'Помилка збереження');
      } finally {
        saving.value = false;
      }
    }

    async function importHistory() {
      if (!props.conversationId) return;
      importing.value = true;
      try {
        const { data } = await api.post(`/conversations/${props.conversationId}/import-ig-history`);
        alert(`Імпортовано: ${data.imported} повідомлень (пропущено: ${data.skipped})`);
        // Reload the page to show imported messages
        window.location.reload();
      } catch (e: any) {
        alert(e.response?.data?.error || 'Помилка імпорту');
      } finally {
        importing.value = false;
      }
    }

    return () => {
      const c = props.client;
      const displayTags = editing.value ? (form.value.tags ?? []) : (c?.tags ?? []);

      return h('div', { class: 'profile-panel d-flex flex-column', style: 'height: 100%; overflow-y: auto;' }, [
        // Header
        h('div', { class: 'pa-3 d-flex align-center ga-2' }, [
          h('div', { class: 'text-subtitle-2 flex-grow-1' }, 'Профіль клієнта'),
          !editing.value
            ? h('button', {
                class: 'profile-action-btn',
                title: 'Редагувати',
                onClick: startEdit,
                innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
              })
            : null,
        ]),
        h('hr', { class: 'v-divider' }),

        // IG identity
        h('div', { class: 'pa-3 pb-0' }, [
          c?.igUsername
            ? h('div', { class: 'd-flex align-center ga-2 mb-2' }, [
                h('span', { class: 'text-pink', style: 'font-size:16px;' }, '📷'),
                h('span', { class: 'text-body-2' }, `@${c.igUsername}`),
              ])
            : null,
          c?.igUserId
            ? h('div', { class: 'text-caption text-grey mb-2' }, `IGSID: ${c.igUserId}`)
            : null,
        ]),

        // Fields (view / edit)
        h('div', { class: 'pa-3 flex-grow-1' }, [
          // Name
          profileField('Імʼя', editing.value
            ? h('input', {
                class: 'profile-input',
                value: form.value.displayName,
                placeholder: 'Повне імʼя',
                onInput: (e: Event) => { form.value.displayName = (e.target as HTMLInputElement).value; },
              })
            : h('span', { class: 'text-body-2' }, c?.displayName || c?.igFullName || '—'),
          ),

          // Phone
          profileField('Телефон', editing.value
            ? h('input', {
                class: 'profile-input',
                value: form.value.phone,
                placeholder: '+380...',
                onInput: (e: Event) => { form.value.phone = (e.target as HTMLInputElement).value; },
              })
            : h('span', { class: 'text-body-2' }, c?.phone || '—'),
          ),

          // Email
          profileField('Email', editing.value
            ? h('input', {
                class: 'profile-input',
                value: form.value.email,
                placeholder: 'email@example.com',
                onInput: (e: Event) => { form.value.email = (e.target as HTMLInputElement).value; },
              })
            : h('span', { class: 'text-body-2' }, c?.email || '—'),
          ),

          // City
          profileField('Місто', editing.value
            ? h('input', {
                class: 'profile-input',
                value: form.value.deliveryCity,
                placeholder: 'Київ',
                onInput: (e: Event) => { form.value.deliveryCity = (e.target as HTMLInputElement).value; },
              })
            : h('span', { class: 'text-body-2' }, c?.deliveryCity || '—'),
          ),

          // NP branch
          profileField('Відділення НП', editing.value
            ? h('input', {
                class: 'profile-input',
                value: form.value.deliveryNpBranch,
                placeholder: '12 або адреса поштомату',
                onInput: (e: Event) => { form.value.deliveryNpBranch = (e.target as HTMLInputElement).value; },
              })
            : h('span', { class: 'text-body-2' }, c?.deliveryNpBranch
                ? `${c.deliveryNpType === 'postamat' ? 'Поштомат' : 'Відділення'} ${c.deliveryNpBranch}`
                : '—'),
          ),

          // Tags
          h('div', { class: 'profile-field mb-2' }, [
            h('div', { class: 'text-caption text-grey mb-1' }, 'Теги'),
            h('div', { class: 'd-flex flex-wrap ga-1' }, [
              ...displayTags.map((tag) =>
                h('div', {
                  key: tag,
                  class: 'profile-tag d-flex align-center ga-1',
                }, [
                  h('span', { class: 'text-caption' }, tag),
                  editing.value
                    ? h('button', {
                        class: 'tag-remove-btn',
                        onClick: () => removeTag(tag),
                        innerHTML: '×',
                      })
                    : null,
                ]),
              ),
              editing.value
                ? h('div', { class: 'd-flex align-center ga-1' }, [
                    h('input', {
                      class: 'tag-input',
                      value: newTag.value,
                      placeholder: 'новий тег',
                      onInput: (e: Event) => { newTag.value = (e.target as HTMLInputElement).value; },
                      onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } },
                    }),
                    h('button', { class: 'tag-add-btn', onClick: addTag }, '+'),
                  ])
                : displayTags.length === 0 ? h('span', { class: 'text-caption text-grey' }, '—') : null,
            ]),
          ]),

          // Notes
          h('div', { class: 'profile-field mb-2' }, [
            h('div', { class: 'text-caption text-grey mb-1' }, 'Нотатка'),
            editing.value
              ? h('textarea', {
                  class: 'profile-textarea',
                  value: form.value.notes,
                  rows: 3,
                  placeholder: 'Будь-яка корисна інформація...',
                  onInput: (e: Event) => { form.value.notes = (e.target as HTMLTextAreaElement).value; },
                })
              : h('div', { class: 'text-body-2', style: 'white-space: pre-wrap; word-break: break-word;' },
                  c?.notes || h('span', { class: 'text-grey' }, '—'),
                ),
          ]),

          // Edit actions
          editing.value
            ? h('div', { class: 'd-flex ga-2 mt-3' }, [
                h('button', {
                  class: 'profile-save-btn',
                  disabled: saving.value,
                  onClick: saveProfile,
                }, saving.value ? 'Збереження...' : 'Зберегти'),
                h('button', {
                  class: 'profile-cancel-btn',
                  onClick: cancelEdit,
                }, 'Скасувати'),
              ])
            : null,
        ]),

        h('hr', { class: 'v-divider' }),

        // Import history
        h('div', { class: 'pa-3' }, [
          h('div', { class: 'text-caption text-grey mb-2' }, 'Інструменти'),
          h('button', {
            class: 'import-btn d-flex align-center ga-2',
            disabled: importing.value,
            onClick: importHistory,
          }, [
            importing.value
              ? h('span', { class: 'import-spinner' })
              : h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor' },
                  h('path', { d: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z' }),
                ),
            h('span', { class: 'text-body-2' }, importing.value ? 'Імпортую...' : 'Завантажити IG-переписку'),
          ]),
          h('div', { class: 'text-caption text-grey mt-1' },
            'Імпортує старі повідомлення з Instagram до цього діалогу',
          ),
        ]),
      ]);
    };

    function profileField(label: string, content: ReturnType<typeof h>) {
      return h('div', { class: 'profile-field mb-2' }, [
        h('div', { class: 'text-caption text-grey mb-1' }, label),
        content,
      ]);
    }
  },
});

const clientProfilePanel = ClientProfilePanel;
</script>

<style scoped>
.detail-root {
  height: calc(100vh - 64px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.detail-mobile-header {
  background: rgb(var(--v-theme-surface));
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  flex-shrink: 0;
}

.detail-layout {
  flex: 1 1 auto;
  display: flex;
  overflow: hidden;
}

.chat-col {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}

.profile-col {
  width: 280px;
  min-width: 280px;
  border-left: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));
  overflow-y: auto;
  flex-shrink: 0;
}

.chat-header {
  background: rgb(var(--v-theme-surface));
}

.messages-area {
  background: #fafafa;
}

/* Profile panel styles */
:deep(.profile-panel) {
  height: 100%;
}

:deep(.profile-field) {
  margin-bottom: 10px;
}

:deep(.profile-input) {
  width: 100%;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 13px;
  outline: none;
  background: #fff;
}
:deep(.profile-input:focus) {
  border-color: rgb(var(--v-theme-primary));
}

:deep(.profile-textarea) {
  width: 100%;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
  resize: vertical;
  background: #fff;
}
:deep(.profile-textarea:focus) {
  border-color: rgb(var(--v-theme-primary));
}

:deep(.profile-save-btn) {
  flex: 1;
  background: rgb(var(--v-theme-primary));
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 7px 12px;
  font-size: 13px;
  cursor: pointer;
}
:deep(.profile-save-btn:disabled) {
  opacity: 0.6;
  cursor: default;
}
:deep(.profile-cancel-btn) {
  border: 1px solid #ccc;
  background: #fff;
  border-radius: 6px;
  padding: 7px 12px;
  font-size: 13px;
  cursor: pointer;
  color: #555;
}

:deep(.profile-action-btn) {
  border: none;
  background: none;
  cursor: pointer;
  color: #666;
  padding: 4px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
:deep(.profile-action-btn:hover) {
  background: rgba(0,0,0,0.06);
}

:deep(.profile-tag) {
  background: rgba(var(--v-theme-primary), 0.1);
  color: rgb(var(--v-theme-primary));
  border-radius: 12px;
  padding: 2px 8px;
  font-size: 11px;
}

:deep(.tag-remove-btn) {
  border: none;
  background: none;
  cursor: pointer;
  color: rgb(var(--v-theme-primary));
  padding: 0;
  font-size: 14px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
}

:deep(.tag-input) {
  border: 1px dashed rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 12px;
  padding: 2px 8px;
  font-size: 11px;
  outline: none;
  width: 80px;
}

:deep(.tag-add-btn) {
  border: none;
  background: rgba(var(--v-theme-primary), 0.1);
  color: rgb(var(--v-theme-primary));
  border-radius: 50%;
  width: 20px;
  height: 20px;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

:deep(.import-btn) {
  width: 100%;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: #fff;
  border-radius: 8px;
  padding: 8px 12px;
  cursor: pointer;
  color: #444;
  text-align: left;
  transition: background 0.15s;
}
:deep(.import-btn:hover:not(:disabled)) {
  background: #f5f5f5;
}
:deep(.import-btn:disabled) {
  opacity: 0.6;
  cursor: default;
}

:deep(.import-spinner) {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(var(--v-theme-primary), 0.2);
  border-top-color: rgb(var(--v-theme-primary));
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Mobile */
@media (max-width: 960px) {
  .detail-root {
    height: calc(100vh - 56px);
  }
}
</style>
