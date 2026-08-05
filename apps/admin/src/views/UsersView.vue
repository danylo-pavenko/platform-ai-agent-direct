<template>
  <v-container fluid>
    <v-row class="mb-4" align="center">
      <v-col>
        <div class="page-title">Користувачі</div>
        <div class="text-body-2 text-medium-emphasis">
          Менеджери з обмеженим доступом до панелі. Логін і пароль генеруються автоматично.
        </div>
      </v-col>
      <v-col cols="auto">
        <v-btn color="primary" prepend-icon="mdi-account-plus" @click="openCreate">
          Додати менеджера
        </v-btn>
      </v-col>
    </v-row>

    <v-alert v-if="error" type="error" density="compact" class="mb-4" closable @click:close="error = ''">
      {{ error }}
    </v-alert>

    <v-card>
      <v-data-table
        :headers="headers"
        :items="users"
        :loading="loading"
        hover
        item-value="id"
      >
        <template #item.displayName="{ item }">
          <div class="text-body-2 font-weight-medium">
            {{ item.displayName || '—' }}
          </div>
          <div class="text-caption text-medium-emphasis">{{ item.username }}</div>
        </template>

        <template #item.role="{ item }">
          <v-select
            :model-value="item.role"
            :items="roleOptions"
            item-title="title"
            item-value="value"
            density="compact"
            variant="outlined"
            hide-details
            style="max-width: 150px"
            :disabled="roleSavingId === item.id || isLastActiveOwner(item)"
            :loading="roleSavingId === item.id"
            @update:model-value="(v: string) => changeRole(item, v)"
          />
        </template>

        <template #item.telegram="{ item }">
          <div v-if="item.tgUserId" class="text-body-2">
            <span v-if="item.tgUsername">@{{ item.tgUsername }}</span>
            <span v-else class="text-medium-emphasis">привʼязано</span>
            <div class="text-caption text-medium-emphasis">id {{ item.tgUserId }}</div>
          </div>
          <span v-else class="text-caption text-medium-emphasis">не привʼязано</span>
        </template>

        <template #item.isActive="{ item }">
          <v-switch
            :model-value="item.isActive"
            :disabled="isLastActiveOwner(item) || togglingId === item.id"
            :loading="togglingId === item.id"
            color="success"
            density="compact"
            hide-details
            inset
            @update:model-value="(v: boolean | null) => toggleActive(item, !!v)"
          />
        </template>

        <template #item.actions="{ item }">
          <div class="d-flex flex-wrap ga-1">
            <v-btn
              size="small"
              variant="tonal"
              prepend-icon="mdi-send"
              :disabled="!item.isActive"
              :loading="linkCodeLoadingId === item.id"
              @click="generateLinkCode(item)"
            >
              Telegram
            </v-btn>
            <v-btn
              size="small"
              variant="text"
              prepend-icon="mdi-lock-reset"
              :loading="resetLoadingId === item.id"
              @click="resetPassword(item)"
            >
              Пароль
            </v-btn>
            <v-btn
              size="small"
              variant="text"
              prepend-icon="mdi-pencil"
              @click="openEdit(item)"
            >
              Імʼя
            </v-btn>
          </div>
        </template>
      </v-data-table>
    </v-card>

    <v-dialog v-model="createOpen" max-width="480" persistent>
      <v-card>
        <v-card-title>Новий менеджер</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="createName"
            label="Імʼя (як показувати в діалогах)"
            variant="outlined"
            density="compact"
            hint="Можна змінити пізніше"
            persistent-hint
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="creating" @click="createOpen = false">Скасувати</v-btn>
          <v-btn color="primary" :loading="creating" @click="createUser">Створити</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="credsOpen" max-width="520" persistent>
      <v-card>
        <v-card-title>Дані для входу</v-card-title>
        <v-card-text>
          <v-alert type="warning" variant="tonal" density="compact" class="mb-3">
            Пароль показується лише зараз. Скопіюйте і передайте менеджеру безпечним каналом.
          </v-alert>
          <div class="text-body-2 mb-2">
            Логін: <code class="cred">{{ credsUsername }}</code>
            <v-btn size="x-small" variant="text" icon="mdi-content-copy" @click="copyText(credsUsername)" />
          </div>
          <div class="text-body-2">
            Пароль: <code class="cred">{{ credsPassword }}</code>
            <v-btn size="x-small" variant="text" icon="mdi-content-copy" @click="copyText(credsPassword)" />
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn color="primary" @click="credsOpen = false">Зрозуміло</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="linkOpen" max-width="520">
      <v-card>
        <v-card-title>Привʼязка Telegram</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-3">
            Менеджер має надіслати боту команду (код дійсний ~15 хв):
          </p>
          <div class="d-flex align-center ga-2">
            <code class="cred flex-grow-1">{{ linkCommand }}</code>
            <v-btn size="small" variant="tonal" prepend-icon="mdi-content-copy" @click="copyText(linkCommand)">
              Копіювати
            </v-btn>
          </div>
          <div v-if="linkExpiresAt" class="text-caption text-medium-emphasis mt-2">
            Дійсний до {{ formatExpiry(linkExpiresAt) }}
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn color="primary" @click="linkOpen = false">Закрити</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="editOpen" max-width="480">
      <v-card>
        <v-card-title>Імʼя користувача</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="editName"
            label="Відображуване імʼя"
            variant="outlined"
            density="compact"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="savingEdit" @click="editOpen = false">Скасувати</v-btn>
          <v-btn color="primary" :loading="savingEdit" @click="saveEdit">Зберегти</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import api from '@/api';

