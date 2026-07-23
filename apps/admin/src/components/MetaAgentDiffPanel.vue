<template>
  <div class="meta-diff-panel d-flex flex-column" :class="{ 'meta-diff-panel--sheet': sheet }">
    <v-card-title v-if="showTitle" class="text-subtitle-2 pa-3 d-flex align-center flex-wrap ga-2">
      <v-icon start color="warning" size="20">mdi-file-compare</v-icon>
      <span>Пропоновані зміни</span>
      <v-chip v-if="diffs.length > 1" size="x-small" color="warning" variant="tonal">
        {{ diffs.length }} зміни
      </v-chip>
      <v-spacer v-if="sheet" />
      <v-btn
        v-if="sheet"
        icon="mdi-close"
        variant="text"
        size="small"
        @click="$emit('close')"
      />
    </v-card-title>

    <div class="meta-diff-scroll flex-grow-1 overflow-y-auto px-3 pb-3">
      <div
        v-for="(diff, idx) in diffs"
        :key="idx"
        class="diff-item mb-4"
        :class="{ 'diff-item-applied': appliedResults.has(idx) }"
      >
        <div class="d-flex align-center ga-2 mb-2 flex-wrap">
          <span class="text-caption font-weight-bold text-grey">
            {{ diffs.length > 1 ? `ЗМІНА ${idx + 1}` : 'ЗМІНА' }}
          </span>
          <v-chip
            v-if="appliedResults.get(idx)?.activated"
            size="x-small"
            color="success"
            variant="flat"
          >
            <v-icon start size="10">mdi-check</v-icon>
            v{{ appliedResults.get(idx)?.version }} активна
          </v-chip>
          <v-chip
            v-else-if="appliedResults.has(idx)"
            size="x-small"
            color="info"
            variant="tonal"
          >
            <v-icon start size="10">mdi-file-document-edit-outline</v-icon>
            чернетка v{{ appliedResults.get(idx)?.version }}
          </v-chip>
        </div>

        <v-alert v-if="diff.summary" type="info" variant="tonal" density="compact" class="mb-2 text-body-2">
          {{ diff.summary }}
        </v-alert>

        <div class="text-caption font-weight-bold mb-1 text-error d-flex align-center">
          <v-icon size="14" color="error" class="mr-1">mdi-minus-circle</v-icon>
          БУЛО
        </div>
        <pre class="diff-block diff-before mb-2">{{ diff.before || '(порожньо - нове правило)' }}</pre>

        <div class="text-caption font-weight-bold mb-1 text-success d-flex align-center">
          <v-icon size="14" color="success" class="mr-1">mdi-plus-circle</v-icon>
          СТАЛО
        </div>
        <pre class="diff-block diff-after mb-2">{{ diff.after }}</pre>

        <div class="diff-actions d-flex ga-2" :class="stackActions ? 'flex-column' : 'justify-end flex-wrap'">
          <template v-if="!appliedResults.has(idx)">
            <v-btn
              color="primary"
              :size="stackActions ? 'small' : 'x-small'"
              variant="tonal"
              :block="stackActions"
              :loading="applyingIndex === idx"
              :disabled="applyingIndex !== null && applyingIndex !== idx"
              @click="$emit('apply', idx, { activate: false })"
            >
              <v-icon start size="14">mdi-file-document-edit-outline</v-icon>
              Зберегти як чернетку
            </v-btn>
            <v-btn
              color="warning"
              :size="stackActions ? 'small' : 'x-small'"
              variant="outlined"
              :block="stackActions"
              :disabled="applyingIndex !== null"
              @click="$emit('activate-confirm', idx)"
            >
              <v-icon start size="14">mdi-flash</v-icon>
              Зберегти і активувати
            </v-btn>
          </template>
          <v-btn
            v-else-if="!appliedResults.get(idx)?.activated"
            color="warning"
            :size="stackActions ? 'small' : 'x-small'"
            variant="outlined"
            :block="stackActions"
            :loading="activatingPromptId === appliedResults.get(idx)?.promptId"
            :disabled="activatingPromptId !== null"
            @click="$emit('activate-confirm', idx)"
          >
            <v-icon start size="14">mdi-flash</v-icon>
            Активувати зараз
          </v-btn>
        </div>
      </div>
    </div>

    <v-divider />
    <div class="pa-3 meta-diff-footer">
      <div
        v-if="activeBaseVersion !== null"
        class="text-caption text-grey mb-2"
      >
        Зміни застосовуються до активної v{{ activeBaseVersion }}. Чернетки не впливають на прод — активуйте явно.
      </div>
      <div class="d-flex ga-2 align-center" :class="stackActions ? 'flex-column' : ''">
        <v-btn
          variant="outlined"
          size="small"
          :block="stackActions"
          :disabled="applyingIndex !== null"
          @click="$emit('reject')"
        >
          {{ appliedResults.size > 0 ? 'Закрити' : 'Відхилити всі' }}
        </v-btn>
        <v-spacer v-if="!stackActions" />
        <v-btn
          v-if="unappliedCount > 1"
          color="primary"
          size="small"
          variant="tonal"
          :block="stackActions"
          :loading="applyingIndex !== null || batchApplying"
          :disabled="batchApplying"
          @click="$emit('apply-all')"
        >
          <v-icon start size="16">mdi-check-all</v-icon>
          Зберегти всі як чернетки ({{ unappliedCount }})
        </v-btn>
        <v-btn
          v-if="unappliedCount > 0"
          color="info"
          size="small"
          variant="outlined"
          :block="stackActions"
          :loading="batchApplying"
          :disabled="applyingIndex !== null"
          @click="$emit('save-and-sandbox')"
        >
          <v-icon start size="16">mdi-flask-outline</v-icon>
          Зберегти і відкрити пісочницю
        </v-btn>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface SuggestedDiff {
  before: string;
  after: string;
  summary: string;
}

interface AppliedResult {
  promptId: string;
  version: number;
  activated: boolean;
}

withDefaults(defineProps<{
  diffs: SuggestedDiff[];
  appliedResults: Map<number, AppliedResult>;
  applyingIndex: number | null;
  activatingPromptId: string | null;
  activeBaseVersion: number | null;
  unappliedCount: number;
  sheet?: boolean;
  showTitle?: boolean;
  stackActions?: boolean;
  batchApplying?: boolean;
}>(), {
  batchApplying: false,
});

defineEmits<{
  apply: [idx: number, opts: { activate: boolean }];
  'activate-confirm': [idx: number];
  reject: [];
  'apply-all': [];
  'save-and-sandbox': [];
  close: [];
}>();
</script>

<style scoped>
.meta-diff-panel {
  min-height: 0;
}

.meta-diff-panel--sheet {
  max-height: 85dvh;
}

.meta-diff-scroll {
  min-height: 0;
}

.meta-diff-footer {
  flex-shrink: 0;
  padding-bottom: max(12px, env(safe-area-inset-bottom));
}

.diff-block {
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Roboto Mono', 'Courier New', monospace;
  max-height: min(200px, 28dvh);
  overflow-y: auto;
}

.diff-before {
  background-color: #fef2f2;
  border: 1px solid #fecaca;
}

.diff-after {
  background-color: #f0fdf4;
  border: 1px solid #bbf7d0;
}

.diff-actions .v-btn {
  min-height: 40px;
}
</style>
