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
      <!-- Health Check -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center flex-wrap ga-2">
          <v-icon start color="teal">mdi-heart-pulse</v-icon>
          <span>Health Check</span>
          <v-chip
            v-if="healthCheckResult"
            size="small"
            :color="healthCheckResult.overall === 'ok' ? 'success' : 'warning'"
            variant="tonal"
          >
            {{ healthCheckResult.overall === 'ok' ? 'Усе OK' : 'Є проблеми' }}
          </v-chip>
        </v-card-title>
        <v-card-subtitle class="pb-2">
          Перевірка Instagram, Claude, CRM та швидкості відповіді агента (до 30 с).
          Може зайняти до півхвилини через тестовий запит до Claude.
        </v-card-subtitle>
        <v-card-text>
          <div class="d-flex flex-wrap align-center ga-2 mb-3">
            <v-btn
              color="teal"
              variant="tonal"
              prepend-icon="mdi-play-circle-outline"
              :loading="healthCheckLoading"
              :disabled="healthCheckLoading"
              @click="runHealthCheck"
            >
              Запустити перевірку
            </v-btn>
            <span v-if="healthCheckResult" class="text-caption text-medium-emphasis">
              Остання перевірка: {{ formatHealthCheckTime(healthCheckResult.checkedAt) }}
            </span>
          </div>

          <v-alert
            v-if="healthCheckError"
            type="error"
            variant="tonal"
            density="compact"
            class="mb-3"
          >
            {{ healthCheckError }}
          </v-alert>

          <v-list v-if="healthCheckResult" density="compact" class="health-check-list pa-0">
            <v-list-item
              v-for="item in healthCheckResult.checks"
              :key="item.id"
              class="health-check-item px-0"
            >
              <template #prepend>
                <v-icon
                  :icon="healthCheckIcon(item.status)"
                  :color="healthCheckColor(item.status)"
                  size="20"
                />
              </template>
              <v-list-item-title class="text-body-2 font-weight-medium">
                {{ item.label }}
              </v-list-item-title>
              <v-list-item-subtitle class="text-caption">
                {{ item.message }}
              </v-list-item-subtitle>
            </v-list-item>
          </v-list>
        </v-card-text>
      </v-card>

      <!-- Runtime mode (Public / Debug) -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center ga-2 flex-wrap">
          <v-icon start :color="runtimeMode === 'public' ? 'success' : 'warning'">
            {{ runtimeMode === 'public' ? 'mdi-earth' : 'mdi-bug-outline' }}
          </v-icon>
          <span>Режим роботи бота</span>
          <v-chip
            size="small"
            :color="runtimeMode === 'public' ? 'success' : 'warning'"
            variant="tonal"
            class="ml-2"
          >
            {{ runtimeMode === 'public' ? 'Public — відповідає всім' : 'Debug — лише whitelist' }}
          </v-chip>
          <v-chip
            v-if="runtimeSaveState === 'saving'"
            size="small"
            color="primary"
            variant="tonal"
            prepend-icon="mdi-content-save-outline"
          >
            Зберігаю…
          </v-chip>
          <v-chip
            v-else-if="runtimeSaveState === 'saved'"
            size="small"
            color="success"
            variant="tonal"
            prepend-icon="mdi-check"
          >
            Збережено
          </v-chip>
          <v-chip
            v-else-if="runtimeSaveState === 'error'"
            size="small"
            color="error"
            variant="tonal"
            prepend-icon="mdi-alert-circle-outline"
          >
            Помилка збереження
          </v-chip>
        </v-card-title>
        <v-card-subtitle class="pb-2">
          Керує тим, з ким бот спілкуватиметься в реальному Instagram.
          В Debug повідомлення від усіх, хто не у списку, ігноруються ще до запису в БД.
        </v-card-subtitle>
        <v-card-text>
          <v-radio-group
            v-model="runtimeMode"
            hide-details
            class="mb-2"
          >
            <v-radio value="public">
              <template #label>
                <div class="radio-label">
                  <strong>Public</strong>
                  <div class="text-caption text-medium-emphasis">
                    Бот відповідає усім клієнтам. Перед першим увімкненням — завантажте останні розмови нижче.
                  </div>
                </div>
              </template>
            </v-radio>
            <v-radio value="debug" class="mt-1">
              <template #label>
                <div class="radio-label">
                  <strong>Debug</strong>
                  <div class="text-caption text-medium-emphasis">
                    Бот відповідає лише @нікнеймам з переліку нижче — для тестування на підключеному Instagram.
                  </div>
                </div>
              </template>
            </v-radio>
          </v-radio-group>

          <v-expand-transition>
            <div v-if="runtimeMode === 'debug'" class="debug-whitelist-block">
              <div class="text-caption text-medium-emphasis mb-1">
                Whitelist @нікнеймів — через кому. Регістр не важливий, «@» можна залишати або опускати.
              </div>
              <v-textarea
                v-model="debugWhitelistRaw"
                variant="outlined"
                density="compact"
                rows="2"
                auto-grow
                hide-details
                placeholder="@olena.kovalenko, @dev_test, your_qa_handle"
              />
              <div v-if="debugWhitelistParsed.length > 0" class="d-flex flex-wrap ga-1 mt-2">
                <v-chip
                  v-for="tag in debugWhitelistParsed"
                  :key="tag"
                  size="x-small"
                  color="warning"
                  variant="tonal"
                  prepend-icon="mdi-at"
                >
                  {{ tag }}
                </v-chip>
              </div>
              <v-alert
                v-else
                type="warning"
                variant="tonal"
                density="compact"
                class="text-caption mt-2"
              >
                Список порожній — у Debug-режимі бот не відповідатиме нікому.
              </v-alert>
            </div>
          </v-expand-transition>

          <v-divider class="my-3" />

          <div class="backfill-row">
            <div class="backfill-info">
              <div class="text-subtitle-2 d-flex align-center ga-2 mb-1">
                <v-icon size="16">mdi-database-import</v-icon>
                Історичний імпорт IG-розмов
              </div>
              <div class="text-caption text-medium-emphasis">
                Завантажує останні <strong>N</strong> IG-тредів — потрібно перед першим перемиканням у Public.
              </div>
            </div>
            <div class="backfill-controls">
              <v-text-field
                v-model.number="runtimeBackfillLimit"
                type="number"
                min="10"
                max="500"
                label="Кількість розмов"
                variant="outlined"
                density="compact"
                hide-details
                class="backfill-count"
              />
              <v-btn
                size="small"
                color="primary"
                variant="tonal"
                prepend-icon="mdi-download"
                :loading="runtimeBackfillLoading"
                :disabled="igStatus?.connected === false"
                @click="runRuntimeBackfill"
              >
                Завантажити {{ runtimeBackfillLimit || 200 }}
              </v-btn>
            </div>
          </div>

          <v-alert
            v-if="runtimeBackfillError"
            type="error"
            variant="tonal"
            density="compact"
            class="text-body-2 mt-2"
          >
            {{ runtimeBackfillError }}
          </v-alert>

          <v-alert
            v-if="runtimeBackfillResult && runtimeBackfillIsEmpty"
            type="warning"
            variant="tonal"
            density="compact"
            class="text-body-2 mt-2"
          >
            Instagram повернув <strong>0 діалогів</strong> для цього акаунту. Можливі причини:
            <ul class="pl-4 mt-1" style="line-height:1.7;">
              <li>У цього IG-акаунту ще немає жодної DM-розмови.</li>
              <li>Запити в директ сидять у <strong>Message Requests</strong> і не видимі в API, поки їх не прийняти в Instagram-додатку (Inbox → Requests → Accept).</li>
              <li>Акаунт не є <strong>Business/Creator</strong> — у «Перевірити підключення» має бути <code>BUSINESS</code> або <code>CREATOR</code>.</li>
              <li>OAuth був виконаний без <code>instagram_manage_messages</code> scope — повторіть авторизацію.</li>
            </ul>
          </v-alert>

          <v-alert
            v-else-if="runtimeBackfillResult"
            type="info"
            variant="tonal"
            density="compact"
            class="text-body-2 mt-2"
          >
            Імпортовано: <strong>{{ runtimeBackfillResult.conversationsImported }}</strong> нових розмов,
            оновлено: <strong>{{ runtimeBackfillResult.conversationsSkipped }}</strong>.
            Повідомлень: {{ runtimeBackfillResult.messagesImported }} додано,
            {{ runtimeBackfillResult.messagesSkipped }} пропущено.
            <span v-if="runtimeBackfillResult.managerReplies > 0">
              Знайдено відповідей менеджера: <strong>{{ runtimeBackfillResult.managerReplies }}</strong>.
            </span>
          </v-alert>
        </v-card-text>
      </v-card>

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

          <v-radio-group v-model="scheduleMode" @update:model-value="onScheduleModeChange">
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

      <!-- Agent type & SLA (agent_config) -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start color="deep-purple">mdi-account-tie</v-icon>
          Тип агента та SLA
        </v-card-title>
        <v-card-subtitle class="pb-2">
          Визначає, які інструменти має агент та як поводиться поза робочими годинами.
        </v-card-subtitle>
        <v-card-text>
          <v-row dense>
            <v-col cols="12" sm="6">
              <v-select
                v-model="agentConfig.mode"
                :items="[
                  { title: 'Продажі (sales) — замовлення, каталог, доставка', value: 'sales' },
                  { title: 'Лідген (leadgen) — бриф, кваліфікація ліда', value: 'leadgen' },
                ]"
                item-title="title"
                item-value="value"
                label="Режим агента"
                variant="outlined"
                density="compact"
                hide-details
              />
              <div class="text-caption text-medium-emphasis mt-1">
                <strong>sales</strong>: collect_order + get_delivery_cost; leadgen: classify_intent + submit_brief.
              </div>
            </v-col>
            <v-col cols="12" sm="6">
              <v-select
                v-model="agentConfig.outOfHoursStrategy"
                :items="[
                  { title: 'Попередити одразу (warn_early)', value: 'warn_early' },
                  { title: 'Повідомити в кінці розмови (defer_to_end)', value: 'defer_to_end' },
                ]"
                item-title="title"
                item-value="value"
                label="Поведінка поза годинами"
                variant="outlined"
                density="compact"
                hide-details
              />
              <div class="text-caption text-medium-emphasis mt-1">
                <strong>warn_early</strong> для продажів, <strong>defer_to_end</strong> для лідгену (не переривати бриф).
              </div>
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model.number="agentConfig.managerSlaHoursBusiness"
                type="number"
                min="1"
                max="48"
                label="SLA відповіді менеджера (робочих годин)"
                variant="outlined"
                density="compact"
                hide-details
              />
              <div class="text-caption text-medium-emphasis mt-1">
                Використовується в промпті як <code v-pre>{{MANAGER_SLA_HOURS}}</code>.
              </div>
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model.number="agentConfig.sessionFreshnessDays"
                type="number"
                min="1"
                max="90"
                label="Свіжість розмови (днів)"
                variant="outlined"
                density="compact"
                hide-details
              />
              <div class="text-caption text-medium-emphasis mt-1">
                Після стількох днів тиші розмова вважається закритою (для брифів / метрик).
              </div>
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- Working hours (shown only in schedule mode) -->
      <v-card v-if="scheduleMode === 'schedule'" class="mb-4">
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
      <v-card v-if="scheduleMode === 'schedule'" class="mb-4">
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
      <v-row class="mb-5">
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

      <v-divider class="mb-4" />

      <!-- ── Integrations ── -->
      <div class="integrations-title">Інтеграції</div>

      <!-- Instagram -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start color="pink-darken-2">mdi-instagram</v-icon>
          Instagram
        </v-card-title>
        <v-card-subtitle class="pb-2">Facebook Login for Business — авторизація через Facebook Page → Page Access Token</v-card-subtitle>
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
            Як підключити Instagram? Натисни тут.
          </v-btn>
          <v-expand-transition>
            <v-alert v-if="showMetaHelp" type="info" variant="tonal" density="compact" class="mb-4 text-body-2">
              <div class="font-weight-bold mb-2">Покрокова інструкція</div>
              <ol class="pl-4" style="line-height:1.8;">
                <li>
                  Переконайтесь, що ваша <strong>Facebook Сторінка</strong> підключена до
                  <strong>Instagram Business</strong> або <strong>Creator</strong> акаунту.
                  Перевірити можна в <strong>Business Manager → Accounts → Instagram accounts</strong>
                  або в налаштуваннях Facebook Сторінки → Instagram.
                </li>
                <li>
                  Натисніть кнопку <strong>«Авторизуватись через Facebook»</strong> нижче.
                  Відкриється вікно Facebook Login — надайте запитувані дозволи.
                </li>
                <li>
                  Після авторизації <strong>Page ID</strong>, <strong>Access Token</strong>
                  та <strong>Instagram User ID</strong> заповняться автоматично. Webhook підпишеться сам.
                </li>
              </ol>
              <div class="mt-2 text-caption text-medium-emphasis">
                Webhook URL: <code>{{ webhookUrl }}</code>
              </div>
            </v-alert>
          </v-expand-transition>

          <v-row dense>
            <!-- Facebook OAuth button -->
            <v-col cols="12" class="pb-2">
              <v-btn
                color="blue-darken-2"
                variant="tonal"
                prepend-icon="mdi-facebook"
                :loading="oauthLoading"
                :disabled="oauthLoading"
                @click="startMetaOAuth"
              >
                Авторизуватись через Facebook
              </v-btn>
              <v-btn
                v-if="metaConnected"
                color="error"
                variant="tonal"
                prepend-icon="mdi-link-off"
                class="ml-2"
                :loading="metaDisconnectLoading"
                :disabled="metaDisconnectLoading || oauthLoading"
                @click="metaDisconnectDialog = true"
              >
                Відвʼязати
              </v-btn>
              <span class="text-caption text-medium-emphasis ml-3">
                Надасть доступ до сторінки та Instagram — Page ID і токен заповняться самі
              </span>
            </v-col>

            <v-col v-if="metaConnected && integrations.meta.pageId" cols="12">
              <v-alert type="success" variant="tonal" density="compact" class="text-body-2">
                <div class="font-weight-bold mb-1">Поточне підключення</div>
                <div v-if="integrations.meta.igUsername || integrations.meta.igUserId">
                  Instagram:
                  <strong>@{{ integrations.meta.igUsername || '—' }}</strong>
                  <span class="text-medium-emphasis">(ID: {{ integrations.meta.igUserId || '—' }})</span>
                </div>
                <div v-else class="text-warning">
                  Instagram ID не вказано — доповніть вручну нижче.
                </div>
                <div class="text-medium-emphasis">
                  Facebook Page ID: <code>{{ integrations.meta.pageId }}</code>
                </div>
              </v-alert>
            </v-col>

            <v-col v-if="metaNeedsManualIg" cols="12">
              <v-alert type="warning" variant="tonal" density="compact" class="text-body-2">
                Facebook Page збережено, але Instagram Business ID не отримано автоматично.
                Введіть <strong>Instagram User ID</strong> та <strong>@username</strong> вручну нижче і натисніть
                <strong>«Зберегти Instagram»</strong>.
              </v-alert>
            </v-col>

            <v-col cols="12">
              <v-btn
                variant="text"
                size="small"
                color="warning"
                class="px-1"
                :prepend-icon="showMetaManualHelp ? 'mdi-chevron-up' : 'mdi-pencil-outline'"
                @click="showMetaManualHelp = !showMetaManualHelp"
              >
                Як вручну вказати Instagram ID та username?
              </v-btn>
              <v-expand-transition>
                <v-alert
                  v-if="showMetaManualHelp"
                  type="warning"
                  variant="tonal"
                  density="compact"
                  class="mt-2 text-body-2"
                >
                  <div class="font-weight-bold mb-2">Де взяти Instagram Business Account ID</div>
                  <ol class="pl-4 mb-3" style="line-height:1.75;">
                    <li>
                      <strong>Через Graph API Explorer</strong> (developers.facebook.com/tools/explorer):
                      оберіть ваш App → User/Page token з правами на Page → запит
                      <code>GET /{FACEBOOK_PAGE_ID}?fields=instagram_business_account&#123;id,username&#125;</code>.
                      У відповіді візьміть <code>instagram_business_account.id</code> — це <strong>Instagram User ID</strong>
                      (числовий ID, не @username).
                    </li>
                    <li>
                      <strong>Business Manager</strong> → Accounts → Instagram accounts → відкрийте акаунт —
                      ID часто видно в URL або в деталях підключення до Facebook Page.
                    </li>
                    <li>
                      <strong>Meta Business Suite</strong> → налаштування Instagram, прив’язаного до вашої Facebook Сторінки.
                    </li>
                  </ol>
                  <div class="font-weight-bold mb-1">Username</div>
                  <p class="mb-2">
                    Публічний нік без <code>@</code>, наприклад <code>statusblessed</code> — лише для відображення в адмінці.
                  </p>
                  <div class="font-weight-bold mb-1">Facebook Page ID</div>
                  <p class="mb-2">
                    Зазвичай заповнюється після OAuth. Якщо порожньо — у Graph API Explorer:
                    <code>GET /me/accounts?fields=id,name</code> або в налаштуваннях Facebook Page → About.
                  </p>
                  <div class="font-weight-bold mb-1">Page Access Token</div>
                  <p class="mb-0">
                    Краще отримати через кнопку «Авторизуватись через Facebook» вище. Вручну — у Graph API Explorer:
                    <code>GET /me/accounts?fields=id,name,access_token</code> і скопіюйте <code>access_token</code> потрібної Page.
                  </p>
                </v-alert>
              </v-expand-transition>
            </v-col>

            <v-col cols="12" sm="6">
              <v-text-field
                v-model="integrations.meta.pageId"
                label="Facebook Page ID"
                variant="outlined"
                density="compact"
                hide-details
                placeholder="Заповниться після OAuth або вручну"
              />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="integrations.meta.igUserId"
                label="Instagram User ID (Business account)"
                variant="outlined"
                density="compact"
                hide-details
                placeholder="Числовий ID з instagram_business_account"
                hint="Обовʼязково, якщо OAuth не підставив IG"
                persistent-hint
              />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="integrations.meta.igUsername"
                label="Instagram Username"
                variant="outlined"
                density="compact"
                hide-details
                placeholder="nickname без @"
                prefix="@"
              />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="integrations.meta.pageAccessToken"
                label="Page Access Token"
                variant="outlined"
                density="compact"
                :readonly="metaPageTokenMasked && !metaPageTokenReplacing"
                :type="
                  metaPageTokenMasked && !metaPageTokenReplacing
                    ? 'text'
                    : showSecrets.metaPageToken
                      ? 'text'
                      : 'password'
                "
                :placeholder="metaPageTokenReplacing ? 'Вставте новий Page Access Token' : 'Заповниться після OAuth'"
                hint="Після збереження повний токен не повертається з API (як пароль) — лише індикатор «збережено»."
                persistent-hint
                :append-inner-icon="
                  metaPageTokenMasked && !metaPageTokenReplacing
                    ? undefined
                    : showSecrets.metaPageToken
                      ? 'mdi-eye-off'
                      : 'mdi-eye'
                "
                @click:append-inner="showSecrets.metaPageToken = !showSecrets.metaPageToken"
              />
              <v-btn
                v-if="metaPageTokenMasked && !metaPageTokenReplacing"
                size="x-small"
                variant="text"
                color="primary"
                class="px-0 mt-1"
                @click="startPageTokenReplace"
              >
                Вставити новий токен
              </v-btn>
            </v-col>
            <v-col cols="12">
              <v-btn
                color="primary"
                variant="tonal"
                prepend-icon="mdi-content-save"
                :loading="savingMeta"
                @click="saveMetaIntegration"
              >
                Зберегти Instagram
              </v-btn>
              <v-chip
                v-if="metaSaved"
                color="success"
                size="small"
                class="ml-2"
                prepend-icon="mdi-check"
              >
                Збережено
              </v-chip>
              <span class="text-caption text-medium-emphasis ml-3">
                Зберігає Page ID, токен і Instagram-поля; підписка webhook оновиться автоматично.
              </span>
            </v-col>
          </v-row>

          <v-divider class="my-4" />

          <!-- Connection check + bulk import -->
          <div class="text-subtitle-2 mb-2">Статус підключення</div>
          <div class="d-flex flex-wrap align-center ga-2 mb-2">
            <v-btn
              size="small"
              color="primary"
              variant="tonal"
              prepend-icon="mdi-lan-check"
              :loading="igStatusLoading"
              @click="checkIgStatus"
            >
              Перевірити підключення
            </v-btn>
            <v-btn
              size="small"
              color="primary"
              variant="tonal"
              prepend-icon="mdi-download"
              :loading="igImportLoading"
              :disabled="igStatus?.connected === false"
              @click="importRecentConversations"
            >
              Завантажити останні 20 діалогів
            </v-btn>
            <v-btn
              size="small"
              color="deep-purple"
              variant="tonal"
              prepend-icon="mdi-bug-outline"
              :loading="igDebugLoading"
              @click="runIgDebug"
            >
              Діагностика API
            </v-btn>

            <v-chip
              v-if="igStatus?.connected"
              color="success"
              size="small"
              prepend-icon="mdi-check-circle"
            >
              Підключено{{ igStatus.igAccount?.username ? `: @${igStatus.igAccount.username}` : '' }}
            </v-chip>
            <v-chip
              v-else-if="igStatus && !igStatus.connected"
              color="error"
              size="small"
              prepend-icon="mdi-close-circle"
            >
              Не підключено
            </v-chip>
          </div>

          <v-alert
            v-if="igStatus?.connected && igStatus.igAccount"
            type="success"
            variant="tonal"
            density="compact"
            class="text-body-2"
          >
            <div v-if="igStatus.page">
              <strong>Facebook Page:</strong>
              {{ igStatus.page.name || igStatus.page.id }}
              <span class="text-medium-emphasis">(ID: {{ igStatus.page.id }})</span>
            </div>
            <div>
              <strong>Instagram:</strong>
              {{ igStatus.igAccount.name || igStatus.igAccount.username || igStatus.igAccount.id }}
              <span v-if="igStatus.igAccount.username">(@{{ igStatus.igAccount.username }})</span>
            </div>
            <div v-if="igStatus.igAccount.accountType">
              <strong>Тип:</strong> {{ igStatus.igAccount.accountType }}
            </div>
            <div><strong>Instagram User ID:</strong> {{ igStatus.igAccount.id }}</div>
            <div v-if="igStatus.webhook">
              <strong>Webhook:</strong>
              <v-chip
                :color="igStatus.webhook.subscribed ? 'success' : 'warning'"
                size="x-small"
                class="ml-1"
              >
                {{ igStatus.webhook.subscribed ? 'підписано' : 'не повністю підписано' }}
              </v-chip>
              <span
                v-if="igStatus.webhook.fields?.length"
                class="text-caption text-medium-emphasis ml-1"
              >
                ({{ igStatus.webhook.fields.join(', ') }})
              </span>
            </div>
            <div v-if="igStatus.conversationsCount !== undefined">
              <strong>Діалоги (вибірка API):</strong> {{ igStatus.conversationsCount }}
            </div>
          </v-alert>

          <v-alert
            v-if="igStatus?.connected && igStatus.warnings?.length"
            type="warning"
            variant="tonal"
            density="compact"
            class="text-body-2 mt-2"
          >
            <div class="font-weight-bold mb-1">Зауваження</div>
            <ul class="pl-4 mb-0" style="line-height:1.6;">
              <li v-for="(w, i) in igStatus.warnings" :key="i">{{ w }}</li>
            </ul>
          </v-alert>

          <v-alert
            v-if="igStatus && !igStatus.connected"
            type="error"
            variant="tonal"
            density="compact"
            class="text-body-2"
          >
            {{ igStatus.error || 'Помилка перевірки підключення' }}
          </v-alert>

          <v-alert
            v-if="igImportResult && igImportIsEmpty"
            type="warning"
            variant="tonal"
            density="compact"
            class="text-body-2 mt-2"
          >
            Instagram повернув <strong>0 діалогів</strong>. Найчастіше — через:
            <ul class="pl-4 mt-1" style="line-height:1.7;">
              <li>Усі DM сидять у <strong>Message Requests</strong> і не видимі API, поки їх не прийняти в Instagram-додатку.</li>
              <li>Акаунт не Business/Creator, або OAuth без <code>instagram_manage_messages</code> scope — повторіть авторизацію.</li>
            </ul>
          </v-alert>

          <v-alert
            v-else-if="igImportResult"
            type="info"
            variant="tonal"
            density="compact"
            class="text-body-2 mt-2"
          >
            Імпортовано: <strong>{{ igImportResult.conversationsImported }}</strong> нових розмов,
            оновлено: <strong>{{ igImportResult.conversationsSkipped }}</strong>.
            Повідомлень: {{ igImportResult.messagesImported }} додано,
            {{ igImportResult.messagesSkipped }} пропущено.
            <span v-if="igImportResult.managerReplies > 0">
              Знайдено відповідей менеджера: <strong>{{ igImportResult.managerReplies }}</strong>.
            </span>
          </v-alert>

          <!-- Diagnostic output -->
          <v-alert
            v-if="igDebugResult"
            type="info"
            variant="tonal"
            density="compact"
            class="mt-2"
          >
            <div class="font-weight-bold mb-1">Діагностика Meta API — {{ igDebugResult.apiVersion }}</div>
            <div class="text-caption mb-2">
              User: {{ igDebugResult.igUsername }} (ID: {{ igDebugResult.igUserId }})
            </div>
            <pre
              style="
                white-space: pre-wrap;
                word-break: break-word;
                font-size: 11px;
                background: rgba(0,0,0,0.04);
                padding: 8px;
                border-radius: 4px;
                max-height: 600px;
                overflow: auto;
              "
            >{{ JSON.stringify(igDebugResult.probes, null, 2) }}</pre>
          </v-alert>
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
      <v-row class="mb-5">
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

      <!-- OAuth: pick one Page when Facebook returned several -->
      <v-dialog v-model="metaOAuthSelectDialog" max-width="560" persistent>
        <v-card>
          <v-card-title class="d-flex align-center">
            <v-icon start color="primary">mdi-facebook</v-icon>
            Оберіть Facebook Page
          </v-card-title>
          <v-card-text class="text-body-2">
            <p class="mb-3">
              {{ metaOAuthSelectMessage }}
            </p>
            <v-radio-group v-model="metaOAuthSelectPageId" hide-details>
              <v-radio
                v-for="c in metaOAuthSelectCandidates"
                :key="c.pageId"
                :value="c.pageId"
                class="mb-2"
              >
                <template #label>
                  <div>
                    <div class="font-weight-medium">{{ c.pageName }}</div>
                    <div class="text-caption text-medium-emphasis">
                      Page ID: {{ c.pageId }}
                      <template v-if="c.hasInstagram && (c.igUsername || c.igUserId)">
                        · Instagram @{{ c.igUsername || '—' }} ({{ c.igUserId }})
                      </template>
                      <template v-else-if="metaOAuthSelectNeedsManualIg">
                        · Instagram ID потрібно вказати вручну після вибору
                      </template>
                    </div>
                  </div>
                </template>
              </v-radio>
            </v-radio-group>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn
              variant="text"
              :disabled="metaOAuthSelectLoading"
              @click="cancelMetaOAuthSelect"
            >
              Скасувати
            </v-btn>
            <v-btn
              color="primary"
              variant="tonal"
              prepend-icon="mdi-check"
              :loading="metaOAuthSelectLoading"
              :disabled="!metaOAuthSelectPageId"
              @click="confirmMetaOAuthSelect"
            >
              Підключити обрану
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- Instagram disconnect confirmation -->
      <v-dialog v-model="metaDisconnectDialog" max-width="480">
        <v-card>
          <v-card-title class="d-flex align-center">
            <v-icon start color="error">mdi-link-off</v-icon>
            Відвʼязати Instagram?
          </v-card-title>
          <v-card-text class="text-body-2">
            <p class="mb-2">
              Буде відвʼязано
              <strong v-if="integrations.meta.igUsername">@{{ integrations.meta.igUsername }}</strong>
              <strong v-else>підключену сторінку</strong>
              (Page ID: {{ integrations.meta.pageId || '—' }}).
            </p>
            <ul class="pl-4 mb-2">
              <li>Бот перестане отримувати та відправляти повідомлення в Instagram DM.</li>
              <li>Підписку на webhook буде скасовано.</li>
              <li>Збережені діалоги та інші налаштування залишаться без змін.</li>
            </ul>
            <p class="text-medium-emphasis mb-0">
              Підключити можна буде знову через «Авторизуватись через Facebook».
            </p>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="text" :disabled="metaDisconnectLoading" @click="metaDisconnectDialog = false">
              Скасувати
            </v-btn>
            <v-btn
              color="error"
              variant="tonal"
              prepend-icon="mdi-link-off"
              :loading="metaDisconnectLoading"
              @click="disconnectMeta"
            >
              Відвʼязати
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </template>
  </v-container>

