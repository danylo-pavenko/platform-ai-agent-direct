<template>
  <div class="cpp">
    <!-- Sheet / panel chrome -->
    <header class="cpp-chrome">
      <div class="cpp-grab" aria-hidden="true" />
      <div class="cpp-chrome-row">
        <div>
          <div class="cpp-title">Профіль клієнта</div>
          <div v-if="primaryName" class="cpp-title-sub text-truncate">{{ primaryName }}</div>
        </div>
        <v-btn
          v-if="!editing"
          icon="mdi-pencil-outline"
          variant="text"
          size="small"
          class="tap-target"
          title="Редагувати"
          @click="startEdit"
        />
        <v-btn
          v-else
          icon="mdi-close"
          variant="text"
          size="small"
          class="tap-target"
          title="Скасувати"
          @click="cancelEdit"
        />
      </div>
    </header>

    <div class="cpp-scroll">
      <!-- Identity hero -->
      <section class="cpp-card cpp-hero">
        <div class="cpp-hero-top">
          <div class="cpp-avatar" :aria-label="primaryName">{{ avatarLetter }}</div>
          <div class="cpp-hero-text">
            <div class="cpp-hero-name text-truncate">{{ primaryName }}</div>
            <div v-if="igHandle" class="cpp-hero-handle text-truncate">@{{ igHandle }}</div>
            <div v-else-if="igTitle" class="cpp-hero-handle text-truncate">{{ igTitle }}</div>
          </div>
        </div>
        <div v-if="igHandle || client?.igUserId" class="cpp-hero-actions">
          <v-btn
            v-if="igProfileHref"
            :href="igProfileHref"
            target="_blank"
            rel="noopener noreferrer"
            size="small"
            variant="tonal"
            color="pink"
            prepend-icon="mdi-instagram"
            class="tap-target"
          >
            Профіль
          </v-btn>
          <v-btn
            v-if="igDmHref"
            :href="igDmHref"
            target="_blank"
            rel="noopener noreferrer"
            size="small"
            variant="tonal"
            color="primary"
            prepend-icon="mdi-message-outline"
            class="tap-target"
          >
            DM
          </v-btn>
        </div>
        <div v-if="client?.igUserId" class="cpp-meta-line">
          IGSID · <span class="cpp-mono">{{ shortId(client.igUserId) }}</span>
        </div>
      </section>

      <!-- Lead / thread stats -->
      <section v-if="leadSummary" class="cpp-card">
        <div class="cpp-card-head">
          <span class="cpp-card-label">Лід і тред</span>
          <v-chip
            v-if="leadSummary.intent"
            size="x-small"
            label
            color="primary"
            variant="tonal"
          >
            {{ intentLabel(leadSummary.intent) }}
          </v-chip>
        </div>
        <div class="cpp-stat-grid">
          <div class="cpp-stat">
            <span class="cpp-stat-k">Канал</span>
            <span class="cpp-stat-v">{{ channelLabel(leadSummary.channel) }}</span>
          </div>
          <div class="cpp-stat">
            <span class="cpp-stat-k">Повідомлень</span>
            <span class="cpp-stat-v">{{ leadSummary.messageCount }}</span>
          </div>
          <div class="cpp-stat cpp-stat--wide">
            <span class="cpp-stat-k">Відкрито</span>
            <span class="cpp-stat-v">{{ formatLeadDate(leadSummary.createdAt) }}</span>
          </div>
          <div class="cpp-stat cpp-stat--wide">
            <span class="cpp-stat-k">Остання активність</span>
            <span class="cpp-stat-v">{{ formatLeadDate(leadSummary.lastMessageAt) }}</span>
          </div>
        </div>
      </section>

      <!-- Last order widget -->
      <section v-if="lastOrder?.id" class="cpp-card cpp-card--accent">
        <div class="cpp-card-head">
          <span class="cpp-card-label">Останнє замовлення</span>
          <v-chip size="x-small" label :color="orderStatusColor" variant="flat">
            {{ orderStatusLabel }}
          </v-chip>
        </div>
        <div class="cpp-order-title">{{ orderItemLabel || orderKindLabel }}</div>
        <div class="cpp-order-meta">
          {{ orderKindLabel }} · {{ formatLeadDate(lastOrder.createdAt) }}
        </div>
        <v-btn
          block
          color="primary"
          variant="flat"
          class="tap-target mt-3"
          prepend-icon="mdi-open-in-new"
          @click="openLastOrder"
        >
          Відкрити в Замовленнях
        </v-btn>
      </section>

      <!-- Contacts -->
      <section class="cpp-card">
        <div class="cpp-card-head">
          <span class="cpp-card-label">Контакти</span>
          <v-btn
            v-if="!editing"
            size="x-small"
            variant="text"
            class="tap-target"
            @click="startEdit"
          >
            Змінити
          </v-btn>
        </div>

        <template v-if="!editing">
          <div class="cpp-kv">
            <span class="cpp-kv-k">Імʼя</span>
            <span class="cpp-kv-v">{{ chatName || '—' }}</span>
          </div>
          <div class="cpp-kv">
            <span class="cpp-kv-k">Мова</span>
            <span class="cpp-kv-v">{{ languageLabel }}</span>
          </div>
          <div v-if="igTitle" class="cpp-kv">
            <span class="cpp-kv-k">Профіль IG</span>
            <span class="cpp-kv-v cpp-muted">{{ igTitle }}</span>
          </div>
          <div class="cpp-kv">
            <span class="cpp-kv-k">Телефон</span>
            <span class="cpp-kv-v">{{ client?.phone || '—' }}</span>
          </div>
          <div class="cpp-kv">
            <span class="cpp-kv-k">Email</span>
            <span class="cpp-kv-v">{{ client?.email || '—' }}</span>
          </div>
          <div class="cpp-kv">
            <span class="cpp-kv-k">Місто</span>
            <span class="cpp-kv-v">{{ client?.deliveryCity || '—' }}</span>
          </div>
          <div class="cpp-kv">
            <span class="cpp-kv-k">НП</span>
            <span class="cpp-kv-v">{{ npDisplay }}</span>
          </div>
          <div class="cpp-kv cpp-kv--block">
            <span class="cpp-kv-k">Теги</span>
            <div v-if="(client?.tags?.length ?? 0) > 0" class="cpp-tags">
              <span v-for="tag in client?.tags" :key="tag" class="cpp-tag">{{ tag }}</span>
            </div>
            <span v-else class="cpp-kv-v">—</span>
          </div>
          <div class="cpp-kv cpp-kv--block">
            <span class="cpp-kv-k">Нотатка</span>
            <span class="cpp-kv-v cpp-note">{{ client?.notes || '—' }}</span>
          </div>
        </template>

        <template v-else>
          <v-text-field
            v-model="form.displayName"
            label="Імʼя"
            placeholder="Як клієнт назвався в чаті"
            variant="outlined"
            density="comfortable"
            hide-details="auto"
            class="mb-2"
          />
          <v-select
            v-model="form.preferredLanguage"
            :items="languageItems"
            item-title="title"
            item-value="value"
            label="Мова"
            placeholder="Ще не визначена"
            variant="outlined"
            density="comfortable"
            hide-details="auto"
            clearable
            class="mb-2"
          />
          <v-text-field
            v-model="form.phone"
            label="Телефон"
            placeholder="+380..."
            variant="outlined"
            density="comfortable"
            hide-details="auto"
            class="mb-2"
          />
          <v-text-field
            v-model="form.email"
            label="Email"
            placeholder="email@example.com"
            variant="outlined"
            density="comfortable"
            hide-details="auto"
            class="mb-2"
          />
          <v-text-field
            v-model="form.deliveryCity"
            label="Місто"
            placeholder="Київ"
            variant="outlined"
            density="comfortable"
            hide-details="auto"
            class="mb-2"
          />
          <v-text-field
            v-model="form.deliveryNpBranch"
            label="Відділення НП"
            placeholder="12 або адреса поштомату"
            variant="outlined"
            density="comfortable"
            hide-details="auto"
            class="mb-2"
          />
          <div class="mb-2">
            <div class="text-caption text-medium-emphasis mb-1">Теги</div>
            <div class="cpp-tags mb-2">
              <span v-for="tag in form.tags ?? []" :key="tag" class="cpp-tag cpp-tag--edit">
                {{ tag }}
                <button type="button" class="cpp-tag-x" @click="removeTag(tag)">×</button>
              </span>
            </div>
            <div class="d-flex ga-2">
              <v-text-field
                v-model="newTag"
                placeholder="новий тег"
                variant="outlined"
                density="comfortable"
                hide-details
                class="flex-grow-1"
                @keydown.enter.prevent="addTag"
              />
              <v-btn icon="mdi-plus" variant="tonal" class="tap-target" @click="addTag" />
            </div>
          </div>
          <v-textarea
            v-model="form.notes"
            label="Нотатка"
            placeholder="Будь-яка корисна інформація..."
            variant="outlined"
            density="comfortable"
            rows="3"
            auto-grow
            hide-details="auto"
            class="mb-3"
          />
          <div class="d-flex flex-column ga-2">
            <v-btn
              block
              color="primary"
              class="tap-target"
              :loading="saving"
              @click="saveProfile"
            >
              Зберегти
            </v-btn>
            <v-btn block variant="text" class="tap-target" @click="cancelEdit">
              Скасувати
            </v-btn>
          </div>
        </template>
      </section>

      <!-- CRM -->
      <section class="cpp-card">
        <div class="cpp-card-head">
          <span class="cpp-card-label">CRM клієнт</span>
          <v-chip
            size="x-small"
            label
            :color="client?.crmBuyerId ? 'success' : 'default'"
            :variant="client?.crmBuyerId ? 'flat' : 'tonal'"
          >
            {{ client?.crmBuyerId ? 'Привʼязано' : 'Не привʼязано' }}
          </v-chip>
        </div>

        <div v-if="client?.crmBuyerId" class="cpp-crm-id mb-3">
          <div class="cpp-mono text-break">{{ client.crmBuyerId }}</div>
          <div class="cpp-meta-line">
            {{
              [client.crmProvider, client.crmLinkedAt ? `з ${formatLeadDate(client.crmLinkedAt)}` : null]
                .filter(Boolean)
                .join(' · ')
            }}
          </div>
        </div>
        <p v-else class="text-body-2 text-medium-emphasis mb-3">
          Знайдіть клієнта в CRM за телефоном або вставте UUID вручну — зʼявиться історія візитів.
        </p>

        <div class="cpp-actions">
          <v-btn
            block
            variant="tonal"
            color="primary"
            class="tap-target"
            :loading="crmLinking"
            :disabled="!client?.phone"
            prepend-icon="mdi-phone-search"
            @click="linkCrmByPhone"
          >
            Знайти за телефоном
          </v-btn>
          <v-btn
            block
            variant="tonal"
            class="tap-target"
            :loading="crmHistoryLoading"
            :disabled="!client?.id"
            prepend-icon="mdi-history"
            @click="loadCrmHistory"
          >
            Оновити історію
          </v-btn>
          <v-btn
            v-if="client?.crmBuyerId"
            block
            variant="text"
            color="error"
            class="tap-target"
            :disabled="crmLinking"
            @click="unlinkCrm"
          >
            Відвʼязати
          </v-btn>
        </div>

        <div class="cpp-manual mt-3">
          <v-text-field
            v-model="crmManualId"
            label="CRM client UUID"
            placeholder="Вставити UUID вручну"
            variant="outlined"
            density="comfortable"
            hide-details="auto"
            class="mb-2"
          />
          <v-btn
            block
            color="primary"
            variant="flat"
            class="tap-target"
            :loading="crmLinking"
            @click="linkCrmManual"
          >
            Привʼязати
          </v-btn>
        </div>

        <v-alert
          v-if="crmLinkMessage"
          class="mt-3"
          density="compact"
          variant="tonal"
          type="info"
        >
          {{ crmLinkMessage }}
        </v-alert>

        <div v-if="crmHistoryText" class="cpp-history mt-3">
          <div class="cpp-card-label mb-1">Історія візитів</div>
          <pre class="cpp-history-pre">{{ crmHistoryText }}</pre>
        </div>
        <p v-else class="text-caption text-medium-emphasis mt-3 mb-0">
          Історія візитів зʼявиться після привʼязки (тривалість для планування запису).
        </p>
      </section>

      <!-- Tools -->
      <section class="cpp-card cpp-card--muted">
        <div class="cpp-card-head">
          <span class="cpp-card-label">Інструменти</span>
        </div>
        <v-btn
          block
          variant="outlined"
          class="tap-target"
          :loading="importing"
          prepend-icon="mdi-cloud-download-outline"
          @click="importHistory"
        >
          {{ importing ? 'Імпортую…' : 'Завантажити IG-переписку' }}
        </v-btn>
        <p class="text-caption text-medium-emphasis mt-2 mb-0">
          Імпортує старі повідомлення з Instagram до цього діалогу.
        </p>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import api from '@/api';
