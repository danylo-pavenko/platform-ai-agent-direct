<template>
  <v-card class="mb-4" id="settings-branches">
    <v-card-title class="d-flex align-center flex-wrap ga-2">
      <v-icon start color="deep-purple">mdi-store-marker</v-icon>
      <span>Філії / локації</span>
      <v-chip size="small" variant="tonal" color="deep-purple">
        {{ branches.length }}
      </v-chip>
    </v-card-title>
    <v-card-subtitle class="pb-2">
      Одна Instagram-сторінка — кілька адрес. Внутрішній slug для агента, зовнішня назва для клієнта,
      ключові слова для розпізнавання району. Решту сценарію — у системному промпті.
    </v-card-subtitle>
    <v-card-text>
      <v-alert
        v-if="crmHint"
        type="info"
        variant="tonal"
        density="compact"
        class="mb-4 text-body-2"
      >
        {{ crmHint }}
        <template v-if="crmCandidates.length > 0">
          <div class="mt-3">
            <v-checkbox
              v-for="c in crmCandidates"
              :key="c.externalId"
              v-model="selectedCrmIds"
              :label="`${c.name}${c.address ? ` — ${c.address}` : ''}`"
              :value="c.externalId"
              density="compact"
              hide-details
              class="mb-1"
            />
            <div class="d-flex flex-wrap ga-2 mt-2">
              <v-btn
                size="small"
                variant="text"
                @click="selectedCrmIds = crmCandidates.map((c) => c.externalId)"
              >
                Усі
              </v-btn>
              <v-btn
                size="small"
                color="deep-purple"
                variant="tonal"
                :loading="importing"
                :disabled="selectedCrmIds.length === 0"
                @click="importSelectedFromCrm"
              >
                Імпортувати вибрані ({{ selectedCrmIds.length }})
              </v-btn>
              <v-btn
                size="small"
                variant="tonal"
                :loading="importing"
                @click="importAllFromCrm"
              >
                Імпортувати всі {{ crmCandidates.length }}
              </v-btn>
            </div>
          </div>
        </template>
      </v-alert>

      <v-alert v-if="error" type="error" density="compact" class="mb-3" closable @click:close="error = ''">
        {{ error }}
      </v-alert>
      <v-alert v-if="success" type="success" density="compact" class="mb-3" closable @click:close="success = ''">
        {{ success }}
      </v-alert>

      <v-table density="compact" class="mb-4 branches-table">
        <thead>
          <tr>
            <th>Slug</th>
            <th>Для клієнта</th>
            <th>Ключові слова</th>
            <th>CRM</th>
            <th class="text-center">Активна</th>
            <th class="text-center">За замовч.</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="7" class="text-center pa-4">
              <v-progress-circular indeterminate size="24" />
            </td>
          </tr>
          <tr v-else-if="branches.length === 0">
            <td colspan="7" class="text-medium-emphasis pa-4 text-center">
              Філії ще не додані. Створіть вручну або імпортуйте з CRM.
            </td>
          </tr>
          <tr v-for="b in branches" :key="b.id">
            <td><code>{{ b.slug }}</code></td>
            <td>
              <div>{{ b.displayName }}</div>
              <div v-if="b.address" class="text-caption text-medium-emphasis">{{ b.address }}</div>
            </td>
            <td>
              <v-chip
                v-for="kw in b.keywords"
                :key="kw"
                size="x-small"
                class="mr-1 mb-1"
                variant="outlined"
              >
                {{ kw }}
              </v-chip>
              <span v-if="!b.keywords?.length" class="text-grey">—</span>
            </td>
            <td>
              <v-chip v-if="b.crmExternalId" size="x-small" variant="tonal">
                {{ b.crmProvider }} #{{ b.crmExternalId }}
              </v-chip>
              <span v-else class="text-grey">вручну</span>
            </td>
            <td class="text-center">
              <v-icon :color="b.isActive ? 'success' : 'grey'" size="18">
                {{ b.isActive ? 'mdi-check-circle' : 'mdi-close-circle-outline' }}
              </v-icon>
            </td>
            <td class="text-center">
              <v-icon v-if="b.isDefault" color="amber-darken-2" size="18">mdi-star</v-icon>
              <span v-else class="text-grey">—</span>
            </td>
            <td class="text-right">
              <v-btn icon size="x-small" variant="text" @click="openEdit(b)">
                <v-icon size="18">mdi-pencil</v-icon>
              </v-btn>
              <v-btn icon size="x-small" variant="text" color="error" @click="removeBranch(b)">
                <v-icon size="18">mdi-delete-outline</v-icon>
              </v-btn>
            </td>
          </tr>
        </tbody>
      </v-table>

      <v-btn color="deep-purple" variant="tonal" prepend-icon="mdi-plus" @click="openCreate">
        Додати філію
      </v-btn>
    </v-card-text>

    <v-dialog v-model="dialog" max-width="560" persistent>
      <v-card>
        <v-card-title>{{ editingId ? 'Редагувати філію' : 'Нова філія' }}</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="form.slug"
            label="Внутрішній slug"
            hint="Латиниця, для агента: obolon, center"
            :disabled="!!editingId"
            persistent-hint
            class="mb-2"
          />
          <v-text-field
            v-model="form.displayName"
            label="Назва для клієнта"
            class="mb-2"
          />
          <v-text-field
            v-model="form.address"
            label="Адреса (опційно)"
            class="mb-2"
          />
          <v-combobox
            v-model="form.keywords"
            label="Ключові слова"
            hint="Оболонь, ТЦ, метро…"
            multiple
            chips
            closable-chips
            persistent-hint
            class="mb-2"
          />
          <v-text-field
            v-model.number="form.sortOrder"
            label="Порядок сортування"
            type="number"
            min="0"
            class="mb-2"
          />
          <v-switch v-model="form.isActive" label="Активна" color="success" hide-details class="mb-1" />
          <v-switch v-model="form.isDefault" label="За замовчуванням" color="amber-darken-2" hide-details />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="dialog = false">Скасувати</v-btn>
          <v-btn color="primary" :loading="saving" @click="saveBranch">Зберегти</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import api from '@/api';

