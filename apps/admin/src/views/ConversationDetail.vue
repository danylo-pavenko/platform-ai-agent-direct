<template>
  <v-container fluid class="d-flex flex-column pa-2 pa-md-4" style="height: calc(100vh - 64px);">
    <!-- Top bar -->
    <v-card class="mb-2 mb-md-3" flat>
      <v-card-text class="d-flex align-center ga-2 pa-2 pa-md-3">
        <v-btn icon variant="text" size="small" @click="router.push({ name: 'conversations' })">
          <v-icon>mdi-arrow-left</v-icon>
        </v-btn>
        <div class="flex-grow-1" style="min-width: 0;">
          <div class="text-subtitle-2 text-md-subtitle-1 font-weight-bold text-truncate">
            {{ conversation?.client?.displayName || conversation?.client?.igUserId || 'Клієнт' }}
          </div>
          <div class="text-caption text-grey">
            {{ conversation?.channel?.toUpperCase() }} · #{{ conversation?.id?.substring(0, 8) }}
          </div>
        </div>
        <v-chip
          v-if="conversation?.state"
          :color="stateColor(conversation.state)"
          size="small"
          label
        >
          {{ stateLabel(conversation.state) }}
        </v-chip>
      </v-card-text>
    </v-card>

    <!-- Messages area -->
    <v-card class="flex-grow-1 overflow-hidden d-flex flex-column" flat style="min-height: 0;">
      <div v-if="loading" class="d-flex justify-center align-center flex-grow-1">
        <v-progress-circular indeterminate color="primary" />
      </div>

      <div
        v-else
        ref="messagesContainer"
        class="flex-grow-1 overflow-y-auto pa-3 pa-md-4"
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
          <!-- System message -->
          <div v-if="msg.sender === 'system'" class="text-center">
            <v-chip size="x-small" variant="outlined" class="font-italic">
              {{ msg.text }}
            </v-chip>
          </div>

          <!-- Regular message bubble -->
          <div v-else :style="{ maxWidth: mobile ? '85%' : '70%' }">
            <div
              class="text-caption text-grey mb-1"
              :class="msg.direction === 'out' ? 'text-right' : ''"
            >
              {{ senderIcon(msg) }} {{ senderLabel(msg) }} · {{ formatTime(msg.createdAt) }}
            </div>
            <v-card
              :color="bubbleColor(msg)"
              :variant="msg.direction === 'in' ? 'tonal' : 'flat'"
              rounded="lg"
              class="pa-3"
            >
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
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { useDisplay } from 'vuetify';
import api from '@/api';

const { mobile } = useDisplay();

interface Message {
  id: string;
  direction: 'in' | 'out';
  sender: 'client' | 'bot' | 'manager' | 'system';
  text: string;
  createdAt: string;
}

interface Conversation {
  id: string;
  client: { igUserId?: string; displayName?: string };
  channel: string;
  state: string;
  messages: Message[];
}

const props = defineProps<{ id: string }>();
const router = useRouter();

const conversation = ref<Conversation | null>(null);
const messages = ref<Message[]>([]);
const loading = ref(false);
const replyText = ref('');
const sending = ref(false);
const sendError = ref('');
const messagesContainer = ref<HTMLElement | null>(null);

function stateColor(state: string): string {
  return { bot: 'blue', handoff: 'orange', closed: 'grey', paused: 'purple' }[state] || 'grey';
}

function stateLabel(state: string): string {
  return { bot: 'Бот', handoff: 'Менеджер', closed: 'Закрито', paused: 'Пауза' }[state] || state;
}

function formatTime(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  }
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
  return { client: '👤', bot: '🤖', manager: '💬', system: '⚙️' }[msg.sender] || '';
}

function senderLabel(msg: Message): string {
  return { client: 'Клієнт', bot: 'Бот', manager: 'Менеджер', system: 'Система' }[msg.sender] || msg.sender;
}

async function scrollToBottom() {
  await nextTick();
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }
}

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

onMounted(() => {
  fetchConversation();
});
</script>
