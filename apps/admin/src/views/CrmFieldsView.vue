<template>
  <v-container fluid>
    <v-row class="mb-4" align="center">
      <v-col>
        <div class="page-title">CRM-поля клієнта</div>
        <div class="text-caption text-grey">
          Мапінг локальних ключів на кастомні поля CRM. Активні мапінги додаються до tool
          <code>update_client_info</code> та системного промпту — бот починає їх збирати автоматично.
        </div>
      </v-col>
      <v-col cols="auto">
        <v-btn
          variant="outlined"
          prepend-icon="mdi-refresh"
          :loading="loadingAvailable"
          @click="fetchAvailable(true)"
        >
          Оновити список з CRM
        </v-btn>
      </v-col>
      <v-col cols="auto">
        <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreateDialog">
          Новий мапінг
        </v-btn>
      </v-col>
    </v-row>

    <v-alert v-if="!writeEnabledHint" type="info" variant="tonal" density="compact" class="mb-4">
      Мапінги впливають на бота лише коли в <code>.env</code> виставлено <code>CRM_WRITE_ENABLED=true</code>.
    </v-alert>

    <v-card>
      <v-data-table
        :headers="headers"
        :items="mappings"
        :loading="loading"
        hover
        item-value="id"
      >
        <template #item.localKey="{ item }">
          <code>{{ item.localKey }}</code>
        </template>

        <template #item.scope="{ item }">
          <v-chip size="small" :color="item.scope === 'buyer' ? 'blue' : 'purple'" label>
            {{ item.scope }}
          </v-chip>
        </template>

        <template #item.crmFieldKey="{ item }">
          <code class="text-caption">{{ item.crmFieldKey }}</code>
        </template>

        <template #item.extractType="{ item }">
          <v-chip size="x-small" variant="outlined" label>{{ item.extractType }}</v-chip>
        </template>

        <template #item.isActive="{ item }">
          <v-switch
            :model-value="item.isActive"
            color="primary"
            hide-details
            density="compact"
            :loading="togglingId === item.id"
            @update:model-value="(v) => toggleActive(item, v === true)"
          />
        </template>

        <template #item.actions="{ item }">
          <v-btn
            size="small"
            variant="text"
            icon="mdi-pencil"
            @click="openEditDialog(item)"
          />
          <v-btn
            size="small"
            variant="text"
            icon="mdi-delete-outline"
            color="error"
            @click="confirmDelete(item)"
          />
        </template>

        <template #no-data>
          <div class="pa-6 text-center text-grey">
            Ще немає мапінгів. Натисніть "Новий мапінг", щоб зв'язати кастомне поле CRM з локальним ключем.
          </div>
        </template>
      </v-data-table>
    </v-card>

    <!-- Create / edit dialog -->
    <v-dialog v-model="dialogOpen" max-width="720" persistent>
      <v-card>
        <v-card-title>
          {{ editing ? 'Редагувати мапінг' : 'Новий мапінг' }}
        </v-card-title>

        <v-card-text>
          <v-row dense>
            <v-col cols="12" sm="6">
              <v-select
                v-model="form.scope"
                :items="[
                  { title: 'Клієнт (buyer)', value: 'buyer' },
                  { title: 'Замовлення (order)', value: 'order' },
                ]"
                item-title="title"
                item-value="value"
                label="Scope"
                variant="outlined"
                density="compact"
                :disabled="!!editing"
                @update:model-value="onScopeChange"
              />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="form.localKey"
                label="Local key (snake_case)"
                placeholder="напр. clothing_size"
                variant="outlined"
                density="compact"
                :disabled="!!editing"
                hint="Лише малі літери, цифри, підкреслення. Стабільний — не перейменовуйте."
                persistent-hint
              />
            </v-col>

            <v-col cols="12">
              <v-autocomplete
                v-model="selectedAvailable"
                :items="availableFields"
                :loading="loadingAvailable"
                :item-title="formatAvailable"
                item-value="key"
                label="Кастомне поле в CRM"
                variant="outlined"
                density="compact"
                return-object
                :no-data-text="
                  loadingAvailable
                    ? 'Завантаження...'
                    : availableFields.length === 0
                    ? 'Немає доступних полів у CRM для цього scope'
                    : 'Немає збігів'
                "
                @update:model-value="onAvailablePick"
              />
            </v-col>

            <v-col cols="12" sm="8">
              <v-text-field
                v-model="form.label"
                label="Назва (людям-читача)"
                placeholder="напр. Розмір одягу"
                variant="outlined"
                density="compact"
              />
            </v-col>
            <v-col cols="12" sm="4">
              <v-select
                v-model="form.extractType"
                :items="['text', 'textarea', 'number', 'float', 'select', 'switcher', 'date', 'datetime', 'link']"
                label="Тип"
                variant="outlined"
                density="compact"
              />
            </v-col>

            <v-col v-if="form.extractType === 'select'" cols="12">
              <v-combobox
                v-model="form.options"
                label="Варіанти (для select)"
                multiple
                chips
                closable-chips
                variant="outlined"
                density="compact"
                hint="Enter після кожного значення"
                persistent-hint
              />
            </v-col>

            <v-col cols="12">
              <v-textarea
                v-model="form.promptHint"
                label="Підказка для промпту"
                placeholder="напр. 'Запитай розмір одягу клієнта: XS, S, M, L, XL.'"
                variant="outlined"
                density="compact"
                rows="2"
                auto-grow
                hint="Іде прямо в системний промпт — бот намагатиметься отримати це значення."
                persistent-hint
              />
            </v-col>

            <v-col cols="12">
              <v-switch
                v-model="form.isActive"
                color="primary"
                label="Активний"
                hide-details
                density="compact"
              />
            </v-col>
          </v-row>
        </v-card-text>

        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="saving" @click="dialogOpen = false">
            Скасувати
          </v-btn>
          <v-btn
            color="primary"
            :loading="saving"
            :disabled="!canSave"
            @click="save"
          >
            {{ editing ? 'Зберегти' : 'Створити' }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete confirmation -->
    <v-dialog v-model="deleteDialog" max-width="480">
      <v-card>
        <v-card-title>Видалити мапінг?</v-card-title>
        <v-card-text>
          <code>{{ toDelete?.localKey }}</code> → <code>{{ toDelete?.crmFieldKey }}</code>.
          Бот припинить збирати це поле після наступного turn'а.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="deleteDialog = false">Скасувати</v-btn>
          <v-btn color="error" :loading="deleting" @click="doDelete">Видалити</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-alert v-if="error" type="error" density="compact" class="mt-4">
      {{ error }}
    </v-alert>

    <v-snackbar v-model="snackbar" :color="snackbarColor" :timeout="3000">
      {{ snackbarText }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import api from '@/api';

interface Mapping {
  id: string;
  localKey: string;
  crmFieldKey: string;
  scope: 'buyer' | 'order';
  label: string;
  promptHint: string | null;
  extractType: string;
  options: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AvailableField {
  key: string;
  name: string;
  scope: 'buyer' | 'order';
  type: string;
  options?: string[];
}

const mappings = ref<Mapping[]>([]);
const loading = ref(false);
const error = ref('');

const availableByScope = ref<Record<'buyer' | 'order', AvailableField[]>>({
  buyer: [],
  order: [],
});
const loadingAvailable = ref(false);

const dialogOpen = ref(false);
const editing = ref<Mapping | null>(null);
const saving = ref(false);
const togglingId = ref<string | null>(null);

const deleteDialog = ref(false);
const toDelete = ref<Mapping | null>(null);
const deleting = ref(false);

const snackbar = ref(false);
const snackbarText = ref('');
const snackbarColor = ref('success');

const writeEnabledHint = ref(true); // Info banner stays visible; we don't read envs client-side.

const form = ref({
  localKey: '',
  crmFieldKey: '',
  scope: 'buyer' as 'buyer' | 'order',
  label: '',
  promptHint: '',
  extractType: 'text',
  options: [] as string[],
  isActive: true,
});

const selectedAvailable = ref<AvailableField | null>(null);

const headers = [
  { title: 'Local key', key: 'localKey' },
  { title: 'Label', key: 'label' },
  { title: 'Scope', key: 'scope', width: '100px' },
  { title: 'Тип', key: 'extractType', width: '100px' },
  { title: 'CRM field', key: 'crmFieldKey' },
  { title: 'Активний', key: 'isActive', width: '120px', sortable: false },
  { title: 'Дії', key: 'actions', sortable: false, width: '110px' },
];

const availableFields = computed(() => availableByScope.value[form.value.scope] ?? []);

const canSave = computed(() => {
  const f = form.value;
  if (!f.localKey.trim() || !f.crmFieldKey.trim() || !f.label.trim()) return false;
  if (!/^[a-z][a-z0-9_]*$/.test(f.localKey.trim())) return false;
  return true;
});

function showSnack(text: string, color: 'success' | 'error' = 'success') {
  snackbarText.value = text;
  snackbarColor.value = color;
  snackbar.value = true;
}

function formatAvailable(f: AvailableField): string {
  return `${f.name}  (${f.type}${f.options?.length ? `, ${f.options.length} опцій` : ''})`;
}

async function fetchMappings() {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/crm-fields/mappings');
    mappings.value = Array.isArray(data?.data) ? data.data : [];
  } catch {
    error.value = 'Не вдалося завантажити мапінги';
    mappings.value = [];
  } finally {
    loading.value = false;
  }
}

async function fetchAvailable(force = false) {
  if (!force && availableByScope.value[form.value.scope].length > 0) return;
  loadingAvailable.value = true;
  try {
    // Fetch both scopes so switching the radio doesn't re-hit the CRM.
    const [buyer, order] = await Promise.all([
      api.get('/crm-fields/available', { params: { scope: 'buyer' } }),
      api.get('/crm-fields/available', { params: { scope: 'order' } }),
    ]);
    availableByScope.value = {
      buyer: Array.isArray(buyer.data?.data) ? buyer.data.data : [],
      order: Array.isArray(order.data?.data) ? order.data.data : [],
    };
    if (force) showSnack('Список полів CRM оновлено');
  } catch (e: any) {
    const msg = e.response?.data?.error || 'Не вдалося отримати поля з CRM';
    showSnack(msg, 'error');
  } finally {
    loadingAvailable.value = false;
  }
}

function onScopeChange() {
  selectedAvailable.value = null;
  form.value.crmFieldKey = '';
  fetchAvailable();
}

function onAvailablePick(field: AvailableField | null) {
  if (!field) return;
  form.value.crmFieldKey = field.key;
  if (!form.value.label.trim()) form.value.label = field.name;
  form.value.extractType = field.type || 'text';
  if (Array.isArray(field.options) && field.options.length > 0) {
    form.value.options = [...field.options];
  }
}

function resetForm() {
  form.value = {
    localKey: '',
    crmFieldKey: '',
    scope: 'buyer',
    label: '',
    promptHint: '',
    extractType: 'text',
    options: [],
    isActive: true,
  };
  selectedAvailable.value = null;
  editing.value = null;
}

function openCreateDialog() {
  resetForm();
  fetchAvailable();
  dialogOpen.value = true;
}

function openEditDialog(m: Mapping) {
  editing.value = m;
  form.value = {
    localKey: m.localKey,
    crmFieldKey: m.crmFieldKey,
    scope: m.scope,
    label: m.label,
    promptHint: m.promptHint ?? '',
    extractType: m.extractType,
    options: [...(m.options ?? [])],
    isActive: m.isActive,
  };
  fetchAvailable();
  // Preselect dropdown by matching key.
  selectedAvailable.value =
    availableByScope.value[m.scope]?.find((f) => f.key === m.crmFieldKey) ?? null;
  dialogOpen.value = true;
}

// Keep the autocomplete selection in sync after async available fetch.
watch(
  () => availableByScope.value[form.value.scope],
  (list) => {
    if (!editing.value || selectedAvailable.value) return;
    selectedAvailable.value = list.find((f) => f.key === form.value.crmFieldKey) ?? null;
  },
);

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  error.value = '';
  try {
    if (editing.value) {
      await api.patch(`/crm-fields/mappings/${editing.value.id}`, {
        crmFieldKey: form.value.crmFieldKey.trim(),
        scope: form.value.scope,
        label: form.value.label.trim(),
        promptHint: form.value.promptHint.trim() || null,
        extractType: form.value.extractType,
        options: form.value.options,
        isActive: form.value.isActive,
      });
      showSnack('Мапінг оновлено');
    } else {
      await api.post('/crm-fields/mappings', {
        localKey: form.value.localKey.trim(),
        crmFieldKey: form.value.crmFieldKey.trim(),
        scope: form.value.scope,
        label: form.value.label.trim(),
        promptHint: form.value.promptHint.trim() || null,
        extractType: form.value.extractType,
        options: form.value.options,
        isActive: form.value.isActive,
      });
      showSnack('Мапінг створено');
    }
    dialogOpen.value = false;
    await fetchMappings();
  } catch (e: any) {
    const msg = e.response?.data?.error || 'Не вдалося зберегти мапінг';
    showSnack(msg, 'error');
  } finally {
    saving.value = false;
  }
}

async function toggleActive(m: Mapping, next: boolean) {
  togglingId.value = m.id;
  try {
    await api.patch(`/crm-fields/mappings/${m.id}`, { isActive: next });
    m.isActive = next;
    showSnack(next ? 'Активовано' : 'Деактивовано');
  } catch {
    showSnack('Не вдалося змінити статус', 'error');
  } finally {
    togglingId.value = null;
  }
}

function confirmDelete(m: Mapping) {
  toDelete.value = m;
  deleteDialog.value = true;
}

async function doDelete() {
  if (!toDelete.value) return;
  deleting.value = true;
  try {
    await api.delete(`/crm-fields/mappings/${toDelete.value.id}`);
    deleteDialog.value = false;
    toDelete.value = null;
    await fetchMappings();
    showSnack('Мапінг видалено');
  } catch {
    showSnack('Не вдалося видалити', 'error');
  } finally {
    deleting.value = false;
  }
}

onMounted(() => {
  fetchMappings();
});
</script>

<style scoped>
.page-title {
  font-size: 20px;
  font-weight: 700;
  color: #0a2540;
}
code {
  font-family: 'Roboto Mono', 'Courier New', monospace;
  font-size: 0.85em;
  background: rgba(0, 0, 0, 0.05);
  padding: 1px 4px;
  border-radius: 3px;
}
</style>
