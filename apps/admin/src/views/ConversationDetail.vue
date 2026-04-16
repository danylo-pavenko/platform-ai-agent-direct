<template>
  <v-container fluid class="d-flex flex-column" style="height: calc(100vh - 24px);">
    <!-- Top bar -->
    <v-card class="mb-3" flat>
      <v-card-text class="d-flex align-center ga-3 pa-3">
        <v-btn icon variant="text" @click="router.push({ name: 'conversations' })">
          <v-icon>mdi-arrow-left</v-icon>
        </v-btn>
        <div>
          <div class="text-subtitle-1 font-weight-bold">
            {{ conversation?.client?.displayName || conversation?.client?.igUserId || 'Клієнт' }}
          </div>
          <div class="text-caption text-grey">
            {{ conversation?.channel }} · ID: {{ conversation?.id?.substring(0, 8) }}
          </div>
        </div>
        <v-chip
          v-if="conversation?.state"
          :color="stateColor(conversation.state)"
          size="small"
          label
          class="ml-2"
        >
          {{ conversation.state }}
        </v-chip>
        <v-spacer />
      </v-card-text>
    </v-card>

    <!-- Messages area -->
    <v-card class="flex-grow-1 overflow-hidden d-flex flex-column" flat>
      <div v-if="loading" class="d-flex justify-center align-center flex-grow-1">
        <v-progress-circular indeterminate color="primary" />
      </div>

      <div
        v-else
        ref="messagesContainer"
        class="flex-grow-1 overflow-y-auto pa-4"
        style="min-height: 0;"
      >
        <div
          v-for="msg in messages"
          :key="msg.id"
          class="mb-3"
          :class="messageAlignment(msg)"
        >
          <!-- System message -->
          <div v-if="msg.sender === 'system'" class="text-center">
            <v-chip size="small" variant="outlined" class="font-italic">
              {{ msg.text }}
            </v-chip>
            <div class="text-caption text-grey mt-1">
              {{ formatDate(msg.createdAt) }}
            </div>
          </div>

          <!-- Regular message bubble -->
          <div v-else style="max-width: 70%;" :class="bubbleContainerClass(msg)">
            <div class="text-caption text-grey mb-1">
              {{ senderLabel(msg) }}
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
                style="white-space: pre-wrap; word-break: break-word;"
              >
                {{ msg.text }}
              </div>
            </v-card>
            <div class="text-caption text-grey mt-1">
              {{ formatDate(msg.createdAt) }}
            </div>
          </div>
        </div>
      </div>

      <!-- Reply input -->
      <v-divider />
      <div class="pa-3">
        <v-row dense align="center">
          <v-col>
            <v-textarea
              v-model="replyText"
              label="Повідомлення..."
              variant="outlined"
              density="compact"
              rows="2"
              auto-grow
              hide-details
              :disabled="sending"
              @keydown.ctrl.enter="sendReply"
              @keydown.meta.enter="sendReply"
            />
          </v-col>
          <v-col cols="auto">
            <v-btn
              color="primary"
              :loading="sending"
              :disabled="!replyText.trim()"
              @click="sendReply"
            >
              <v-icon start>mdi-send</v-icon>
              Відправити
            </v-btn>
          </v-col>
        </v-row>
        <v-alert v-if="sendError" type="error" density="compact" class="mt-2">
          {{ sendError }}
        </v-alert>
      </div>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import api from '@/api';

interface Message {
  id: string;
  direction: 'in' | 'out';
  sender: 'client' | 'bot' | 'manager' | 'system';
  text: string;
  createdAt: string;
}

interface Client {
  igUserId?: string;
  displayName?: string;
}

interface Conversation {
  id: string;
  client: Client;
  channel: string;
  state: string;
  messages: Message[];
  orders?: any[];
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
  const colors: Record<string, string> = {
    bot: 'blue',
    handoff: 'orange',
    closed: 'grey',
    paused: 'purple',
  };
  return colors[state] || 'grey';
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString('uk-UA');
}

function messageAlignment(msg: Message): string {
  if (msg.sender === 'system') return 'd-flex justify-center';
  if (msg.direction === 'in') return 'd-flex justify-start';
  return 'd-flex justify-end';
}

function bubbleContainerClass(msg: Message): string {
  if (msg.direction === 'in') return '';
  return 'text-right';
}

function bubbleColor(msg: Message): string {
  if (msg.direction === 'in') return 'grey-lighten-3';
  if (msg.sender === 'manager') return 'green';
  return 'blue';
}

function senderLabel(msg: Message): string {
  const labels: Record<string, string> = {
    client: 'Клієнт',
    bot: 'Бот',
    manager: 'Менеджер',
    system: 'Система',
  };
  return labels[msg.sender] || msg.sender;
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
  } catch (e) {
    console.error('Failed to fetch conversation', e);
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
    sendError.value = e.response?.data?.message || 'Помилка відправлення повідомлення';
  } finally {
    sending.value = false;
  }
}

onMounted(() => {
  fetchConversation();
});
</script>