import { adminChatCollectedName, adminClientPrimaryName, adminIgProfileTitle } from '@/lib/client-label';

export interface ProfileClient {
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
  preferredLanguage?: 'uk' | 'ru' | 'en' | null;
  crmBuyerId?: string | null;
  crmProvider?: string | null;
  crmLinkedAt?: string | null;
}

export interface ProfileLeadSummary {
  channel: string;
  intent: string | null;
  createdAt: string;
  firstInboundAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
}

export interface ProfileOrderSummary {
  id: string;
  kind?: string | null;
  status: string;
  customerName?: string | null;
  createdAt: string;
  items?: unknown;
  quotedTotal?: number | null;
}

const INTENT_LABELS: Record<string, string> = {
  new_lead: 'Новий лід',
  service_question: 'Сервіс / питання',
  complaint: 'Скарга',
  partnership: 'Партнерство',
  jobs: 'Вакансії',
  spam: 'Спам',
};

const props = defineProps<{
  client?: ProfileClient;
  conversationId: string;
  leadSummary?: ProfileLeadSummary | null;
  lastOrder?: ProfileOrderSummary | null;
}>();

const emit = defineEmits<{
  updated: [client: ProfileClient];
  profileEditing: [editing: boolean];
}>();

const router = useRouter();

const editing = ref(false);
const saving = ref(false);
const importing = ref(false);
const newTag = ref('');
const crmLinking = ref(false);
const crmHistoryLoading = ref(false);
const crmManualId = ref('');
const crmHistoryText = ref('');
const crmLinkMessage = ref('');

