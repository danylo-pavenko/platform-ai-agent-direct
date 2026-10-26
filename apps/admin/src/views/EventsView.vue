<template>
  <v-container fluid class="page-shell">
    <PageHeader
      title="Події"
      subtitle="Найм, знижки, кастинг, події компанії — календар для агента без правки промпту."
    >
      <template #actions>
        <v-btn
          v-if="isOwner"
          color="primary"
          class="tap-target"
          :prepend-icon="mobile ? undefined : 'mdi-plus'"
          :icon="mobile ? 'mdi-plus' : undefined"
          aria-label="Нова подія"
          @click="openCreate"
        >
          <span v-if="!mobile">Нова подія</span>
        </v-btn>
      </template>
    </PageHeader>

    <v-alert type="info" variant="tonal" density="comfortable" class="mb-4">
      Агент бачить відкриті події в чаті. Після кінця «відгуків до» відповість, що вже неактуально.
      Вакансії / співпраця зазвичай → передача менеджеру з кастомним текстом.
    </v-alert>

    <v-tabs v-model="tab" density="comfortable" class="mb-3" show-arrows>
      <v-tab value="live">Живі</v-tab>
      <v-tab value="ended">Завершені</v-tab>
      <v-tab v-if="isOwner" value="draft">Чернетки</v-tab>
      <v-tab v-if="isOwner" value="all">Усі</v-tab>
    </v-tabs>

    <v-card>
      <ResponsiveDataList
        :loading="loading"
        :empty="!loading && filtered.length === 0"
        empty-text="Подій ще немає. Додайте вакансію, акцію чи кастинг."
      >
        <template #table>
          <v-data-table
            :headers="headers"
            :items="filtered"
            :loading="loading"
            hover
            item-value="id"
          >
            <template #item.title="{ item }">
              <div class="font-weight-medium">{{ item.title }}</div>
              <div class="text-caption text-medium-emphasis text-truncate" style="max-width: 360px">
                {{ item.summary }}
              </div>
            </template>
            <template #item.kind="{ item }">
              <v-chip size="small" label>{{ kindLabel(item.kind) }}</v-chip>
            </template>
            <template #item.lifecycle="{ item }">
              <v-chip size="small" :color="lifecycleColor(item)" variant="tonal" label>
                {{ lifecycleLabel(item) }}
              </v-chip>
            </template>
            <template #item.openUntil="{ item }">
              {{ item.openUntil ? formatDt(item.openUntil) : 'Безстроково' }}
            </template>
            <template #item.actions="{ item }">
              <template v-if="isOwner">
                <v-btn class="tap-target" variant="text" icon="mdi-pencil" @click="openEdit(item)" />
                <v-btn
                  v-if="item.status === 'active'"
                  class="tap-target"
                  variant="text"
                  icon="mdi-pause"
                  @click="setStatus(item, 'paused')"
                />
                <v-btn
                  v-else-if="item.status === 'draft' || item.status === 'paused'"
                  class="tap-target"
                  variant="text"
                  icon="mdi-publish"
                  color="success"
                  @click="setStatus(item, 'active')"
                />
                <v-btn
                  class="tap-target"
                  variant="text"
                  icon="mdi-content-copy"
                  @click="duplicate(item)"
                />
                <v-btn
                  class="tap-target"
                  variant="text"
                  icon="mdi-delete-outline"
                  color="error"
                  @click="confirmDelete(item)"
                />
              </template>
            </template>
          </v-data-table>
        </template>

        <template #cards>
          <MobileListCard
            v-for="item in filtered"
            :key="item.id"
            :title="item.title"
            :meta="item.summary"
          >
            <template #chips>
              <v-chip size="small" label>{{ kindLabel(item.kind) }}</v-chip>
              <v-chip size="small" :color="lifecycleColor(item)" variant="tonal" label>
                {{ lifecycleLabel(item) }}
              </v-chip>
              <v-chip size="small" variant="outlined" label>
                {{ item.openUntil ? `до ${formatDt(item.openUntil)}` : 'Безстроково' }}
              </v-chip>
            </template>
            <template #actions>
              <template v-if="isOwner">
                <v-btn variant="tonal" class="tap-target" block @click="openEdit(item)">
                  Редагувати
                </v-btn>
                <v-btn
                  v-if="item.status === 'active'"
                  variant="outlined"
                  class="tap-target"
                  block
                  @click="setStatus(item, 'paused')"
                >
                  Пауза
                </v-btn>
                <v-btn
                  v-else-if="item.status === 'draft' || item.status === 'paused'"
                  color="success"
                  variant="tonal"
                  class="tap-target"
                  block
                  @click="setStatus(item, 'active')"
                >
                  Опублікувати
                </v-btn>
                <v-btn variant="text" class="tap-target" block @click="duplicate(item)">
                  Дублювати
                </v-btn>
                <v-btn
                  variant="text"
                  color="error"
                  class="tap-target"
                  block
                  @click="confirmDelete(item)"
                >
                  Видалити
                </v-btn>
              </template>
            </template>
          </MobileListCard>
        </template>
      </ResponsiveDataList>
    </v-card>

    <v-dialog
      v-model="dialogOpen"
      :fullscreen="mobile"
      :max-width="mobile ? undefined : 720"
      persistent
      scrollable
      class="dialog-actions-stack"
      @after-leave="resetForm"
    >
      <v-card class="d-flex flex-column" :style="mobile ? 'height: 100%' : undefined">
        <v-card-title class="d-flex align-center justify-space-between flex-shrink-0">
          <span>{{ editingId ? 'Редагувати подію' : 'Нова подія' }}</span>
          <v-btn
            icon="mdi-close"
            variant="text"
            class="tap-target"
            aria-label="Закрити"
            @click="dialogOpen = false"
          />
        </v-card-title>

        <v-card-text class="flex-grow-1" style="overflow-y: auto">
          <v-text-field
            v-model="form.title"
            label="Назва *"
            :density="density"
            class="mb-2"
            hint="Напр. «Шукаємо SMM», «−20% на манікюр», «День відкритих дверей»"
            persistent-hint
          />

          <v-select
            v-model="form.kind"
            :items="kindOptions"
            item-title="title"
            item-value="value"
            label="Тип *"
            :density="density"
            class="mb-2"
          />

          <v-textarea
            v-model="form.details"
            label="Опис / деталі *"
            :density="density"
            rows="4"
            auto-grow
            class="mb-2"
            hint="Умови, кого шукаємо, знижка, дати — це бачить агент"
            persistent-hint
          />

          <v-text-field
            v-model="form.summary"
            label="Коротко для календаря (необовʼязково)"
            :density="density"
            class="mb-2"
            hint="1 рядок у промпті агента; порожньо — з першого речення опису"
            persistent-hint
          />

          <v-switch
            v-model="noEventDates"
            label="Без конкретної дати події (найм / постійна акція)"
            :density="density"
            color="primary"
            hide-details
            class="mb-2"
          />
          <v-row v-if="!noEventDates" dense class="mb-2">
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="form.eventStartsAt"
                label="Подія з"
                type="datetime-local"
                :density="density"
              />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="form.eventEndsAt"
                label="Подія до"
                type="datetime-local"
                :density="density"
              />
            </v-col>
          </v-row>

          <div class="text-subtitle-2 mb-1">Доки приймаємо відгуки</div>
          <v-switch
            v-model="openEnded"
            label="Безстроково"
            :density="density"
            color="primary"
            hide-details
            class="mb-2"
          />
          <v-row dense class="mb-2">
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="form.openFrom"
                label="Відгуки з"
                type="datetime-local"
                :density="density"
                clearable
              />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="form.openUntil"
                label="Відгуки до"
                type="datetime-local"
                :density="density"
                :disabled="openEnded"
                clearable
                hint="Після цієї дати агент скаже «вже неактуально»"
                persistent-hint
              />
            </v-col>
          </v-row>

          <v-combobox
            v-model="form.keywords"
            label="Ключові слова"
            :density="density"
            chips
            multiple
            closable-chips
            class="mb-2"
            hint="SMM, UGC, знижка, моделі — для матчу DM і Stories"
            persistent-hint
          />

          <v-select
            v-model="form.onMatch"
            :items="onMatchOptions"
            item-title="title"
            item-value="value"
            label="Що робити при зверненні"
            :density="density"
            class="mb-2"
          />

          <v-select
            v-if="editingId"
            v-model="form.status"
            :items="statusOptions"
            item-title="title"
            item-value="value"
            label="Статус публікації"
            :density="density"
            class="mb-2"
          />

          <v-textarea
            v-model="form.agentInstructions"
            label="Інструкція агенту (необовʼязково)"
            :density="density"
            rows="3"
            auto-grow
            class="mb-2"
            hint="Порожньо — шаблон за типом (для вакансії вже з show_to_client)"
            persistent-hint
          />

          <v-text-field
            v-if="form.onMatch === 'handoff'"
            v-model="form.handoffReason"
            label="Причина для менеджера (Telegram)"
            :density="density"
            class="mb-2"
          />

          <v-text-field
            v-model="form.closedReplyHint"
            label="Що сказати, коли вже неактуально"
            :density="density"
            class="mb-2"
            hint="Напр. «Вакансію вже закрили, але можемо запропонувати запис»"
            persistent-hint
          />
        </v-card-text>

        <v-card-actions class="agent-dialog-footer dialog-actions-stack flex-shrink-0 pa-4">
          <v-btn
            v-if="!editingId"
            variant="tonal"
            class="tap-target"
            :loading="saving"
            :disabled="!canSave"
            block
            @click="save('draft')"
          >
            Зберегти чернетку
          </v-btn>
          <v-btn variant="text" class="tap-target" block @click="dialogOpen = false">
            Скасувати
          </v-btn>
          <v-btn
            color="primary"
            class="tap-target"
            :loading="saving"
            :disabled="!canSave"
            block
            @click="save(editingId ? form.status : 'active')"
          >
            {{ editingId ? 'Зберегти' : 'Опублікувати' }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="snack.open" :color="snack.color" timeout="3500">
      {{ snack.text }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useDisplay } from 'vuetify';
import api from '@/api';
import PageHeader from '@/components/PageHeader.vue';
import ResponsiveDataList from '@/components/ResponsiveDataList.vue';
import MobileListCard from '@/components/MobileListCard.vue';
import { useTouchDensity } from '@/composables/useTouchDensity';
import { useAuthStore } from '@/stores/auth';

type EventKind = 'casting' | 'promo' | 'hiring' | 'collab' | 'other';
type EventStatus = 'draft' | 'active' | 'paused' | 'archived';
type OnMatch = 'inform' | 'handoff' | 'continue_funnel';
type Lifecycle = 'open' | 'scheduled' | 'expired' | 'hidden';

interface TenantEventRow {
  id: string;
  title: string;
  kind: EventKind;
  status: EventStatus;
  lifecycle: Lifecycle;
  eventStartsAt: string | null;
  eventEndsAt: string | null;
  openFrom: string | null;
  openUntil: string | null;
  summary: string;
  details: string;
  keywords: string[];
  agentInstructions: string;
  onMatch: OnMatch;
  handoffReason: string | null;
  closedReplyHint: string | null;
  priority: number;
}

const auth = useAuthStore();
const { mobile } = useDisplay();
const { density } = useTouchDensity();
const isOwner = computed(() => auth.isOwner);

const loading = ref(false);
const saving = ref(false);
const events = ref<TenantEventRow[]>([]);
const tab = ref('live');
const dialogOpen = ref(false);
const editingId = ref<string | null>(null);
const noEventDates = ref(true);
const openEnded = ref(true);
const snack = reactive({ open: false, text: '', color: 'success' });

const kindOptions = [
  { value: 'hiring', title: 'Вакансія / найм' },
  { value: 'promo', title: 'Акція / знижка' },
  { value: 'casting', title: 'Кастинг / моделі' },
  { value: 'collab', title: 'Співпраця / UGC' },
  { value: 'other', title: 'Подія компанії' },
];

const onMatchOptions = [
  { value: 'inform', title: 'Пояснити умови клієнту' },
  { value: 'handoff', title: 'Передати менеджеру (з кастомним текстом)' },
  { value: 'continue_funnel', title: 'Вести до запису / заявки' },
];

const statusOptions = [
  { value: 'draft', title: 'Чернетка' },
  { value: 'active', title: 'Опублікована' },
  { value: 'paused', title: 'На паузі' },
  { value: 'archived', title: 'В архіві' },
];

const headers = [
  { title: 'Подія', key: 'title' },
  { title: 'Тип', key: 'kind' },
  { title: 'Статус', key: 'lifecycle' },
  { title: 'Відгуки до', key: 'openUntil' },
  { title: '', key: 'actions', sortable: false },
];

const emptyForm = () => ({
  title: '',
  kind: 'hiring' as EventKind,
  status: 'active' as EventStatus,
  details: '',
  summary: '',
  eventStartsAt: '',
  eventEndsAt: '',
  openFrom: '',
  openUntil: '',
  keywords: [] as string[],
  onMatch: 'handoff' as OnMatch,
  agentInstructions: '',
  handoffReason: '',
  closedReplyHint: '',
});

const form = reactive(emptyForm());

const canSave = computed(() => form.title.trim().length > 0 && form.details.trim().length > 0);

watch(
  () => form.kind,
  (kind) => {
    if (editingId.value) return;
    if (kind === 'hiring' || kind === 'collab') form.onMatch = 'handoff';
    else if (kind === 'casting') form.onMatch = 'continue_funnel';
    else form.onMatch = 'inform';
  },
);

watch(openEnded, (v) => {
  if (v) form.openUntil = '';
});

const filtered = computed(() => {
  const list = events.value;
  if (tab.value === 'draft') return list.filter((e) => e.status === 'draft');
  if (tab.value === 'ended') {
    return list.filter(
      (e) => e.lifecycle === 'expired' || e.status === 'archived' || e.status === 'paused',
    );
  }
  if (tab.value === 'all') return list;
  return list.filter((e) => e.lifecycle === 'open' || e.lifecycle === 'scheduled');
});

function kindLabel(k: EventKind) {
  return kindOptions.find((o) => o.value === k)?.title ?? k;
}

function lifecycleLabel(item: Pick<TenantEventRow, 'lifecycle' | 'status'>) {
  if (item.status === 'draft') return 'Чернетка';
  if (item.status === 'paused') return 'Пауза';
  if (item.status === 'archived') return 'Архів';
  if (item.lifecycle === 'open') return 'Відкрита';
  if (item.lifecycle === 'scheduled') return 'Запланована';
  if (item.lifecycle === 'expired') return 'Завершена';
  return item.status;
}

function lifecycleColor(item: Pick<TenantEventRow, 'lifecycle' | 'status'>) {
  if (item.status === 'draft' || item.status === 'paused' || item.status === 'archived') {
    return 'grey';
  }
  if (item.lifecycle === 'open') return 'success';
  if (item.lifecycle === 'scheduled') return 'info';
  if (item.lifecycle === 'expired') return 'warning';
  return 'grey';
}

function formatDt(iso: string) {
  try {
    return new Date(iso).toLocaleString('uk-UA', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string): string | null {
  if (!v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function showSnack(text: string, color = 'success') {
  snack.text = text;
  snack.color = color;
  snack.open = true;
}

function resetForm() {
  editingId.value = null;
  Object.assign(form, emptyForm());
  noEventDates.value = true;
  openEnded.value = true;
}

async function load() {
  loading.value = true;
  try {
    const { data } = await api.get<{ events: TenantEventRow[] }>('/events', {
      params: isOwner.value ? { all: '1' } : undefined,
    });
    events.value = data.events ?? [];
  } catch {
    showSnack('Не вдалося завантажити події', 'error');
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  resetForm();
  dialogOpen.value = true;
}

function openEdit(item: TenantEventRow) {
  editingId.value = item.id;
  form.title = item.title;
  form.kind = item.kind;
  form.status = item.status;
  form.details = item.details;
  form.summary = item.summary ?? '';
  form.eventStartsAt = toLocalInput(item.eventStartsAt);
  form.eventEndsAt = toLocalInput(item.eventEndsAt);
  form.openFrom = toLocalInput(item.openFrom);
  form.openUntil = toLocalInput(item.openUntil);
  form.keywords = [...(item.keywords ?? [])];
  form.onMatch = item.onMatch;
  form.agentInstructions = item.agentInstructions ?? '';
  form.handoffReason = item.handoffReason ?? '';
  form.closedReplyHint = item.closedReplyHint ?? '';
  noEventDates.value = !item.eventStartsAt && !item.eventEndsAt;
  openEnded.value = !item.openUntil;
  dialogOpen.value = true;
}

async function save(status?: EventStatus) {
  if (!canSave.value) return;
  saving.value = true;
  try {
    const payload: Record<string, unknown> = {
      title: form.title.trim(),
      kind: form.kind,
      details: form.details.trim(),
      summary: form.summary.trim() || undefined,
      keywords: form.keywords.map((k) => String(k).trim()).filter(Boolean),
      onMatch: form.onMatch,
      agentInstructions: form.agentInstructions.trim() || undefined,
      handoffReason: form.handoffReason.trim() || null,
      closedReplyHint: form.closedReplyHint.trim() || null,
      eventStartsAt: noEventDates.value ? null : fromLocalInput(form.eventStartsAt),
      eventEndsAt: noEventDates.value ? null : fromLocalInput(form.eventEndsAt),
      openFrom: fromLocalInput(form.openFrom),
      openUntil: openEnded.value ? null : fromLocalInput(form.openUntil),
      status: status ?? (editingId.value ? form.status : 'active'),
    };

    if (editingId.value) {
      await api.patch(`/events/${editingId.value}`, payload);
      showSnack('Подію збережено');
    } else {
      await api.post('/events', payload);
      showSnack(status === 'draft' ? 'Чернетку збережено' : 'Подію опубліковано');
    }
    dialogOpen.value = false;
    await load();
  } catch {
    showSnack('Помилка збереження', 'error');
  } finally {
    saving.value = false;
  }
}

async function setStatus(item: TenantEventRow, status: EventStatus) {
  try {
    await api.patch(`/events/${item.id}`, { status });
    showSnack(status === 'active' ? 'Опубліковано' : status === 'paused' ? 'На паузі' : 'Оновлено');
    await load();
  } catch {
    showSnack('Не вдалося змінити статус', 'error');
  }
}

async function duplicate(item: TenantEventRow) {
  try {
    await api.post(`/events/${item.id}/duplicate`);
    showSnack('Створено копію (чернетка)');
    tab.value = 'draft';
    await load();
  } catch {
    showSnack('Не вдалося дублювати', 'error');
  }
}

async function confirmDelete(item: TenantEventRow) {
  if (!window.confirm(`Видалити «${item.title}»?`)) return;
  try {
    await api.delete(`/events/${item.id}`);
    showSnack('Видалено');
    await load();
  } catch {
    showSnack('Не вдалося видалити', 'error');
  }
}

onMounted(() => {
  void load();
});
</script>
