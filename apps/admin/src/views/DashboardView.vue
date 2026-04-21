<template>
  <div class="dashboard-root">
    <v-container fluid class="dashboard-container">
      <!-- Header -->
      <header class="dash-header">
        <div>
          <h1 class="page-title">Дашборд</h1>
          <p class="page-subtitle dash-subtitle">
            Показники роботи AI-агента та воронка продажів
          </p>
        </div>
        <div class="period-wrap">
          <div class="period-label">Період</div>
          <v-chip-group
            v-model="period"
            mandatory
            selected-class="period-chip--selected"
            class="period-chips"
            @update:model-value="onPeriodChange"
          >
            <v-chip
              v-for="p in periodOptions"
              :key="p.value"
              :value="p.value"
              variant="outlined"
              size="small"
              class="period-chip"
            >
              {{ p.title }}
            </v-chip>
          </v-chip-group>
        </div>
      </header>

      <!-- Health -->
      <div
        class="health-banner"
        :class="healthOk ? 'health-banner--ok' : 'health-banner--warn'"
        role="status"
      >
        <v-icon :icon="healthOk ? 'mdi-check-decagram' : 'mdi-alert-decagram'" size="22" class="health-icon" />
        <div class="health-text">
          <span class="health-title">{{ healthOk ? 'Агент активний' : 'Потрібна увага' }}</span>
          <span class="health-meta">
            Остання відповідь бота: {{ formatRelative(summary?.health?.lastBotReplyAt) }}
            <span class="health-dot">·</span>
            Каталог (sync): {{ formatRelative(summary?.health?.lastCatalogSyncAt) }}
          </span>
        </div>
      </div>

      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4" rounded="lg">
        {{ error }}
      </v-alert>

      <!-- KPI grid -->
      <v-row dense class="kpi-row">
        <v-col cols="12" sm="6" lg="3">
          <div class="kpi-card">
            <div class="kpi-label">Клієнти з повідомленнями</div>
            <div class="kpi-value">{{ loading ? '-' : fmt(t?.clientsContacted) }}</div>
            <div class="kpi-hint">Унікальні клієнти, які писали в обраний період</div>
          </div>
        </v-col>
        <v-col cols="12" sm="6" lg="3">
          <div class="kpi-card kpi-card--accent">
            <div class="kpi-label">Відповіді бота</div>
            <div class="kpi-value">{{ loading ? '-' : fmt(t?.botReplies) }}</div>
            <div class="kpi-hint">Повідомлення відправлені агентом</div>
          </div>
        </v-col>
        <v-col cols="12" sm="6" lg="3">
          <div class="kpi-card">
            <div class="kpi-label">Розмови з активністю</div>
            <div class="kpi-value">{{ loading ? '-' : fmt(t?.conversationsActive) }}</div>
            <div class="kpi-hint">Останнє повідомлення в межах періоду</div>
          </div>
        </v-col>
        <v-col cols="12" sm="6" lg="3">
          <div class="kpi-card">
            <div class="kpi-label">Усього розмов</div>
            <div class="kpi-value">{{ loading ? '-' : fmt(t?.totalConversations) }}</div>
            <div class="kpi-hint">За весь час у базі</div>
          </div>
        </v-col>
      </v-row>

      <!-- Funnel -->
      <section class="section-card">
        <div class="section-head">
          <h2 class="section-title">Воронка та менеджери</h2>
          <p class="section-desc">Замовлення та передачі на людину</p>
        </div>
        <v-row dense>
          <v-col cols="12" sm="6" md="4">
            <div class="funnel-item">
              <span class="funnel-n">{{ loading ? '-' : fmt(t?.ordersInPipeline) }}</span>
              <span class="funnel-l">До продажу</span>
              <span class="funnel-s">Submitted + підтверджені</span>
            </div>
          </v-col>
          <v-col cols="12" sm="6" md="4">
            <div class="funnel-item funnel-item--success">
              <span class="funnel-n">{{ loading ? '-' : fmt(t?.ordersConfirmed) }}</span>
              <span class="funnel-l">Оплата / підтверджені</span>
              <span class="funnel-s">Статус <code>confirmed</code></span>
            </div>
          </v-col>
          <v-col cols="12" sm="6" md="4">
            <div class="funnel-item funnel-item--handoff">
              <span class="funnel-n">{{ loading ? '-' : fmt(t?.handoffConversations) }}</span>
              <span class="funnel-l">На менеджера (розмови)</span>
              <span class="funnel-s">Статус handoff у періоді</span>
            </div>
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <div class="funnel-item">
              <span class="funnel-n">{{ loading ? '-' : fmt(t?.ordersSubmitted) }}</span>
              <span class="funnel-l">Замовлення submitted</span>
            </div>
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <div class="funnel-item">
              <span class="funnel-n">{{ loading ? '-' : fmt(t?.ordersDraft) }}</span>
              <span class="funnel-l">Чернетки</span>
            </div>
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <div class="funnel-item">
              <span class="funnel-n">{{ loading ? '-' : fmt(t?.ordersSentToManager) }}</span>
              <span class="funnel-l">Відправлено менеджеру</span>
              <span class="funnel-s">За датою <code>submitted_to_manager</code></span>
            </div>
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <div class="funnel-item funnel-item--muted">
              <span class="funnel-n">{{ loading ? '-' : fmt(t?.ordersCancelled) }}</span>
              <span class="funnel-l">Скасовано</span>
            </div>
          </v-col>
        </v-row>
        <div class="section-actions">
          <v-btn color="primary" variant="flat" size="small" rounded="lg" :to="{ name: 'orders' }">
            Усі замовлення
          </v-btn>
          <v-btn variant="outlined" size="small" rounded="lg" :to="{ name: 'conversations', query: { state: 'handoff' } }">
            Розмови handoff
          </v-btn>
        </div>
      </section>

      <!-- Leadgen quality & brief KPIs (only when tenant has leadgen data) -->
      <section v-if="showLeadgenSection" class="section-card">
        <div class="section-head">
          <h2 class="section-title">Leadgen — якість брифів і лідів</h2>
          <p class="section-desc">Повнота брифу від агента та ручна оцінка ліда менеджером</p>
        </div>
        <v-row dense>
          <v-col cols="12" sm="6" md="3">
            <div class="kpi-card">
              <div class="kpi-label">Брифів у періоді</div>
              <div class="kpi-value">{{ loading ? '-' : fmt(summary?.briefs?.total) }}</div>
              <div class="kpi-hint">Статус submitted або synced</div>
            </div>
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <div class="kpi-card">
              <div class="kpi-label">Повних брифів (≥ 80%)</div>
              <div class="kpi-value">{{ loading ? '-' : formatPct(summary?.briefs?.highCompletenessRate) }}</div>
              <div class="kpi-hint">
                {{ fmt(summary?.briefs?.highCompleteness) }} з {{ fmt(summary?.briefs?.total) }}
              </div>
            </div>
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <div class="kpi-card">
              <div class="kpi-label">Сер. повнота брифу</div>
              <div class="kpi-value">{{ loading ? '-' : (summary?.briefs?.avgCompletenessPct != null ? `${summary.briefs.avgCompletenessPct}%` : '—') }}</div>
              <div class="kpi-hint">
                Сер. впевненість: {{ summary?.briefs?.avgConfidence ?? '—' }}
              </div>
            </div>
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <div class="kpi-card kpi-card--accent">
              <div class="kpi-label">Сер. якість ліда</div>
              <div class="kpi-value">
                {{ loading ? '-' : (summary?.quality?.avgQuality != null ? `${summary.quality.avgQuality} / 5` : '—') }}
              </div>
              <div class="kpi-hint">
                Оцінено менеджером: {{ fmt(summary?.quality?.rated) }} розмов
              </div>
            </div>
          </v-col>
        </v-row>
      </section>

      <!-- Agent health (LLM latency + success rate) -->
      <section class="section-card">
        <div class="section-head">
          <h2 class="section-title">Здоровʼя агента</h2>
          <p class="section-desc">Латентність відповіді Claude і частка успішних викликів</p>
        </div>

        <v-row dense>
          <v-col cols="12" sm="6" md="3">
            <div class="kpi-card" :class="agentHealthClass">
              <div class="kpi-label">Успішні відповіді</div>
              <div class="kpi-value">{{ agentLoading ? '-' : formatPct(agent?.totals?.successRate) }}</div>
              <div class="kpi-hint">
                {{ agentLoading ? '&nbsp;' : `${fmt(agent?.totals?.successes)} з ${fmt(agent?.totals?.total)}` }}
              </div>
            </div>
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <div class="kpi-card">
              <div class="kpi-label">Медіанна латентність</div>
              <div class="kpi-value">{{ agentLoading ? '-' : formatMs(agent?.totals?.latencyMs?.p50) }}</div>
              <div class="kpi-hint">p50 успішних викликів</div>
            </div>
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <div class="kpi-card">
              <div class="kpi-label">p95 латентність</div>
              <div class="kpi-value">{{ agentLoading ? '-' : formatMs(agent?.totals?.latencyMs?.p95) }}</div>
              <div class="kpi-hint">Хвіст повільних 5%</div>
            </div>
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <div class="kpi-card">
              <div class="kpi-label">Fallback-відповіді</div>
              <div class="kpi-value">{{ agentLoading ? '-' : fmt((agent?.totals?.busy ?? 0) + (agent?.totals?.timeout ?? 0)) }}</div>
              <div class="kpi-hint">
                busy: {{ fmt(agent?.totals?.busy) }} · timeout: {{ fmt(agent?.totals?.timeout) }}
              </div>
            </div>
          </v-col>
        </v-row>

        <div v-if="!agentLoading && (agent?.byChannel?.length ?? 0) > 0" class="agent-channels">
          <div class="agent-channels-head">По каналах</div>
          <div class="agent-channel-row agent-channel-row--header">
            <span class="agent-ch-name">Канал</span>
            <span class="agent-ch-num">Викликів</span>
            <span class="agent-ch-num">Успіх</span>
            <span class="agent-ch-num">p50</span>
            <span class="agent-ch-num">p95</span>
          </div>
          <div
            v-for="row in agent?.byChannel ?? []"
            :key="row.channel"
            class="agent-channel-row"
          >
            <span class="agent-ch-name">
              <span class="agent-ch-dot" :class="`agent-ch-dot--${row.channel}`" />
              {{ channelLabel(row.channel) }}
            </span>
            <span class="agent-ch-num">{{ fmt(row.total) }}</span>
            <span class="agent-ch-num">{{ formatPct(row.successRate) }}</span>
            <span class="agent-ch-num">{{ formatMs(row.latencyMs?.p50) }}</span>
            <span class="agent-ch-num">{{ formatMs(row.latencyMs?.p95) }}</span>
          </div>
        </div>

        <div v-if="!agentLoading && (agent?.totals?.total ?? 0) === 0" class="agent-empty">
          За обраний період немає викликів агента
        </div>

        <v-alert v-if="agentError" type="error" variant="tonal" density="compact" class="mt-3" rounded="lg">
          {{ agentError }}
        </v-alert>
      </section>

      <!-- Activity chart -->
      <section class="section-card chart-card">
        <div class="section-head">
          <h2 class="section-title">Активність</h2>
          <p class="section-desc">Повідомлення клієнтів та відповіді бота по днях</p>
        </div>
        <div v-if="loading" class="chart-loading text-medium-emphasis">Завантаження…</div>
        <div v-else class="chart-body">
          <div class="chart-bars">
            <div
              v-for="(bar, i) in chartBars"
              :key="bar.date"
              class="chart-col"
            >
              <div class="chart-tooltip-host">
                <div
                  class="chart-bar chart-bar--client"
                  :style="{ height: bar.clientH + '%' }"
                />
                <div
                  class="chart-bar chart-bar--bot"
                  :style="{ height: bar.botH + '%' }"
                />
              </div>
              <span class="chart-x" v-if="showTick(i)">{{ shortDate(bar.date) }}</span>
            </div>
          </div>
          <div class="chart-legend">
            <span><i class="dot dot--client" /> Клієнт</span>
            <span><i class="dot dot--bot" /> Бот</span>
          </div>
        </div>
      </section>
    </v-container>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import api from '@/api';

