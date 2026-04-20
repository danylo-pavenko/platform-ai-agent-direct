<template>
  <v-container fluid>
    <v-row class="mb-4" align="center">
      <v-col>
        <div class="page-title">Налаштування</div>
      </v-col>
    </v-row>

    <div v-if="loading" class="d-flex justify-center pa-8">
      <v-progress-circular indeterminate color="primary" />
    </div>

    <template v-else>
      <!-- AI Agent mode -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start color="primary">mdi-robot</v-icon>
          Режим роботи AI-агента
        </v-card-title>
        <v-card-text>
          <v-alert type="info" variant="tonal" density="compact" class="mb-4">
            AI-агент може працювати <strong>24/7</strong> без перерв. Робочі години впливають лише на те,
            чи відповідає бот автоматично, чи надсилає шаблон "ми зараз не працюємо".
          </v-alert>

          <v-radio-group v-model="agentMode" @update:model-value="onModeChange">
            <v-radio value="24_7">
              <template #label>
                <div>
                  <strong>24/7 - Агент відповідає завжди</strong>
                  <div class="text-caption text-medium-emphasis">
                    Бот обробляє повідомлення цілодобово. Клієнти отримують відповідь миттєво в будь-який час.
                  </div>
                </div>
              </template>
            </v-radio>
            <v-radio value="schedule" class="mt-2">
              <template #label>
                <div>
                  <strong>За розкладом - Агент працює у робочі години</strong>
                  <div class="text-caption text-medium-emphasis">
                    Поза робочими годинами клієнти отримують шаблонне повідомлення.
                    Якщо розмова вже активна (повідомлення за останні 30 хв) - бот продовжує відповідати.
                  </div>
                </div>
              </template>
            </v-radio>
          </v-radio-group>
        </v-card-text>
      </v-card>

      <!-- Working hours (shown only in schedule mode) -->
      <v-card v-if="agentMode === 'schedule'" class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start>mdi-clock-outline</v-icon>
          Робочі години
        </v-card-title>
        <v-card-subtitle class="pb-2">
          Графік, коли бот відповідає автоматично. Поза цими годинами - надсилає шаблон.
        </v-card-subtitle>
        <v-card-text>
          <v-row
            v-for="day in days"
            :key="day.key"
            dense
            align="center"
            class="mb-1"
          >
            <v-col cols="12" sm="2" class="text-body-1 font-weight-medium">
              {{ day.label }}
            </v-col>
            <v-col cols="4" sm="2">
              <v-switch
                v-model="workingHours[day.key].enabled"
                :label="workingHours[day.key].enabled ? 'Працює' : 'Вихідний'"
                hide-details
                density="compact"
                color="primary"
              />
            </v-col>
            <v-col cols="3" sm="2">
              <v-text-field
                v-model="workingHours[day.key].start"
                label="Початок"
                type="time"
                variant="outlined"
                density="compact"
                hide-details
                :disabled="!workingHours[day.key].enabled"
              />
            </v-col>
            <v-col cols="1" sm="1" class="text-center text-body-2">-</v-col>
            <v-col cols="3" sm="2">
              <v-text-field
                v-model="workingHours[day.key].end"
                label="Кінець"
                type="time"
                variant="outlined"
                density="compact"
                hide-details
                :disabled="!workingHours[day.key].enabled"
              />
            </v-col>
            <v-col v-if="workingHours[day.key].enabled" cols="12" sm="3" class="text-caption text-medium-emphasis">
              {{ hoursPerDay(workingHours[day.key]) }}
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- Out-of-hours template -->
      <v-card v-if="agentMode === 'schedule'" class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start>mdi-message-text-clock</v-icon>
          Повідомлення поза робочим часом
        </v-card-title>
        <v-card-subtitle class="pb-2">
          Текст, який отримає клієнт, якщо напише поза робочими годинами (і розмова не була активна останні 30 хв).
        </v-card-subtitle>
        <v-card-text>
          <v-textarea
            v-model="outOfHoursTemplate"
            variant="outlined"
            rows="3"
            auto-grow
            hide-details
            placeholder="Дякуємо за повідомлення! Зараз ми не на зв'язку. Відповімо вам у робочий час."
          />
        </v-card-text>
      </v-card>

      <!-- Handoff keywords -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start>mdi-account-switch</v-icon>
          Передача менеджеру
        </v-card-title>
        <v-card-subtitle class="pb-2">
          Ключові слова, при яких бот автоматично передає розмову менеджеру. AI-агент також сам визначає потребу в ескалації.
        </v-card-subtitle>
        <v-card-text>
          <v-text-field
            v-model="handoffKeywords"
            variant="outlined"
            hide-details
            placeholder="менеджер, оператор, людина, скарга, повернення"
          />
          <div class="text-caption text-medium-emphasis mt-1">Через кому. Приклад: менеджер, оператор, людина, скарга</div>
        </v-card-text>
      </v-card>

      <!-- Feature flags -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start>mdi-toggle-switch</v-icon>
          Додаткові опції
        </v-card-title>
        <v-card-text>
          <v-switch
            v-model="featureFlags.auto_handoff"
            color="primary"
            hide-details
            class="mb-3"
          >
            <template #label>
              <div>
                <strong>Автоматична ескалація</strong>
                <div class="text-caption text-medium-emphasis">
                  Бот сам вирішує, коли передати розмову менеджеру (скарга, брак, невпевненість у відповіді).
                </div>
              </div>
            </template>
          </v-switch>
          <v-switch
            v-model="featureFlags.send_typing_indicator"
            color="primary"
            hide-details
          >
            <template #label>
              <div>
                <strong>Індикатор набору</strong>
                <div class="text-caption text-medium-emphasis">
                  Показувати "друкує..." в Instagram, поки бот формує відповідь.
                </div>
              </div>
            </template>
          </v-switch>
        </v-card-text>
      </v-card>

      <!-- Save button (agent settings) -->
      <v-row class="mb-8">
        <v-col cols="auto">
          <v-btn
            color="primary"
            size="large"
            :loading="saving"
            @click="saveSettings"
          >
            <v-icon start>mdi-content-save</v-icon>
            Зберегти налаштування
          </v-btn>
        </v-col>
      </v-row>

      <v-divider class="mb-6" />

      <!-- ── Integrations ── -->
      <div class="page-title mb-1" style="font-size:16px;">Інтеграції</div>

      <!-- Meta / Instagram -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start color="blue-darken-1">mdi-instagram</v-icon>
          Meta / Instagram
        </v-card-title>
        <v-card-subtitle class="pb-2">Facebook App та Instagram Page для Messenger API</v-card-subtitle>
        <v-card-text>
          <!-- Instructions -->
          <v-btn
            variant="text"
            size="small"
            color="info"
            class="mb-3 px-1"
            :prepend-icon="showMetaHelp ? 'mdi-chevron-up' : 'mdi-help-circle-outline'"
            @click="showMetaHelp = !showMetaHelp"
          >
            Де взяти ці дані? Натисни тут.
          </v-btn>
          <v-expand-transition>
            <v-alert v-if="showMetaHelp" type="info" variant="tonal" density="compact" class="mb-4 text-body-2">
              <div class="font-weight-bold mb-2">Покрокова інструкція</div>
              <ol class="pl-4" style="line-height:1.8;">
                <li>
                  Відкрийте
                  <a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener">developers.facebook.com/apps</a>
                  → <strong>Create App</strong> → тип <strong>Business</strong>.
                </li>
                <li>
                  <strong>App ID</strong> та <strong>App Secret</strong> знаходяться у
                  Settings → Basic вашого застосунку.
                </li>
                <li>
                  <strong>Page ID</strong> - числовий ідентифікатор Facebook-сторінки. Відкрийте сторінку →
                  About → прокрутіть вниз - там буде "Page ID".
                </li>
                <li>
                  <strong>Page Access Token</strong> - отримайте через
                  <a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noopener">Graph API Explorer</a>:
                  виберіть App → вашу сторінку → Generate Token. Для продакшн використовуйте довгостроковий або System User Token.
                </li>
                <li>
                  <strong>Verify Token</strong> - довільний рядок (наприклад <code>my-webhook-2026</code>).
                  Задайте тут, потім вкажіть той самий рядок у Facebook Developers → Products → Webhooks при реєстрації URL
                  <code>https://api.your-domain.com/webhooks/instagram</code>.
                </li>
              </ol>
              <div class="mt-2">
                <a href="https://developers.facebook.com/docs/messenger-platform/getting-started/app-setup" target="_blank" rel="noopener">
                  Офіційна документація Meta Messenger Platform →
                </a>
              </div>
            </v-alert>
          </v-expand-transition>

          <v-row dense>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="integrations.meta.appId"
                label="App ID"
                variant="outlined"
                density="compact"
                hide-details
                placeholder="123456789"
              />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="integrations.meta.appSecret"
                label="App Secret"
                variant="outlined"
                density="compact"
                hide-details
                :type="showSecrets.metaAppSecret ? 'text' : 'password'"
                :append-inner-icon="showSecrets.metaAppSecret ? 'mdi-eye-off' : 'mdi-eye'"
                @click:append-inner="showSecrets.metaAppSecret = !showSecrets.metaAppSecret"
              />
            </v-col>

            <!-- Facebook OAuth button -->
            <v-col cols="12" class="pt-1 pb-0">
              <v-btn
                color="blue-darken-2"
                variant="tonal"
                size="small"
                prepend-icon="mdi-facebook"
                :loading="oauthLoading"
                :disabled="!integrations.meta.appId || oauthLoading"
                @click="startMetaOAuth"
              >
                Авторизуватись через Facebook
              </v-btn>
              <span class="text-caption text-medium-emphasis ml-2">
                Автоматично заповнить Page ID та Page Access Token
              </span>
            </v-col>

            <v-col cols="12" sm="6">
              <v-text-field
                v-model="integrations.meta.pageId"
                label="Page ID"
                variant="outlined"
                density="compact"
                hide-details
                placeholder="ID сторінки Facebook/Instagram"
              />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="integrations.meta.pageAccessToken"
                label="Page Access Token"
                variant="outlined"
                density="compact"
                hide-details
                :type="showSecrets.metaToken ? 'text' : 'password'"
                :append-inner-icon="showSecrets.metaToken ? 'mdi-eye-off' : 'mdi-eye'"
                @click:append-inner="showSecrets.metaToken = !showSecrets.metaToken"
              />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="integrations.meta.verifyToken"
                label="Webhook Verify Token"
                variant="outlined"
                density="compact"
                hide-details
                placeholder="sb-verify-2026"
              />
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- Telegram -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start color="blue">mdi-send</v-icon>
          Telegram
        </v-card-title>
        <v-card-subtitle class="pb-2">Бот-токен та група для сповіщень менеджерам</v-card-subtitle>
        <v-card-text>
          <!-- Instructions -->
          <v-btn
            variant="text"
            size="small"
            color="info"
            class="mb-3 px-1"
            :prepend-icon="showTelegramHelp ? 'mdi-chevron-up' : 'mdi-help-circle-outline'"
            @click="showTelegramHelp = !showTelegramHelp"
          >
            Де взяти ці дані? Натисни тут.
          </v-btn>
          <v-expand-transition>
            <v-alert v-if="showTelegramHelp" type="info" variant="tonal" density="compact" class="mb-4 text-body-2">
              <div class="font-weight-bold mb-2">Покрокова інструкція</div>
              <ol class="pl-4" style="line-height:1.8;">
                <li>
                  Відкрийте Telegram → напишіть
                  <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a>
                  → команда <code>/newbot</code> → введіть назву та username.
                  Скопіюйте <strong>Bot Token</strong> формату <code>123456:ABC-DEF…</code>
                </li>
                <li>
                  Створіть групу для менеджерів у Telegram, додайте бота як учасника (або адміна).
                </li>
                <li>
                  Щоб отримати <strong>Manager Group ID</strong>:
                  напишіть будь-яке повідомлення в групу, потім відкрийте у браузері
                  <code>https://api.telegram.org/bot<strong>TOKEN</strong>/getUpdates</code>
                  і знайдіть <code>"chat":&#123;"id": -1001234567890&#125;</code> -
                  це і є ID (від'ємне число).
                </li>
                <li>
                  <strong>Admin Password</strong> - довільний пароль. Менеджер вводить
                  <code>/login ВАШ_ПАРОЛЬ</code> у чаті з ботом, щоб отримати доступ до керування розмовами.
                </li>
              </ol>
              <div class="mt-2">
                <a href="https://core.telegram.org/bots/tutorial" target="_blank" rel="noopener">
                  Офіційна документація Telegram Bots →
                </a>
              </div>
            </v-alert>
          </v-expand-transition>

          <v-row dense>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="integrations.telegram.botToken"
                label="Bot Token"
                variant="outlined"
                density="compact"
                hide-details
                :type="showSecrets.tgToken ? 'text' : 'password'"
                :append-inner-icon="showSecrets.tgToken ? 'mdi-eye-off' : 'mdi-eye'"
                @click:append-inner="showSecrets.tgToken = !showSecrets.tgToken"
                placeholder="123456:ABC-DEF..."
              />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="integrations.telegram.managerGroupId"
                label="Manager Group ID"
                variant="outlined"
                density="compact"
                hide-details
                placeholder="-1001234567890"
              />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="integrations.telegram.adminPassword"
                label="Admin Password (для /login)"
                variant="outlined"
                density="compact"
                hide-details
                :type="showSecrets.tgPassword ? 'text' : 'password'"
                :append-inner-icon="showSecrets.tgPassword ? 'mdi-eye-off' : 'mdi-eye'"
                @click:append-inner="showSecrets.tgPassword = !showSecrets.tgPassword"
              />
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- KeyCRM -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start color="green-darken-1">mdi-database-sync</v-icon>
          KeyCRM
        </v-card-title>
        <v-card-subtitle class="pb-2">API ключ для синхронізації каталогу</v-card-subtitle>
        <v-card-text>
          <!-- Instructions -->
          <v-btn
            variant="text"
            size="small"
            color="info"
            class="mb-3 px-1"
            :prepend-icon="showKeycrmHelp ? 'mdi-chevron-up' : 'mdi-help-circle-outline'"
            @click="showKeycrmHelp = !showKeycrmHelp"
          >
            Де взяти ці дані? Натисни тут.
          </v-btn>
          <v-expand-transition>
            <v-alert v-if="showKeycrmHelp" type="info" variant="tonal" density="compact" class="mb-4 text-body-2">
              <div class="font-weight-bold mb-2">Покрокова інструкція</div>
              <ol class="pl-4" style="line-height:1.8;">
                <li>
                  Зайдіть у ваш акаунт
                  <a href="https://app.keycrm.app/" target="_blank" rel="noopener">KeyCRM</a>.
                </li>
                <li>
                  Перейдіть: <strong>Налаштування → Інтеграції → API</strong>.
                </li>
                <li>
                  Якщо ключа ще немає - натисніть <strong>"Згенерувати"</strong>. Скопіюйте ключ та вставте сюди.
                </li>
                <li>
                  <strong>Інтервал синхронізації</strong> - як часто оновлювати каталог товарів із KeyCRM.
                  Рекомендовано: <strong>30–60 хвилин</strong> (мінімум 5 хв).
                </li>
              </ol>
              <div class="mt-2">
                <a href="https://api.keycrm.app/" target="_blank" rel="noopener">
                  KeyCRM API документація (Swagger) →
                </a>
              </div>
            </v-alert>
          </v-expand-transition>

          <v-row dense>
            <v-col cols="12" sm="7">
              <v-text-field
                v-model="integrations.keycrm.apiKey"
                label="API Key"
                variant="outlined"
                density="compact"
                hide-details
                :type="showSecrets.keycrmKey ? 'text' : 'password'"
                :append-inner-icon="showSecrets.keycrmKey ? 'mdi-eye-off' : 'mdi-eye'"
                @click:append-inner="showSecrets.keycrmKey = !showSecrets.keycrmKey"
              />
            </v-col>
            <v-col cols="12" sm="5">
              <v-text-field
                v-model.number="integrations.keycrm.syncIntervalMin"
                label="Інтервал синхронізації (хв)"
                type="number"
                variant="outlined"
                density="compact"
                hide-details
                min="5"
                max="1440"
              />
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- Nova Poshta -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start color="red-darken-1">mdi-truck-fast</v-icon>
          Нова Пошта
        </v-card-title>
        <v-card-subtitle class="pb-2">API ключ для розрахунку вартості доставки по Украъни</v-card-subtitle>
        <v-card-text>
          <v-row dense>
            <v-col cols="12" sm="7">
              <v-text-field
                v-model="integrations.novaposhta.apiKey"
                label="API Key"
                variant="outlined"
                density="compact"
                hide-details
                :type="showSecrets.npKey ? 'text' : 'password'"
                :append-inner-icon="showSecrets.npKey ? 'mdi-eye-off' : 'mdi-eye'"
                @click:append-inner="showSecrets.npKey = !showSecrets.npKey"
                placeholder="Ключ з особистого кабінету НП"
              />
            </v-col>
            <v-col cols="12" sm="5">
              <div class="d-flex ga-2 align-center" style="height:100%;">
                <v-text-field
                  v-model="integrations.novaposhta.senderCity"
                  label="Місто відправника"
                  variant="outlined"
                  density="compact"
                  hide-details
                  placeholder="Київ"
                  style="flex:1;"
                />
                <v-btn
                  size="small"
                  variant="tonal"
                  color="primary"
                  :loading="npCityLoading"
                  :disabled="!integrations.novaposhta.senderCity.trim()"
                  @click="resolveNpSenderCity"
                >
                  OK
                </v-btn>
              </div>
            </v-col>
            <v-col v-if="integrations.novaposhta.senderCityRef" cols="12">
              <v-alert type="success" variant="tonal" density="compact" class="text-caption">
                Ref: {{ integrations.novaposhta.senderCityRef }}
                ({{ integrations.novaposhta.senderCity }})
              </v-alert>
            </v-col>
            <v-col v-if="npCityError" cols="12">
              <v-alert type="error" variant="tonal" density="compact" class="text-caption">
                {{ npCityError }}
              </v-alert>
            </v-col>
          </v-row>
          <div class="text-caption text-medium-emphasis mt-2">
            Ключ отримайте в особистому кабінеті НП - Налаштування - API. Агент буде автоматично відповідати на питання про вартість доставки.
          </div>
        </v-card-text>
      </v-card>

      <!-- Save integrations -->
      <v-row class="mb-8">
        <v-col cols="auto">
          <v-btn
            color="primary"
            size="large"
            :loading="savingIntegrations"
            @click="saveIntegrations"
          >
            <v-icon start>mdi-content-save</v-icon>
            Зберегти інтеграції
          </v-btn>
        </v-col>
        <v-col cols="auto" class="d-flex align-center">
          <v-chip
            v-if="integrationsSaved"
            color="success"
            size="small"
            prepend-icon="mdi-check"
          >
            Збережено - перезапустіть сервер
          </v-chip>
        </v-col>
      </v-row>

      <v-alert v-if="error" type="error" density="compact" class="mb-4">
        {{ error }}
      </v-alert>
      <v-snackbar v-model="success" color="success" :timeout="3000">
        Налаштування збережено
      </v-snackbar>
      <v-snackbar v-model="oauthSnackbar" :color="oauthSnackbarColor" :timeout="4000">
        {{ oauthSnackbarText }}
      </v-snackbar>
    </template>
  </v-container>

  <!-- Facebook Page Picker dialog -->
  <v-dialog v-model="showPagePicker" max-width="440" persistent>
    <v-card>
      <v-card-title class="d-flex align-center ga-2">
        <v-icon color="blue-darken-2">mdi-facebook</v-icon>
        Виберіть Facebook-сторінку
      </v-card-title>
      <v-card-subtitle class="pb-2 px-4">
        Знайдено кілька сторінок. Виберіть ту, до якої підключено Instagram.
      </v-card-subtitle>
      <v-list>
        <v-list-item
          v-for="page in oauthPages"
          :key="page.id"
          :title="page.name"
          :subtitle="`ID: ${page.id}`"
          prepend-icon="mdi-page-layout-header"
          rounded="lg"
          class="mx-2"
          @click="selectOAuthPage(page)"
        >
          <template #append>
            <v-icon size="18" color="primary">mdi-chevron-right</v-icon>
          </template>
        </v-list-item>
      </v-list>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="showPagePicker = false">Скасувати</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import api from '@/api';

interface DaySchedule {
  enabled: boolean;
  start: string;
  end: string;
}

type WorkingHoursMap = Record<string, DaySchedule>;

const days = [
  { key: 'mon', label: 'Понеділок' },
  { key: 'tue', label: 'Вівторок' },
  { key: 'wed', label: 'Середа' },
  { key: 'thu', label: 'Четвер' },
  { key: 'fri', label: "П'ятниця" },
  { key: 'sat', label: 'Субота' },
  { key: 'sun', label: 'Неділя' },
];

const loading = ref(false);
const saving = ref(false);
const savingIntegrations = ref(false);
const integrationsSaved = ref(false);
const error = ref('');
const success = ref(false);

// ── Integrations state ──────────────────────────────────────────────────────

const integrations = ref({
  meta: {
    appId: '',
    appSecret: '',
    pageId: '',
    pageAccessToken: '',
    verifyToken: '',
  },
  telegram: {
    botToken: '',
    managerGroupId: '',
    adminPassword: '',
  },
  keycrm: {
    apiKey: '',
    syncIntervalMin: 30,
  },
  novaposhta: {
    apiKey: '',
    senderCity: 'Київ',
    senderCityRef: '',
  },
});

const showSecrets = ref({
  metaAppSecret: false,
  metaToken: false,
  tgToken: false,
  tgPassword: false,
  keycrmKey: false,
  npKey: false,
});

const npCityLoading = ref(false);
const npCityError = ref('');

async function resolveNpSenderCity() {
  const cityName = integrations.value.novaposhta.senderCity.trim();
  if (!cityName || npCityLoading.value) return;

  npCityLoading.value = true;
  npCityError.value = '';

  try {
    const { data } = await api.post('/settings/nova-poshta/resolve-city', { cityName });
    integrations.value.novaposhta.senderCityRef = data.ref;
    integrations.value.novaposhta.senderCity = data.name;
  } catch (e: any) {
    npCityError.value = e.response?.data?.error ?? `Місто "${cityName}" не знайдено в НП`;
    integrations.value.novaposhta.senderCityRef = '';
  } finally {
    npCityLoading.value = false;
  }
}

const showMetaHelp = ref(false);
const showTelegramHelp = ref(false);
const showKeycrmHelp = ref(false);

// ── Facebook OAuth ──────────────────────────────────────────────────────────

interface OAuthPage {
  id: string;
  name: string;
  access_token: string;
}

const oauthLoading = ref(false);
const oauthPages = ref<OAuthPage[]>([]);
const showPagePicker = ref(false);
const oauthSnackbar = ref(false);
const oauthSnackbarText = ref('');
const oauthSnackbarColor = ref('success');

function showOAuthSnackbar(text: string, color = 'success') {
  oauthSnackbarText.value = text;
  oauthSnackbarColor.value = color;
  oauthSnackbar.value = true;
}

async function startMetaOAuth() {
  const appId = integrations.value.meta.appId.trim();
  if (!appId || oauthLoading.value) return;

  oauthLoading.value = true;

  try {
    // Save App ID + App Secret to DB first so backend can use them in the callback
    await api.put('/settings/integrations', {
      integration_meta: {
        appId: integrations.value.meta.appId,
        appSecret: integrations.value.meta.appSecret,
      },
    });

    // Get OAuth URL from backend
    const { data } = await api.get('/settings/meta/oauth-init', {
      params: { appId },
    });

    // Open Facebook OAuth popup
    const popup = window.open(
      data.authUrl,
      'meta_oauth',
      'width=640,height=720,scrollbars=yes,resizable=yes',
    );

    if (!popup) {
      showOAuthSnackbar('Не вдалося відкрити вікно авторизації. Дозвольте popup у браузері.', 'error');
      oauthLoading.value = false;
      return;
    }

    // Listen for postMessage from the popup (sent after OAuth callback)
    const onMessage = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || !msg.type?.startsWith('meta_oauth')) return;

      window.removeEventListener('message', onMessage);
      clearInterval(closedTimer);
      oauthLoading.value = false;

      if (msg.type === 'meta_oauth_success') {
        const pages = msg.pages as OAuthPage[];
        if (pages.length === 1) {
          selectOAuthPage(pages[0]);
        } else {
          oauthPages.value = pages;
          showPagePicker.value = true;
        }
      } else {
        showOAuthSnackbar(msg.error ?? 'Помилка авторизації Facebook', 'error');
      }
    };

    window.addEventListener('message', onMessage);

    // Fallback: if popup was closed by user without completing OAuth
    const closedTimer = setInterval(() => {
      if (popup.closed) {
        clearInterval(closedTimer);
        window.removeEventListener('message', onMessage);
        oauthLoading.value = false;
      }
    }, 1000);

  } catch (e: any) {
    showOAuthSnackbar(e.response?.data?.error ?? 'Помилка ініціалізації OAuth', 'error');
    oauthLoading.value = false;
  }
}

