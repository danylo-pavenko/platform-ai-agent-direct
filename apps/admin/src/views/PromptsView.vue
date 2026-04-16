<template>
  <v-container fluid>
    <v-row class="mb-4" align="center">
      <v-col>
        <h1 class="text-h5">Промпти</h1>
      </v-col>
      <v-col cols="auto">
        <v-btn color="primary" prepend-icon="mdi-plus" @click="openNewDialog">
          Нова версія
        </v-btn>
      </v-col>
    </v-row>

    <v-card>
      <v-data-table
        :headers="headers"
        :items="prompts"
        :loading="loading"
        hover
        item-value="id"
        show-expand
      >
        <template #item.version="{ item }">
          <strong>v{{ item.version }}</strong>
        </template>

        <template #item.isActive="{ item }">
          <v-chip
            :color="item.isActive ? 'green' : 'grey'"
            size="small"
            label
          >
            {{ item.isActive ? 'Активний' : 'Неактивний' }}
          </v-chip>
        </template>

        <template #item.createdAt="{ item }">
          {{ formatDate(item.createdAt) }}
        </template>

        <template #item.actions="{ item }">
          <v-btn
            v-if="!item.isActive"
            size="small"
            variant="outlined"
            color="primary"
            :loading="activatingId === item.id"
            @click.stop="activatePrompt(item.id)"
          >
            Активувати
          </v-btn>
        </template>

        <template #expanded-row="{ columns, item }">
          <tr>
            <td :colspan="columns.length" class="pa-4">
              <v-textarea
                :model-value="item.content"
                label="Зміст промпту"
                variant="outlined"
                readonly
                rows="15"
                auto-grow
              />
            </td>
          </tr>
        </template>
      </v-data-table>
    </v-card>

    <!-- New prompt dialog -->
    <v-dialog v-model="dialogOpen" max-width="800" persistent>
      <v-card>
        <v-card-title>Нова версія промпту</v-card-title>
        <v-card-text>
          <v-textarea
            v-model="newContent"
            label="Зміст промпту"
            variant="outlined"
            rows="15"
            auto-grow
            class="mb-3"
          />
          <v-text-field
            v-model="newChangeSummary"
            label="Опис змін"
            variant="outlined"
            hide-details
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="dialogOpen = false" :disabled="saving">
            Скасувати
          </v-btn>
          <v-btn
            color="primary"
            :loading="saving"
            :disabled="!newContent.trim() || !newChangeSummary.trim()"
            @click="createPrompt"
          >
            Зберегти
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-alert v-if="error" type="error" density="compact" class="mt-4">
      {{ error }}
    </v-alert>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import api from '@/api';

interface Prompt {
  id: string;
  version: number;
  content: string;
  changeSummary: string;
  author: string;
  isActive: boolean;
  createdAt: string;
}

const prompts = ref<Prompt[]>([]);
const loading = ref(false);
const error = ref('');

const dialogOpen = ref(false);
const newContent = ref('');
const newChangeSummary = ref('');
const saving = ref(false);
const activatingId = ref<string | null>(null);

const headers = [
  { title: 'Версія', key: 'version', width: '100px' },
  { title: 'Автор', key: 'author' },
  { title: 'Опис змін', key: 'changeSummary' },
  { title: 'Дата', key: 'createdAt', width: '180px' },
  { title: 'Статус', key: 'isActive', width: '130px' },
  { title: 'Дії', key: 'actions', sortable: false, width: '150px' },
];

function formatDate(dateStr: string): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('uk-UA');
}

function openNewDialog() {
  newContent.value = '';
  newChangeSummary.value = '';
  // Pre-fill with latest active prompt content
  const active = prompts.value.find((p) => p.isActive);
  if (active) {
    newContent.value = active.content;
  }
  dialogOpen.value = true;
}

async function fetchPrompts() {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/prompts');
    prompts.value = data.data;
  } catch (e) {
    error.value = 'Не вдалося завантажити промпти';
  } finally {
    loading.value = false;
  }
}

async function createPrompt() {
  saving.value = true;
  error.value = '';
  try {
    await api.post('/prompts', {
      content: newContent.value.trim(),
      changeSummary: newChangeSummary.value.trim(),
    });
    dialogOpen.value = false;
    await fetchPrompts();
  } catch (e) {
    error.value = 'Не вдалося створити промпт';
  } finally {
    saving.value = false;
  }
}

async function activatePrompt(id: string) {
  activatingId.value = id;
  error.value = '';
  try {
    await api.post(`/prompts/${id}/activate`);
    await fetchPrompts();
  } catch (e) {
    error.value = 'Не вдалося активувати промпт';
  } finally {
    activatingId.value = null;
  }
}

onMounted(() => {
  fetchPrompts();
});
</script>