const form = ref<Partial<ProfileClient>>({});
const languageItems = [
  { title: 'Українська', value: 'uk' },
  { title: 'Російська', value: 'ru' },
  { title: 'Англійська', value: 'en' },
];

watch(editing, (v) => emit('profileEditing', v));

const primaryName = computed(() => adminClientPrimaryName(props.client));
const chatName = computed(() => adminChatCollectedName(props.client));
const igTitle = computed(() => adminIgProfileTitle(props.client));
const igHandle = computed(() => props.client?.igUsername?.replace(/^@+/, '').trim() || '');
const avatarLetter = computed(() => {
  const src = chatName.value || igHandle.value || primaryName.value || '?';
  return src.replace(/^@/, '').charAt(0).toUpperCase() || '?';
});
const igProfileHref = computed(() =>
  igHandle.value ? `https://www.instagram.com/${encodeURIComponent(igHandle.value)}/` : null,
);
const igDmHref = computed(() =>
  igHandle.value ? `https://ig.me/m/${encodeURIComponent(igHandle.value)}` : null,
);

const npDisplay = computed(() => {
  const branch = props.client?.deliveryNpBranch;
  if (!branch) return '—';
  const kind = props.client?.deliveryNpType === 'postamat' ? 'Поштомат' : 'Відділення';
  return `${kind} ${branch}`;
});