</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
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
    pageId: '',
    pageAccessToken: '',
    igUserId: '',
    igUsername: '',
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
  tgToken: false,
  tgPassword: false,
  keycrmKey: false,
  npKey: false,
  metaPageToken: false,
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
const showMetaManualHelp = ref(false);
const savingMeta = ref(false);
const metaSaved = ref(false);
const metaPageTokenMasked = ref(false);
const metaPageTokenReplacing = ref(false);
const META_TOKEN_MASK = '•••••• (збережено на сервері)';

function startPageTokenReplace() {
  metaPageTokenReplacing.value = true;
  integrations.value.meta.pageAccessToken = '';
  showSecrets.value.metaPageToken = true;
}
const showTelegramHelp = ref(false);
const showKeycrmHelp = ref(false);

// ── Health Check ────────────────────────────────────────────────────────────

type HealthCheckStatus = 'ok' | 'not_configured' | 'error';

interface HealthCheckItem {
  id: string;
  label: string;
  status: HealthCheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

interface HealthCheckResult {
  checkedAt: string;
  overall: 'ok' | 'degraded';
  checks: HealthCheckItem[];
}

const healthCheckLoading = ref(false);
const healthCheckError = ref('');
const healthCheckResult = ref<HealthCheckResult | null>(null);

function healthCheckIcon(status: HealthCheckStatus): string {
  if (status === 'ok') return 'mdi-check-circle';
  if (status === 'not_configured') return 'mdi-alert-circle-outline';
  return 'mdi-close-circle';
}

function healthCheckColor(status: HealthCheckStatus): string {
  if (status === 'ok') return 'success';
  if (status === 'not_configured') return 'warning';
  return 'error';
}

function formatHealthCheckTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('uk-UA', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

async function runHealthCheck() {
  healthCheckLoading.value = true;
  healthCheckError.value = '';
  try {
    const { data } = await api.post<HealthCheckResult>('/settings/health-check');
    healthCheckResult.value = data;
  } catch (e: any) {
    healthCheckError.value = e.response?.data?.error ?? 'Не вдалося виконати перевірку';
    healthCheckResult.value = null;
  } finally {
    healthCheckLoading.value = false;
  }
}

// ── Instagram connection status + bulk import ───────────────────────────────

interface IgStatus {
  connected: boolean;
  page?: { id: string; name?: string };
  igAccount?: {
    id: string;
    username?: string;
    name?: string;
    accountType?: string;
    source?: string;
  };
  webhook?: {
    subscribed: boolean;
    fields: string[];
    error?: string;
  };
  conversationsCount?: number;
  warnings?: string[];
  error?: string;
}

interface ImportRecentResult {
  conversationsImported: number;
  conversationsSkipped: number;
  messagesImported: number;
  messagesSkipped: number;
  managerReplies: number;
}

const igStatus = ref<IgStatus | null>(null);
const igStatusLoading = ref(false);
const igImportLoading = ref(false);
const igImportResult = ref<ImportRecentResult | null>(null);
const igDebugLoading = ref(false);
const igDebugResult = ref<{
  igUserId?: string;
  igUsername?: string;
  apiVersion?: string;
  probes: unknown[];
} | null>(null);

async function runIgDebug() {
  igDebugLoading.value = true;
  igDebugResult.value = null;
  try {
    const { data } = await api.get('/settings/meta/debug');
    igDebugResult.value = data;
  } catch (e: any) {
    igDebugResult.value = {
      probes: [{ error: e.response?.data?.error ?? e.message ?? 'Не вдалося виконати діагностику' }],
    };
  } finally {
    igDebugLoading.value = false;
  }
}
const igImportIsEmpty = computed(
  () =>
    !!igImportResult.value &&
    igImportResult.value.conversationsImported === 0 &&
    igImportResult.value.conversationsSkipped === 0,
);

async function checkIgStatus() {
  igStatusLoading.value = true;
  try {
    const { data } = await api.get<IgStatus>('/settings/meta/status');
    igStatus.value = data;
  } catch (e: any) {
    igStatus.value = {
      connected: false,
      error: e.response?.data?.error ?? 'Не вдалося перевірити підключення',
    };
  } finally {
    igStatusLoading.value = false;
  }
}

async function importRecentConversations() {
  igImportLoading.value = true;
  igImportResult.value = null;
  try {
    const { data } = await api.post<ImportRecentResult>(
      '/settings/meta/import-recent-conversations',
      { limit: 20 },
    );
    igImportResult.value = data;
  } catch (e: any) {
    showOAuthSnackbar(
      e.response?.data?.error ?? 'Не вдалося завантажити розмови',
      'error',
    );
  } finally {
    igImportLoading.value = false;
  }
}

// ── Instagram OAuth ─────────────────────────────────────────────────────────

interface OAuthAccount {
  pageId: string;
  pageName?: string;
  igUserId?: string;
  igUsername?: string;
}

interface OAuthSelectCandidate {
  pageId: string;
  pageName: string;
  igUserId: string;
  igUsername: string;
  hasInstagram: boolean;
}

const oauthLoading = ref(false);
const metaOAuthSelectDialog = ref(false);
const metaOAuthSelectSessionId = ref('');
const metaOAuthSelectCandidates = ref<OAuthSelectCandidate[]>([]);
const metaOAuthSelectPageId = ref('');
const metaOAuthSelectNeedsManualIg = ref(false);
const metaOAuthSelectMessage = ref('');
const metaOAuthSelectLoading = ref(false);
const oauthSnackbar = ref(false);
const oauthSnackbarText = ref('');
const oauthSnackbarColor = ref('success');

// Derived URLs to display in the setup instructions. The admin is served from
// `agent.status-blessed.com`; the API counterpart lives at `api.status-blessed.com`.
// If the admin host doesn't start with `agent.`, fall back to the current origin.
const redirectUrl = computed(() => {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:3000/settings/meta/oauth-callback';
  }
  const apiHost = host.startsWith('agent.') ? host.replace(/^agent\./, 'api.') : host;
  return `https://${apiHost}/settings/meta/oauth-callback`;
});
const webhookUrl = computed(() => {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:3000/webhooks/instagram';
  }
  const apiHost = host.startsWith('agent.') ? host.replace(/^agent\./, 'api.') : host;
  return `https://${apiHost}/webhooks/instagram`;
});