interface AdminUserRow {
  id: string;
  username: string;
  role: string;
  displayName: string | null;
  tgUserId: string | null;
  tgUsername: string | null;
  isActive: boolean;
}

const users = ref<AdminUserRow[]>([]);
const loading = ref(false);
const error = ref('');

const createOpen = ref(false);
const createName = ref('');
const creating = ref(false);

const credsOpen = ref(false);
const credsUsername = ref('');
const credsPassword = ref('');

const linkOpen = ref(false);
const linkCommand = ref('');
const linkExpiresAt = ref('');
const linkCodeLoadingId = ref<string | null>(null);

const editOpen = ref(false);
const editId = ref<string | null>(null);
const editName = ref('');
const savingEdit = ref(false);

const togglingId = ref<string | null>(null);
const resetLoadingId = ref<string | null>(null);
const roleSavingId = ref<string | null>(null);

const roleOptions = [
  { title: 'Власник', value: 'owner' },
  { title: 'Менеджер', value: 'manager' },
];

const headers = [
  { title: 'Користувач', key: 'displayName', sortable: false },
  { title: 'Роль', key: 'role', sortable: false, width: '160px' },
  { title: 'Telegram', key: 'telegram', sortable: false, width: '180px' },
  { title: 'Активний', key: 'isActive', sortable: false, width: '110px' },
  { title: 'Дії', key: 'actions', sortable: false, width: '280px' },
];

function activeOwnerCount() {
  return users.value.filter((u) => u.role === 'owner' && u.isActive).length;
}

function isLastActiveOwner(item: AdminUserRow) {
  return item.role === 'owner' && item.isActive && activeOwnerCount() <= 1;
}

async function fetchUsers() {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/admin/users');
    users.value = data.data ?? [];
  } catch (err: unknown) {
    error.value = extractError(err) || 'Не вдалося завантажити користувачів';
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  createName.value = '';
  createOpen.value = true;
}

async function createUser() {
  creating.value = true;
  error.value = '';
  try {
    const { data } = await api.post('/admin/users', {
      displayName: createName.value.trim() || undefined,
    });
    createOpen.value = false;
    credsUsername.value = data.user.username;
    credsPassword.value = data.password;
    credsOpen.value = true;
    await fetchUsers();
  } catch (err: unknown) {
    error.value = extractError(err) || 'Не вдалося створити користувача';
  } finally {
    creating.value = false;
  }
}

function openEdit(item: AdminUserRow) {
  editId.value = item.id;
  editName.value = item.displayName ?? '';
  editOpen.value = true;
}

async function saveEdit() {
  if (!editId.value) return;
  savingEdit.value = true;
  try {
    await api.patch(`/admin/users/${editId.value}`, {
      displayName: editName.value.trim() || null,
    });
    editOpen.value = false;
    await fetchUsers();
  } catch (err: unknown) {
    error.value = extractError(err) || 'Не вдалося зберегти';
  } finally {
    savingEdit.value = false;
  }
}

async function toggleActive(item: AdminUserRow, isActive: boolean) {
  if (!isActive && isLastActiveOwner(item)) {
    error.value = 'Не можна вимкнути останнього активного власника.';
    return;
  }
  togglingId.value = item.id;
  try {
    await api.patch(`/admin/users/${item.id}`, { isActive });
    await fetchUsers();
  } catch (err: unknown) {
    error.value = extractError(err) || 'Не вдалося змінити статус';
  } finally {
    togglingId.value = null;
  }
}

async function changeRole(item: AdminUserRow, role: string) {
  if (role === item.role) return;
  if (item.role === 'owner' && role === 'manager' && isLastActiveOwner(item)) {
    error.value = 'Не можна знизити роль останнього активного власника.';
    return;
  }
  roleSavingId.value = item.id;
  try {
    await api.patch(`/admin/users/${item.id}`, { role });
    await fetchUsers();
  } catch (err: unknown) {
    error.value = extractError(err) || 'Не вдалося змінити роль';
  } finally {
    roleSavingId.value = null;
  }
}

async function resetPassword(item: AdminUserRow) {
  if (!confirm(`Згенерувати новий пароль для ${item.username}?`)) return;
  resetLoadingId.value = item.id;
  try {
    const { data } = await api.patch(`/admin/users/${item.id}`, { resetPassword: true });
    credsUsername.value = data.user.username;
    credsPassword.value = data.password;
    credsOpen.value = true;
  } catch (err: unknown) {
    error.value = extractError(err) || 'Не вдалося скинути пароль';
  } finally {
    resetLoadingId.value = null;
  }
}

async function generateLinkCode(item: AdminUserRow) {
  linkCodeLoadingId.value = item.id;
  try {
    const { data } = await api.post(`/admin/users/${item.id}/telegram-link-code`);
    linkCommand.value = data.command || `/link ${data.code}`;
    linkExpiresAt.value = data.expiresAt || '';
    linkOpen.value = true;
  } catch (err: unknown) {
    error.value = extractError(err) || 'Не вдалося згенерувати код';
  } finally {
    linkCodeLoadingId.value = null;
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}

function formatExpiry(iso: string) {
  try {
    return new Date(iso).toLocaleString('uk-UA');
  } catch {
    return iso;
  }
}

function extractError(err: unknown): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const data = (err as { response?: { data?: { error?: string; code?: string } } }).response
      ?.data;
    if (data?.error) return data.error;
  }
  return '';
}

onMounted(fetchUsers);
</script>

<style scoped>
.cred {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  background: rgba(0, 0, 0, 0.04);
  padding: 4px 8px;
  border-radius: 6px;
}
</style>