const languageLabel = computed(() => {
  const code = props.client?.preferredLanguage;
  return languageItems.find((item) => item.value === code)?.title ?? 'Ще не визначена';
});

const orderKindLabel = computed(() => {
  const kind = props.lastOrder?.kind;
  if (kind === 'booking') return 'Запис';
  if (kind === 'brief') return 'Бриф';
  if (kind === 'callback') return 'Дзвінок';
  return 'Замовлення';
});

const orderStatusLabel = computed(() => {
  const map: Record<string, string> = {
    draft: 'Чернетка',
    submitted: 'Подано',
    confirmed: 'Підтверджено',
    cancelled: 'Скасовано',
  };
  const s = props.lastOrder?.status;
  return s ? (map[s] ?? s) : '—';
});

const orderStatusColor = computed(() => {
  const s = props.lastOrder?.status;
  if (s === 'confirmed') return 'success';
  if (s === 'cancelled') return 'error';
  if (s === 'submitted') return 'info';
  return 'default';
});

const orderItemLabel = computed(() => summarizeOrderItems(props.lastOrder?.items));

function summarizeOrderItems(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return '';
  const names: string[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const name = typeof (raw as { name?: unknown }).name === 'string'
      ? (raw as { name: string }).name.trim()
      : '';
    if (name) names.push(name);
  }
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  return `${names[0]} +${names.length - 1}`;
}

function formatLeadDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('uk-UA', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

function channelLabel(ch: string): string {
  return ch === 'ig' ? 'Instagram DM' : ch?.toUpperCase() ?? '—';
}

function intentLabel(intent: string | null | undefined): string {
  if (!intent) return '—';
  return INTENT_LABELS[intent] ?? intent;
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

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
    preferredLanguage: props.client?.preferredLanguage ?? null,
    crmBuyerId: props.client?.crmBuyerId ?? '',
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
  if (!form.value.tags.includes(tag)) form.value.tags.push(tag);
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
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } } };
    alert(err.response?.data?.error || 'Помилка збереження');
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
    window.location.reload();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } } };
    alert(err.response?.data?.error || 'Помилка імпорту');
  } finally {
    importing.value = false;
  }
}

async function linkCrmByPhone() {
  if (!props.client?.id) return;
  crmLinking.value = true;
  crmLinkMessage.value = '';
  try {
    const { data } = await api.post(`/conversations/clients/${props.client.id}/crm-link`);
    if (data.client) emit('updated', data.client);
    crmLinkMessage.value = data.linked
      ? `Привʼязано (${data.source})`
      : data.message || 'Не знайдено в CRM';
    if (data.linked) await loadCrmHistory();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } } };
    crmLinkMessage.value = err.response?.data?.error || 'Помилка привʼязки';
  } finally {
    crmLinking.value = false;
  }
}

async function linkCrmManual() {
  if (!props.client?.id) return;
  const id = crmManualId.value.trim();
  if (!id) {
    crmLinkMessage.value = 'Вкажи CRM client UUID';
    return;
  }
  crmLinking.value = true;
  crmLinkMessage.value = '';
  try {
    const { data } = await api.post(`/conversations/clients/${props.client.id}/crm-link`, {
      crmBuyerId: id,
    });
    if (data.client) emit('updated', data.client);
    crmManualId.value = '';
    crmLinkMessage.value = 'Привʼязано вручну';
    await loadCrmHistory();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } } };
    crmLinkMessage.value = err.response?.data?.error || 'Помилка привʼязки';
  } finally {
    crmLinking.value = false;
  }
}

async function unlinkCrm() {
  if (!props.client?.id) return;
  if (!confirm('Відвʼязати клієнта від CRM?')) return;
  crmLinking.value = true;
  try {
    const { data } = await api.delete(`/conversations/clients/${props.client.id}/crm-link`);
    if (data.client) emit('updated', data.client);
    crmHistoryText.value = '';
    crmLinkMessage.value = 'Відвʼязано';
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } } };
    crmLinkMessage.value = err.response?.data?.error || 'Помилка';
  } finally {
    crmLinking.value = false;
  }
}

async function loadCrmHistory() {
  if (!props.client?.id) return;
  crmHistoryLoading.value = true;
  try {
    const { data } = await api.get(`/conversations/clients/${props.client.id}/crm-history`);
    crmHistoryText.value = data.text || '';
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } } };
    crmHistoryText.value = err.response?.data?.error || 'Не вдалося завантажити історію';
  } finally {
    crmHistoryLoading.value = false;
  }
}