interface BranchRow {
  id: string;
  slug: string;
  displayName: string;
  keywords: string[];
  address?: string | null;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
  crmProvider?: string | null;
  crmExternalId?: string | null;
  source: string;
}

const branches = ref<BranchRow[]>([]);
const loading = ref(false);
const saving = ref(false);
const importing = ref(false);
const error = ref('');
const success = ref('');
const crmHint = ref('');
const crmCandidates = ref<Array<{ externalId: string; name: string; address?: string }>>([]);
const selectedCrmIds = ref<string[]>([]);

const dialog = ref(false);
const editingId = ref<string | null>(null);
const form = ref({
  slug: '',
  displayName: '',
  address: '',
  keywords: [] as string[],
  sortOrder: 0,
  isActive: true,
  isDefault: false,
});

async function fetchBranches() {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/branches');
    branches.value = data.branches ?? [];
  } catch {
    error.value = 'Не вдалося завантажити філії';
  } finally {
    loading.value = false;
  }
}

async function fetchCrmCandidates() {
  try {
    const { data } = await api.get('/branches/crm-candidates');
    crmHint.value = data.hint ?? '';
    crmCandidates.value = data.branches ?? [];
    selectedCrmIds.value = crmCandidates.value.map((c) => c.externalId);
  } catch {
    crmHint.value = '';
    crmCandidates.value = [];
  }
}

function openCreate() {
  editingId.value = null;
  form.value = {
    slug: '',
    displayName: '',
    address: '',
    keywords: [],
    sortOrder: branches.value.length,
    isActive: true,
    isDefault: branches.value.length === 0,
  };
  dialog.value = true;
}

function openEdit(b: BranchRow) {
  editingId.value = b.id;
  form.value = {
    slug: b.slug,
    displayName: b.displayName,
    address: b.address ?? '',
    keywords: [...(b.keywords ?? [])],
    sortOrder: b.sortOrder,
    isActive: b.isActive,
    isDefault: b.isDefault,
  };
  dialog.value = true;
}

async function saveBranch() {
  saving.value = true;
  error.value = '';
  try {
    const payload = {
      ...form.value,
      keywords: form.value.keywords.filter(Boolean),
      address: form.value.address || undefined,
    };
    if (editingId.value) {
      const { slug: _s, ...update } = payload;
      await api.put(`/branches/${editingId.value}`, update);
      success.value = 'Філію оновлено';
    } else {
      await api.post('/branches', payload);
      success.value = 'Філію створено';
    }
    dialog.value = false;
    await fetchBranches();
  } catch (e: unknown) {
    const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
    error.value = typeof msg === 'string' ? msg : 'Помилка збереження';
  } finally {
    saving.value = false;
  }
}

async function removeBranch(b: BranchRow) {
  if (!confirm(`Видалити філію «${b.displayName}»?`)) return;
  try {
    await api.delete(`/branches/${b.id}`);
    success.value = 'Філію видалено';
    await fetchBranches();
  } catch {
    error.value = 'Не вдалося видалити';
  }
}

async function importSelectedFromCrm() {
  if (selectedCrmIds.value.length === 0) return;
  importing.value = true;
  error.value = '';
  try {
    const { data } = await api.post('/branches/import-from-crm', {
      externalIds: selectedCrmIds.value,
    });
    success.value = `Імпорт: +${data.imported}, оновлено ${data.updated}, пропущено ${data.skipped ?? 0}`;
    await fetchBranches();
    await fetchCrmCandidates();
  } catch {
    error.value = 'Помилка імпорту з CRM';
  } finally {
    importing.value = false;
  }
}

async function importAllFromCrm() {
  importing.value = true;
  error.value = '';
  try {
    const { data } = await api.post('/branches/import-from-crm', {});
    success.value = `Імпорт: +${data.imported}, оновлено ${data.updated}`;
    await fetchBranches();
    await fetchCrmCandidates();
  } catch {
    error.value = 'Помилка імпорту з CRM';
  } finally {
    importing.value = false;
  }
}

onMounted(() => {
  fetchBranches();
  fetchCrmCandidates();
});
</script>

<style scoped>
.branches-table :deep(th) {
  white-space: nowrap;
}
</style>