interface Totals {
  clientsContacted: number;
  botReplies: number;
  conversationsActive: number;
  handoffConversations: number;
  ordersDraft: number;
  ordersSubmitted: number;
  ordersConfirmed: number;
  ordersInPipeline: number;
  ordersCancelled: number;
  ordersSentToManager: number;
  totalConversations: number;
}

interface Summary {
  period: string;
  from: string | null;
  to: string;
  totals: Totals;
  briefs: {
    total: number;
    highCompleteness: number;
    highCompletenessRate: number | null;
    avgCompletenessPct: number | null;
    avgConfidence: number | null;
  };
  quality: {
    rated: number;
    avgQuality: number | null;
  };
  health: {
    lastBotReplyAt: string | null;
    lastCatalogSyncAt: string | null;
    botActiveInPeriod: boolean;
    botRecentlyActive: boolean;
  };
  series: Array<{ date: string; botReplies: number; clientMessages: number }>;
}

type AgentChannel = 'ig' | 'tg' | 'sandbox' | 'meta_agent' | 'supervisor';

interface AgentLatency {
  p50: number | null;
  p95: number | null;
  p99?: number | null;
  avg?: number | null;
}

interface AgentAnalytics {
  period: string;
  totals: {
    total: number;
    successes: number;
    failures: number;
    busy: number;
    timeout: number;
    successRate: number | null;
    latencyMs: AgentLatency;
  };
  byChannel: Array<{
    channel: AgentChannel;
    total: number;
    successes: number;
    successRate: number | null;
    latencyMs: AgentLatency;
  }>;
  series: Array<{
    date: string;
    total: number;
    successes: number;
    successRate: number | null;
    latencyMs: AgentLatency;
  }>;
}