function selectOAuthPage(page: OAuthPage) {
  integrations.value.meta.pageId = page.id;
  integrations.value.meta.pageAccessToken = page.access_token;
  showPagePicker.value = false;
  showOAuthSnackbar(`Сторінку "${page.name}" вибрано. Натисніть "Зберегти інтеграції".`);
}

const agentMode = ref<'24_7' | 'schedule'>('schedule');

const workingHours = ref<WorkingHoursMap>({
  mon: { start: '09:00', end: '20:00', enabled: true },
  tue: { start: '09:00', end: '20:00', enabled: true },
  wed: { start: '09:00', end: '20:00', enabled: true },
  thu: { start: '09:00', end: '20:00', enabled: true },
  fri: { start: '09:00', end: '20:00', enabled: true },
  sat: { start: '10:00', end: '18:00', enabled: true },
  sun: { start: '10:00', end: '18:00', enabled: false },
});

const outOfHoursTemplate = ref(
  "Дякуємо за повідомлення! Зараз ми не на зв'язку. Відповімо вам у робочий час.",
);
const handoffKeywords = ref('');
const featureFlags = ref({
  auto_handoff: true,
  send_typing_indicator: false,
});

function hoursPerDay(day: DaySchedule): string {
  if (!day.enabled || !day.start || !day.end) return '';
  const [sh, sm] = day.start.split(':').map(Number);
  const [eh, em] = day.end.split(':').map(Number);
  const diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff <= 0) return '';
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return m > 0 ? `${h} год ${m} хв` : `${h} год`;
}