function openLastOrder() {
  const id = props.lastOrder?.id;
  if (!id) return;
  router.push({ name: 'orders', query: { open: id } });
}

watch(
  () => props.client?.crmBuyerId,
  (id) => {
    if (id) void loadCrmHistory();
    else crmHistoryText.value = '';
  },
  { immediate: true },
);
</script>

<style scoped>
.cpp {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: linear-gradient(180deg, #f6f7fb 0%, #eef1f6 100%);
}

.cpp-chrome {
  flex-shrink: 0;
  padding: 10px 14px 8px;
  background: rgba(255, 255, 255, 0.92);
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
  backdrop-filter: blur(10px);
}

.cpp-grab {
  width: 36px;
  height: 4px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.14);
  margin: 0 auto 10px;
}

.cpp-chrome-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.cpp-title {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
  line-height: 1.25;
}

.cpp-title-sub {
  font-size: 12px;
  color: #64748b;
  margin-top: 2px;
  max-width: 220px;
}

.cpp-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 12px;
  padding-bottom: max(16px, env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cpp-card {
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.06);
  border-radius: 16px;
  padding: 14px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}

.cpp-card--accent {
  border-color: rgba(99, 91, 255, 0.22);
  background: linear-gradient(180deg, #ffffff 0%, #f7f6ff 100%);
}

.cpp-card--muted {
  background: rgba(255, 255, 255, 0.72);
}

.cpp-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.cpp-card-label {
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #64748b;
}

.cpp-hero-top {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.cpp-avatar {
  width: 48px;
  height: 48px;
  border-radius: 14px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  font-size: 18px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(145deg, #635bff 0%, #8b5cf6 100%);
  box-shadow: 0 8px 18px rgba(99, 91, 255, 0.28);
}

.cpp-hero-text {
  min-width: 0;
  flex: 1;
}

.cpp-hero-name {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #0f172a;
  line-height: 1.25;
}

.cpp-hero-handle {
  font-size: 13px;
  color: #64748b;
  margin-top: 2px;
}

.cpp-hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.cpp-meta-line {
  margin-top: 10px;
  font-size: 11px;
  color: #94a3b8;
}

.cpp-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
}

.cpp-stat-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.cpp-stat {
  min-width: 0;
  padding: 10px;
  border-radius: 12px;
  background: #f8fafc;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cpp-stat--wide {
  grid-column: 1 / -1;
}

.cpp-stat-k {
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.2;
}

.cpp-stat-v {
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
  line-height: 1.35;
  word-break: break-word;
}

.cpp-order-title {
  font-size: 15px;
  font-weight: 650;
  color: #0f172a;
  line-height: 1.35;
}

.cpp-order-meta {
  margin-top: 4px;
  font-size: 12px;
  color: #64748b;
}

.cpp-kv {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 8px 12px;
  align-items: start;
  padding: 8px 0;
  border-bottom: 1px solid rgba(15, 23, 42, 0.05);
}

.cpp-kv:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}

.cpp-kv--block {
  grid-template-columns: 1fr;
  gap: 6px;
}

.cpp-kv-k {
  font-size: 12px;
  color: #94a3b8;
  padding-top: 1px;
}

.cpp-kv-v {
  font-size: 13px;
  color: #0f172a;
  word-break: break-word;
}

.cpp-muted {
  color: #64748b !important;
}

.cpp-note {
  white-space: pre-wrap;
}

.cpp-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cpp-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(99, 91, 255, 0.1);
  color: #635bff;
  font-size: 12px;
  font-weight: 550;
}

.cpp-tag-x {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
  min-width: 18px;
  min-height: 18px;
}

.cpp-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cpp-crm-id {
  padding: 10px 12px;
  border-radius: 12px;
  background: #f8fafc;
}

.cpp-history-pre {
  margin: 0;
  padding: 12px;
  border-radius: 12px;
  background: #0f172a;
  color: #e2e8f0;
  font-size: 11.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
}

@media (min-width: 960px) {
  .cpp-grab {
    display: none;
  }

  .cpp {
    background: #f8fafc;
  }
}
</style>