const period = ref('7d');
const periodOptions = [
  { title: '24 год', value: '24h' },
  { title: '7 днів', value: '7d' },
  { title: '30 днів', value: '30d' },
  { title: '90 днів', value: '90d' },
  { title: 'Увесь час', value: 'all' },
];

const summary = ref<Summary | null>(null);
const loading = ref(true);
const error = ref('');

const agent = ref<AgentAnalytics | null>(null);
const agentLoading = ref(true);
const agentError = ref('');

const t = computed(() => summary.value?.totals);

const showLeadgenSection = computed(() => {
  const s = summary.value;
  if (!s) return false;
  return (s.briefs?.total ?? 0) > 0 || (s.quality?.rated ?? 0) > 0;
});

const healthOk = computed(() => {
  const h = summary.value?.health;
  if (!h) return false;
  return h.botRecentlyActive || h.botActiveInPeriod;
});

const chartBars = computed(() => {
  const s = summary.value?.series ?? [];
  if (s.length === 0) return [];
  let max = 1;
  for (const row of s) {
    max = Math.max(max, row.botReplies, row.clientMessages);
  }
  return s.map((row) => ({
    date: row.date,
    botH: Math.round((row.botReplies / max) * 100),
    clientH: Math.round((row.clientMessages / max) * 100),
    bot: row.botReplies,
    client: row.clientMessages,
  }));
});