function showOAuthSnackbar(text: string, color = 'success') {
  oauthSnackbarText.value = text;
  oauthSnackbarColor.value = color;
  oauthSnackbar.value = true;
}

function formatExpiresAt(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('uk-UA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function startMetaOAuth() {
  if (oauthLoading.value) return;
  oauthLoading.value = true;

  try {
    const { data } = await api.get('/settings/meta/oauth-init');

    const popup = window.open(
      data.authUrl,
      'facebook_oauth',
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
        applyOAuthAccount(msg.account as OAuthAccount);
      } else if (msg.type === 'meta_oauth_select') {
        openMetaOAuthSelectDialog(msg);
      } else if (msg.type === 'meta_oauth_partial') {
        applyOAuthAccount(msg.account as OAuthAccount);
        showMetaManualHelp.value = true;
        showOAuthSnackbar(
          (msg.message as string) ??
            'Page збережено. Введіть Instagram User ID та username вручну.',
          'warning',
        );
      } else {
        showMetaManualHelp.value = true;
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

function applyOAuthAccount(account: OAuthAccount) {
  integrations.value.meta.pageId = account.pageId;
  integrations.value.meta.igUserId = account.igUserId ?? '';
  integrations.value.meta.igUsername = account.igUsername ?? '';
  fetchIntegrations();
  if (account.igUserId) {
    showOAuthSnackbar(
      `Підключено @${account.igUsername || account.igUserId} (Page: ${account.pageName || account.pageId}). Webhook підписано.`,
    );
  }
}

function openMetaOAuthSelectDialog(msg: Record<string, unknown>) {
  metaOAuthSelectSessionId.value = String(msg.sessionId ?? '');
  metaOAuthSelectCandidates.value = (msg.candidates as OAuthSelectCandidate[]) ?? [];
  metaOAuthSelectNeedsManualIg.value = Boolean(msg.needsManualIg);
  metaOAuthSelectMessage.value =
    (msg.message as string) ??
    'Знайдено кілька сторінок. Оберіть одну для роботи бота.';
  metaOAuthSelectPageId.value = metaOAuthSelectCandidates.value[0]?.pageId ?? '';
  metaOAuthSelectDialog.value = true;
}

function cancelMetaOAuthSelect() {
  metaOAuthSelectDialog.value = false;
  metaOAuthSelectSessionId.value = '';
  metaOAuthSelectCandidates.value = [];
  metaOAuthSelectPageId.value = '';
  showOAuthSnackbar(
    'Вибір сторінки скасовано. Повторіть авторизацію Facebook, якщо потрібно.',
    'info',
  );
}

async function confirmMetaOAuthSelect() {
  if (!metaOAuthSelectSessionId.value || !metaOAuthSelectPageId.value) return;
  metaOAuthSelectLoading.value = true;
  try {
    const { data } = await api.post<{
      account: OAuthAccount;
      partial: boolean;
      message?: string;
    }>('/settings/meta/oauth-select', {
      sessionId: metaOAuthSelectSessionId.value,
      pageId: metaOAuthSelectPageId.value,
    });

    metaOAuthSelectDialog.value = false;
    metaOAuthSelectSessionId.value = '';
    metaOAuthSelectCandidates.value = [];

    applyOAuthAccount(data.account);
    if (data.partial) {
      showMetaManualHelp.value = true;
      showOAuthSnackbar(
        data.message ?? 'Page збережено. Вкажіть Instagram User ID вручну.',
        'warning',
      );
    } else {
      showOAuthSnackbar(data.message ?? 'Сторінку підключено', 'success');
    }
  } catch (e: any) {
    showOAuthSnackbar(
      e.response?.data?.error ?? 'Не вдалося зберегти обрану сторінку',
      'error',
    );
  } finally {
    metaOAuthSelectLoading.value = false;
  }
}

async function saveMetaIntegration() {
  const pageId = integrations.value.meta.pageId.trim();
  const igUserId = integrations.value.meta.igUserId.trim();
  if (!pageId) {
    showOAuthSnackbar('Вкажіть Facebook Page ID', 'error');
    return;
  }
  if (!igUserId) {
    showOAuthSnackbar('Вкажіть Instagram User ID (Business account)', 'error');
    return;
  }
  if (!/^\d+$/.test(igUserId)) {
    showOAuthSnackbar('Instagram User ID — лише цифри (з instagram_business_account.id)', 'error');
    return;
  }
  const tokenDraft = integrations.value.meta.pageAccessToken.trim();
  const tokenIsMask =
    tokenDraft === '••••••' || tokenDraft === META_TOKEN_MASK || tokenDraft.startsWith('••••••');
  if (!tokenDraft && !metaPageTokenMasked.value) {
    showOAuthSnackbar('Потрібен Page Access Token — OAuth або вставте токен вручну', 'error');
    return;
  }

  savingMeta.value = true;
  metaSaved.value = false;
  error.value = '';
  try {
    const payload: Record<string, string> = {
      pageId,
      igUserId,
      igUsername: integrations.value.meta.igUsername.trim().replace(/^@+/, ''),
    };
    const token = integrations.value.meta.pageAccessToken.trim();
    if (token && !tokenIsMask) {
      payload.pageAccessToken = token;
    }

    await api.put('/settings/integrations', {
      integration_meta: payload,
    });
    metaSaved.value = true;
    metaPageTokenReplacing.value = false;
    await fetchIntegrations();
    showOAuthSnackbar('Instagram / Meta збережено', 'success');
  } catch (e: any) {
    error.value = e.response?.data?.error ?? 'Не вдалося зберегти Instagram';
    showOAuthSnackbar(error.value, 'error');
  } finally {
    savingMeta.value = false;
  }
}

// ── Instagram disconnect ────────────────────────────────────────────────────

const metaConnected = computed(
  () =>
    !!integrations.value.meta.pageId ||
    !!integrations.value.meta.igUserId ||
    !!integrations.value.meta.pageAccessToken ||
    metaPageTokenMasked.value,
);

const metaNeedsManualIg = computed(
  () =>
    (!!integrations.value.meta.pageId || metaPageTokenMasked.value) &&
    !integrations.value.meta.igUserId,
);

const metaDisconnectDialog = ref(false);
const metaDisconnectLoading = ref(false);

async function disconnectMeta() {
  metaDisconnectLoading.value = true;
  try {
    await api.post('/settings/meta/disconnect');

    integrations.value.meta = {
      pageId: '',
      pageAccessToken: '',
      igUserId: '',
      igUsername: '',
    };
    metaPageTokenMasked.value = false;
    metaPageTokenReplacing.value = false;
    igStatus.value = null;
    igImportResult.value = null;
    igDebugResult.value = null;

    metaDisconnectDialog.value = false;
    showOAuthSnackbar('Instagram відвʼязано. Бот більше не обробляє повідомлення.', 'info');
  } catch (e: any) {
    showOAuthSnackbar(e.response?.data?.error ?? 'Не вдалося відвʼязати Instagram', 'error');
  } finally {
    metaDisconnectLoading.value = false;
  }
}

const scheduleMode = ref<'24_7' | 'schedule'>('schedule');

// ── Runtime mode (Public / Debug) ───────────────────────────────────────────

type RuntimeModeValue = 'public' | 'debug';

const runtimeMode = ref<RuntimeModeValue>('public');
const debugWhitelistRaw = ref('');
const runtimeBackfillLimit = ref<number>(200);
const runtimeBackfillLoading = ref(false);
const runtimeBackfillResult = ref<ImportRecentResult | null>(null);
const runtimeBackfillIsEmpty = computed(
  () =>
    !!runtimeBackfillResult.value &&
    runtimeBackfillResult.value.conversationsImported === 0 &&
    runtimeBackfillResult.value.conversationsSkipped === 0,
);

const debugWhitelistParsed = computed<string[]>(() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of debugWhitelistRaw.value.split(/[,\n]/)) {
    const h = part.trim().replace(/^@+/, '').toLowerCase();
    if (h && !seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  return out;
});

const runtimeBackfillError = ref('');

async function runRuntimeBackfill() {
  const limit = Math.max(10, Math.min(500, runtimeBackfillLimit.value || 200));
  runtimeBackfillLoading.value = true;
  runtimeBackfillResult.value = null;
  runtimeBackfillError.value = '';
  try {
    const { data } = await api.post<ImportRecentResult>(
      '/settings/meta/import-recent-conversations',
      { limit },
    );
    runtimeBackfillResult.value = data;
  } catch (e: any) {
    runtimeBackfillError.value = e.response?.data?.error ?? 'Не вдалося завантажити розмови';
  } finally {
    runtimeBackfillLoading.value = false;
  }
}

// ── Runtime-mode autosave ───────────────────────────────────────────────────
// Runtime mode (Public/Debug) is flipped often during testing, so we save
// it immediately on any change instead of waiting for "Зберегти налаштування".
// Debounce to 500ms so typing in the whitelist textarea doesn't spam the API.
type RuntimeSaveState = 'idle' | 'saving' | 'saved' | 'error';
const runtimeSaveState = ref<RuntimeSaveState>('idle');
let runtimeSaveTimer: ReturnType<typeof setTimeout> | null = null;
let runtimeHydrated = false;

async function saveRuntimeModeNow() {
  runtimeSaveState.value = 'saving';
  try {
    await api.put('/settings', {
      runtime_mode: {
        mode: runtimeMode.value,
        debugWhitelist: debugWhitelistParsed.value,
        backfillLimit: Math.max(10, Math.min(500, runtimeBackfillLimit.value || 200)),
      },
    });
    runtimeSaveState.value = 'saved';
    setTimeout(() => {
      if (runtimeSaveState.value === 'saved') runtimeSaveState.value = 'idle';
    }, 2000);
  } catch {
    runtimeSaveState.value = 'error';
  }
}

function scheduleRuntimeSave() {
  if (!runtimeHydrated) return;
  if (runtimeSaveTimer) clearTimeout(runtimeSaveTimer);
  runtimeSaveTimer = setTimeout(() => {
    saveRuntimeModeNow();
  }, 500);
}

watch([runtimeMode, debugWhitelistRaw, runtimeBackfillLimit], scheduleRuntimeSave);

type AgentModeValue = 'sales' | 'leadgen';
type OutOfHoursStrategyValue = 'warn_early' | 'defer_to_end';

interface AgentConfigShape {
  mode: AgentModeValue;
  outOfHoursStrategy: OutOfHoursStrategyValue;
  managerSlaHoursBusiness: number;
  sessionFreshnessDays: number;
}

const agentConfig = ref<AgentConfigShape>({
  mode: 'sales',
  outOfHoursStrategy: 'warn_early',
  managerSlaHoursBusiness: 2,
  sessionFreshnessDays: 14,
});

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

function onScheduleModeChange(mode: '24_7' | 'schedule' | null) {
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
      scheduleMode.value = all247 ? '24_7' : 'schedule';
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

    if (data.agent_config && typeof data.agent_config === 'object') {
      const raw = data.agent_config as Partial<AgentConfigShape>;
      agentConfig.value = {
        mode: raw.mode === 'leadgen' ? 'leadgen' : 'sales',
        outOfHoursStrategy:
          raw.outOfHoursStrategy === 'defer_to_end' ? 'defer_to_end' : 'warn_early',
        managerSlaHoursBusiness:
          typeof raw.managerSlaHoursBusiness === 'number' && raw.managerSlaHoursBusiness > 0
            ? raw.managerSlaHoursBusiness
            : 2,
        sessionFreshnessDays:
          typeof raw.sessionFreshnessDays === 'number' && raw.sessionFreshnessDays > 0
            ? raw.sessionFreshnessDays
            : 14,
      };
    }

    if (data.runtime_mode && typeof data.runtime_mode === 'object') {
      const raw = data.runtime_mode as {
        mode?: string;
        debugWhitelist?: unknown;
        backfillLimit?: number;
      };
      runtimeMode.value = raw.mode === 'debug' ? 'debug' : 'public';
      const list = Array.isArray(raw.debugWhitelist)
        ? raw.debugWhitelist.filter((v): v is string => typeof v === 'string')
        : [];
      debugWhitelistRaw.value = list.join(', ');
      runtimeBackfillLimit.value =
        typeof raw.backfillLimit === 'number' && raw.backfillLimit > 0
          ? Math.min(500, Math.floor(raw.backfillLimit))
          : 200;
    }
  } catch {
    error.value = 'Не вдалося завантажити налаштування';
  } finally {
    loading.value = false;
    runtimeHydrated = true;
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
      agent_config: agentConfig.value,
      runtime_mode: {
        mode: runtimeMode.value,
        debugWhitelist: debugWhitelistParsed.value,
        backfillLimit: Math.max(10, Math.min(500, runtimeBackfillLimit.value || 200)),
      },
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

    metaPageTokenMasked.value = m.pageAccessToken === '••••••';
    metaPageTokenReplacing.value = false;
    integrations.value.meta = {
      pageId:          m.pageId          ?? '',
      pageAccessToken: metaPageTokenMasked.value ? META_TOKEN_MASK : (m.pageAccessToken ?? ''),
      igUserId:        m.igUserId        ?? '',
      igUsername:      m.igUsername      ?? '',
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

<style scoped>
/* ── Section divider title ─────────────────────────────────────────────── */
.integrations-title {
  font-size: 15px;
  font-weight: 700;
  color: #0a2540;
  letter-spacing: -0.01em;
  margin-bottom: 12px;
}

/* ── Card density: tighter titles & content ────────────────────────────── */
:deep(.v-card) {
  margin-bottom: 12px;
}

:deep(.v-card-title) {
  font-size: 14px !important;
  font-weight: 600 !important;
  line-height: 1.35 !important;
  padding: 14px 16px 6px !important;
  min-height: unset !important;
  letter-spacing: -0.01em;
}

:deep(.v-card-subtitle) {
  font-size: 12px !important;
  line-height: 1.4 !important;
  padding: 0 16px 10px !important;
  color: #6c7688 !important;
  opacity: 1 !important;
}

/* Remove top gap between subtitle and card-text */
:deep(.v-card-text) {
  padding-top: 0 !important;
  padding-left: 16px !important;
  padding-right: 16px !important;
  padding-bottom: 14px !important;
}

/* ── Icon + title vertical centering ───────────────────────────────────── */
:deep(.v-card-title .v-icon) {
  vertical-align: middle;
  margin-top: -1px;
}

/* ── Chip in runtime-mode header: keep on same baseline ───────────────── */
:deep(.v-card-title .v-chip) {
  vertical-align: middle;
}

/* ── Radio group ────────────────────────────────────────────────────────── */
:deep(.v-radio-group .v-selection-control-group) {
  gap: 2px !important;
}

.radio-label {
  padding: 2px 0;
  line-height: 1.3;
}

/* ── Debug whitelist block ──────────────────────────────────────────────── */
.debug-whitelist-block {
  margin-top: 8px;
  padding: 10px 12px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
}

/* ── Backfill row ───────────────────────────────────────────────────────── */
.backfill-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}

.backfill-info {
  flex: 1;
  min-width: 180px;
}

.backfill-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.backfill-count {
  width: 130px;
}

/* ── Health check list ─────────────────────────────────────────────────── */
.health-check-list {
  border: 1px solid #e8ecf1;
  border-radius: 8px;
  overflow: hidden;
}

.health-check-item + .health-check-item {
  border-top: 1px solid #e8ecf1;
}

/* ── Dense divider inside cards ────────────────────────────────────────── */
:deep(.v-card-text .v-divider) {
  margin-top: 12px !important;
  margin-bottom: 12px !important;
}
</style>