function onModeChange(mode: '24_7' | 'schedule' | null) {
  if (!mode) return;
  if (mode === '24_7') {
    // Enable all days, 00:00–23:59
    for (const day of days) {
      workingHours.value[day.key] = { start: '00:00', end: '23:59', enabled: true };
    }
  }
}

async function fetchSettings() {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/settings');

    if (data.working_hours && typeof data.working_hours === 'object') {
      workingHours.value = { ...workingHours.value, ...data.working_hours };

      // Detect 24/7 mode: all days enabled 00:00–23:59
      const all247 = days.every((d) => {
        const h = workingHours.value[d.key];
        return h && h.enabled && h.start === '00:00' && h.end === '23:59';
      });
      agentMode.value = all247 ? '24_7' : 'schedule';
    }

    if (typeof data.out_of_hours_template === 'string') {
      outOfHoursTemplate.value = data.out_of_hours_template;
    }

    if (data.handoff_keywords) {
      handoffKeywords.value = Array.isArray(data.handoff_keywords)
        ? data.handoff_keywords.join(', ')
        : String(data.handoff_keywords);
    }

    if (data.feature_flags && typeof data.feature_flags === 'object') {
      featureFlags.value = { ...featureFlags.value, ...data.feature_flags };
    }
  } catch {
    error.value = 'Не вдалося завантажити налаштування';
  } finally {
    loading.value = false;
  }
}