function showTick(i: number): boolean {
  const n = chartBars.value.length;
  if (n <= 8) return true;
  const step = Math.ceil(n / 8);
  return i % step === 0 || i === n - 1;
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

function fmt(n: number | undefined | null): string {
  if (n === undefined || n === null) return '0';
  return new Intl.NumberFormat('uk-UA').format(n);
}

function formatPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${(v * 100).toFixed(v >= 0.995 ? 0 : 1)}%`;
}

function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} мс`;
  return `${(ms / 1000).toFixed(1)} с`;
}

function channelLabel(ch: AgentChannel): string {
  switch (ch) {
    case 'ig': return 'Instagram';
    case 'tg': return 'Telegram';
    case 'sandbox': return 'Sandbox';
    case 'meta_agent': return 'Meta-агент';
    case 'supervisor': return 'Supervisor';
    default: return ch;
  }
}

const agentHealthClass = computed(() => {
  const rate = agent.value?.totals?.successRate;
  if (rate === null || rate === undefined) return '';
  if (rate >= 0.98) return 'kpi-card--accent';
  if (rate < 0.9) return 'kpi-card--warn';
  return '';
});

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'немає даних';
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return 'щойно';
  if (mins < 60) return `${mins} хв тому`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs} год тому`;
  const days = Math.floor(hrs / 24);
  return `${days} дн тому`;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get<Summary>('/dashboard/summary', {
      params: { period: period.value },
    });
    summary.value = data;
  } catch {
    error.value = 'Не вдалося завантажити статистику';
    summary.value = null;
  } finally {
    loading.value = false;
  }
}

async function loadAgent() {
  agentLoading.value = true;
  agentError.value = '';
  try {
    const { data } = await api.get<AgentAnalytics>('/analytics/agent', {
      params: { period: period.value },
    });
    agent.value = data;
  } catch {
    agentError.value = 'Не вдалося завантажити аналітику агента';
    agent.value = null;
  } finally {
    agentLoading.value = false;
  }
}

function onPeriodChange() {
  void load();
  void loadAgent();
}

onMounted(() => {
  void load();
  void loadAgent();
});
</script>

<style scoped>
.dashboard-root {
  min-height: 100%;
  background: linear-gradient(180deg, #f6f9fc 0%, #eef2f7 100%);
}

.dashboard-container {
  max-width: 1200px;
  padding-top: 20px;
  padding-bottom: 32px;
}

.dash-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.dash-subtitle {
  margin-top: 4px;
  max-width: 520px;
}

.period-wrap {
  flex: 1;
  min-width: 0;
  max-width: 100%;
}

.period-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #6c7688;
  margin-bottom: 8px;
}

.period-chips {
  flex-wrap: nowrap;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 4px;
  gap: 6px;
}

.period-chips :deep(.v-slide-group__content) {
  gap: 6px;
}

.period-chip {
  border-color: #d7dee8 !important;
  font-weight: 500;
  flex-shrink: 0;
}

.period-chip--selected {
  background: #0a2540 !important;
  color: #fff !important;
  border-color: #0a2540 !important;
}

.health-banner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 18px;
  border-radius: 12px;
  margin-bottom: 20px;
  border: 1px solid transparent;
}

.health-banner--ok {
  background: #ecfdf5;
  border-color: #a7f3d0;
  color: #065f46;
}

.health-banner--warn {
  background: #fffbeb;
  border-color: #fde68a;
  color: #92400e;
}

.health-banner--warn .health-icon {
  color: #d97706;
}

.health-banner--ok .health-icon {
  color: #059669;
}

.health-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.health-title {
  font-weight: 600;
  font-size: 14px;
  letter-spacing: -0.01em;
}

.health-meta {
  font-size: 12px;
  opacity: 0.9;
  line-height: 1.45;
}

.health-dot {
  margin: 0 4px;
}

.kpi-row {
  margin-bottom: 8px;
}

.kpi-card {
  background: #fff;
  border: 1px solid #e6ebf1;
  border-radius: 12px;
  padding: 18px 18px 16px;
  height: 100%;
  min-height: 118px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  transition: box-shadow 0.15s ease, border-color 0.15s ease;
}

.kpi-card:hover {
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.06);
  border-color: #d7dee8;
}

.kpi-card--accent {
  border-color: rgba(99, 91, 255, 0.35);
  background: linear-gradient(180deg, #fafaff 0%, #fff 100%);
}

.kpi-card--warn {
  border-color: #fecaca;
  background: linear-gradient(180deg, #fff5f5 0%, #fff 100%);
}

.kpi-card--warn .kpi-value {
  color: #b91c1c;
}

.kpi-label {
  font-size: 12px;
  font-weight: 600;
  color: #6c7688;
  letter-spacing: 0.01em;
  margin-bottom: 8px;
}

.kpi-value {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: #0a2540;
  line-height: 1.1;
}

.kpi-hint {
  margin-top: 8px;
  font-size: 11px;
  color: #8898a7;
  line-height: 1.35;
}

.section-card {
  background: #fff;
  border: 1px solid #e6ebf1;
  border-radius: 12px;
  padding: 20px 20px 18px;
  margin-top: 16px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}

.section-head {
  margin-bottom: 16px;
}

.section-title {
  font-size: 15px;
  font-weight: 600;
  color: #0a2540;
  letter-spacing: -0.015em;
  margin: 0;
}

.section-desc {
  font-size: 13px;
  color: #6c7688;
  margin: 4px 0 0;
}

.funnel-item {
  padding: 14px 16px;
  border-radius: 10px;
  background: #f6f9fc;
  border: 1px solid #e6ebf1;
  height: 100%;
}

.funnel-item--success {
  background: #ecfdf5;
  border-color: #bbf7d0;
}

.funnel-item--handoff {
  background: #fff7ed;
  border-color: #fed7aa;
}

.funnel-item--muted {
  opacity: 0.85;
}

.funnel-n {
  display: block;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #0a2540;
}

.funnel-l {
  display: block;
  font-size: 13px;
  font-weight: 600;
  margin-top: 4px;
  color: #3d4d5d;
}

.funnel-s {
  display: block;
  font-size: 11px;
  color: #8898a7;
  margin-top: 4px;
  line-height: 1.35;
}

.funnel-s code {
  font-size: 10px;
}

.section-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid #eef2f6;
}

.chart-card {
  margin-bottom: 8px;
}

.agent-channels {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid #eef2f6;
}

.agent-channels-head {
  font-size: 12px;
  font-weight: 600;
  color: #6c7688;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 10px;
}

.agent-channel-row {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr 1fr;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;
  align-items: center;
}

.agent-channel-row:nth-child(even) {
  background: #f8fafc;
}

.agent-channel-row--header {
  font-size: 11px;
  font-weight: 600;
  color: #8898a7;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: transparent !important;
  padding-bottom: 6px;
  padding-top: 2px;
}

.agent-ch-name {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #0a2540;
  font-weight: 500;
}

.agent-ch-num {
  text-align: right;
  color: #3d4d5d;
  font-variant-numeric: tabular-nums;
}

.agent-ch-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  background: #94a3b8;
}

.agent-ch-dot--ig { background: #e1306c; }
.agent-ch-dot--tg { background: #229ed9; }
.agent-ch-dot--sandbox { background: #8b5cf6; }
.agent-ch-dot--meta_agent { background: #f59e0b; }
.agent-ch-dot--supervisor { background: #10b981; }

.agent-empty {
  margin-top: 12px;
  padding: 16px;
  text-align: center;
  color: #8898a7;
  font-size: 13px;
  background: #f8fafc;
  border-radius: 8px;
}

@media (max-width: 600px) {
  .agent-channel-row {
    grid-template-columns: 1.6fr 1fr 1fr;
    font-size: 12px;
  }

  .agent-channel-row > :nth-child(4),
  .agent-channel-row > :nth-child(5) {
    display: none;
  }
}

.chart-loading {
  padding: 24px 8px;
  text-align: center;
  font-size: 14px;
}

.chart-body {
  padding-top: 8px;
}

.chart-bars {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 160px;
  padding: 0 4px;
  overflow-x: auto;
}

.chart-col {
  flex: 1;
  min-width: 8px;
  max-width: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
}

.chart-tooltip-host {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 2px;
  min-height: 0;
}

.chart-bar {
  width: 42%;
  max-width: 10px;
  border-radius: 4px 4px 0 0;
  min-height: 2px;
  transition: height 0.25s ease;
}

.chart-bar--client {
  background: linear-gradient(180deg, #94a3b8, #64748b);
}

.chart-bar--bot {
  background: linear-gradient(180deg, #a5a0ff, #635bff);
}

.chart-x {
  font-size: 9px;
  color: #8898a7;
  margin-top: 6px;
  white-space: nowrap;
}

.chart-legend {
  display: flex;
  gap: 20px;
  margin-top: 12px;
  font-size: 12px;
  color: #6c7688;
}

.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  margin-right: 6px;
  vertical-align: middle;
}

.dot--client {
  background: #64748b;
}

.dot--bot {
  background: #635bff;
}

@media (max-width: 600px) {
  .kpi-value {
    font-size: 24px;
  }

  .dash-header {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