async function saveSettings() {
  saving.value = true;
  error.value = '';
  success.value = false;
  try {
    await api.put('/settings', {
      working_hours: workingHours.value,
      out_of_hours_template: outOfHoursTemplate.value,
      handoff_keywords: handoffKeywords.value
        .split(',')
        .map((k: string) => k.trim())
        .filter(Boolean),
      feature_flags: featureFlags.value,
    });
    success.value = true;
  } catch {
    error.value = 'Не вдалося зберегти налаштування';
  } finally {
    saving.value = false;
  }
}

async function fetchIntegrations() {
  try {
    const { data } = await api.get('/settings/integrations');

    const m = data.integration_meta ?? {};
    const t = data.integration_telegram ?? {};
    const k = data.integration_keycrm ?? {};
    const np = data.integration_novaposhta ?? {};

    integrations.value.meta = {
      appId:            m.appId            ?? '',
      appSecret:        m.appSecret        ?? '',
      pageId:           m.pageId           ?? '',
      pageAccessToken:  m.pageAccessToken  ?? '',
      verifyToken:      m.verifyToken      ?? '',
    };
    integrations.value.telegram = {
      botToken:        t.botToken        ?? '',
      managerGroupId:  t.managerGroupId  ?? '',
      adminPassword:   t.adminPassword   ?? '',
    };
    integrations.value.keycrm = {
      apiKey:            k.apiKey            ?? '',
      syncIntervalMin:   k.syncIntervalMin   ?? 30,
    };
    integrations.value.novaposhta = {
      apiKey:         np.apiKey         ?? '',
      senderCity:     np.senderCity     ?? 'Київ',
      senderCityRef:  np.senderCityRef  ?? '',
    };
  } catch {
    // Non-critical: integrations may just not be set yet
  }
}

async function saveIntegrations() {
  savingIntegrations.value = true;
  integrationsSaved.value = false;
  error.value = '';
  try {
    await api.put('/settings/integrations', {
      integration_meta:        integrations.value.meta,
      integration_telegram:    integrations.value.telegram,
      integration_keycrm:      integrations.value.keycrm,
      integration_novaposhta:  integrations.value.novaposhta,
    });
    integrationsSaved.value = true;
  } catch {
    error.value = 'Не вдалося зберегти інтеграції';
  } finally {
    savingIntegrations.value = false;
  }
}

onMounted(() => {
  fetchSettings();
  fetchIntegrations();
});
</script>
