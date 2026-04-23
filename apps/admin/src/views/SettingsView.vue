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
            inline
            hide-details
            class="mb-3"
          >
            <v-radio value="public">
              <template #label>
                <div>
                  <strong>Public</strong>
                  <div class="text-caption text-medium-emphasis">
                    Бот відповідає усім клієнтам. Історичні діалоги без відповіді можна дотягнути кнопкою нижче.
                  </div>
                </div>
              </template>
            </v-radio>
            <v-radio value="debug" class="ml-4">
              <template #label>
                <div>
                  <strong>Debug</strong>
                  <div class="text-caption text-medium-emphasis">
                    Бот відповідає лише @нікнеймам з переліку нижче — для тестування на підключеному Instagram.
                  </div>
                </div>
              </template>
            </v-radio>
          </v-radio-group>

          <v-expand-transition>
            <div v-if="runtimeMode === 'debug'" class="mb-1">
              <v-textarea
                v-model="debugWhitelistRaw"
                label="Whitelist @нікнеймів (через кому)"
                variant="outlined"
                density="compact"
                rows="2"
                auto-grow
                hide-details
                placeholder="@olena.kovalenko, @dev_test, your_qa_handle"
              />
              <div class="text-caption text-medium-emphasis mt-1">
                Регістр не важливий, «@» можна залишати або опускати. Повідомлення від інших користувачів ігноруватимуться (не зберігаються в БД, Claude не викликається).
              </div>
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

          <v-divider class="my-4" />

          <div class="text-subtitle-2 mb-2 d-flex align-center ga-2">
            <v-icon size="18">mdi-database-import</v-icon>
            Історичний імпорт IG-розмов
          </div>
          <div class="d-flex flex-wrap align-center ga-2">
            <v-text-field
              v-model.number="runtimeBackfillLimit"
              type="number"
              min="10"
              max="500"
              label="Скільки останніх розмов дотягнути"
              variant="outlined"
              density="compact"
              hide-details
              style="max-width: 260px;"
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
              Завантажити останні {{ runtimeBackfillLimit || 200 }} розмов
            </v-btn>
          </div>
          <div class="text-caption text-medium-emphasis mt-1">
            Імпортує останні <strong>N</strong> IG-тредів (включно з тими, де раніше не було відповіді) — саме це потрібно перед першим перемиканням у Public.
            Перевірте спочатку статус підключення в блоці «Meta / Instagram» нижче.
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
              <li>OAuth був виконаний без <code>instagram_business_manage_messages</code> scope — повторіть авторизацію.</li>
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
            Де взяти ці дані? Натисни тут.
          </v-btn>
          <v-expand-transition>
            <v-alert v-if="showMetaHelp" type="info" variant="tonal" density="compact" class="mb-4 text-body-2">
              <div class="font-weight-bold mb-2">Покрокова інструкція</div>
              <ol class="pl-4" style="line-height:1.8;">
                <li>
                  Відкрийте
                  <a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener">developers.facebook.com/apps</a>
                  → оберіть свій App → <strong>App Settings → Basic</strong>.
                  Скопіюйте <strong>App ID</strong> і <strong>App Secret</strong>.
                </li>
                <li>
                  В <strong>App Settings → Basic → Add Platform → Website</strong> вкажіть
                  <code>https://api.status-blessed.com</code> і збережіть.
                </li>
                <li>
                  В <strong>Facebook Login for Business → Settings → Valid OAuth Redirect URIs</strong>
                  додайте: <code>{{ redirectUrl }}</code>
                </li>
                <li>
                  В <strong>Products → Webhooks → Instagram</strong> вкажіть
                  Callback URL <code>{{ webhookUrl }}</code> і Verify Token нижче.
                </li>
                <li>
                  Переконайтесь що Facebook Сторінка підключена до Instagram Business акаунту
                  в <strong>Business Manager → Accounts → Instagram accounts</strong>.
                </li>
                <li>
                  Натисніть «Авторизуватись через Facebook» — авторизація відкриє Facebook Login,
                  після чого Page ID, Page Access Token та Instagram User ID заповняться автоматично.
                </li>
              </ol>
              <div class="mt-2">
                <a href="https://developers.facebook.com/docs/development/create-an-app/instagram-use-case" target="_blank" rel="noopener">
                  Документація: Instagram use case (Facebook Login) →
                </a>
              </div>
            </v-alert>
          </v-expand-transition>

          <v-row dense>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="integrations.meta.facebookAppId"
                label="Facebook App ID"
                variant="outlined"
                density="compact"
                hide-details
                placeholder="1653252955997185"
              />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="integrations.meta.facebookAppSecret"
                label="Facebook App Secret"
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
                :disabled="!integrations.meta.facebookAppId || !integrations.meta.facebookAppSecret || oauthLoading"
                @click="startMetaOAuth"
              >
                Авторизуватись через Facebook
              </v-btn>
              <span class="text-caption text-medium-emphasis ml-2">
                Заповнить Page ID, Access Token та Instagram User ID автоматично
              </span>
            </v-col>

            <v-col cols="12" sm="6">
              <v-text-field
                v-model="integrations.meta.pageId"
                label="Facebook Page ID"
                variant="outlined"
                density="compact"
                hide-details
                readonly
                placeholder="Заповниться після OAuth"
              />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="integrations.meta.igUserId"
                label="Instagram User ID"
                variant="outlined"
                density="compact"
                hide-details
                readonly
                placeholder="Заповниться після OAuth"
              />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="integrations.meta.igUsername"
                label="Instagram Username"
                variant="outlined"
                density="compact"
                hide-details
                readonly
                placeholder="Заповниться після OAuth"
                prefix="@"
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
            <v-col v-if="integrations.meta.pageAccessToken" cols="12">
              <v-alert type="success" variant="tonal" density="compact" class="text-caption">
                Page Access Token збережено. Токен сторінки безстроковий — переавторизація потрібна лише якщо змінились права.
              </v-alert>
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
            <div>
              <strong>Instagram:</strong>
              {{ igStatus.igAccount.name || igStatus.igAccount.username || igStatus.igAccount.id }}
              <span v-if="igStatus.igAccount.username">(@{{ igStatus.igAccount.username }})</span>
            </div>
            <div v-if="igStatus.igAccount.accountType">
              <strong>Тип:</strong> {{ igStatus.igAccount.accountType }}
            </div>
            <div><strong>User ID:</strong> {{ igStatus.igAccount.id }}</div>
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
              <li>Акаунт не Business/Creator, або OAuth без <code>instagram_business_manage_messages</code> scope — повторіть авторизацію.</li>
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
    facebookAppId: '',
    facebookAppSecret: '',
    pageId: '',
    pageAccessToken: '',
    igUserId: '',
    igUsername: '',
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

// ── Instagram connection status + bulk import ───────────────────────────────

interface IgStatus {
  connected: boolean;
  igAccount?: {
    id: string;
    username?: string;
    name?: string;
    accountType?: string;
  };
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
  igUserId: string;
  igUsername?: string;
}

const oauthLoading = ref(false);
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
  const appId = integrations.value.meta.facebookAppId.trim();
  const appSecret = integrations.value.meta.facebookAppSecret.trim();
  if (!appId || !appSecret || oauthLoading.value) return;

  oauthLoading.value = true;

  try {
    // Save App ID + Secret to DB first so backend can use them in the callback
    await api.put('/settings/integrations', {
      integration_meta: {
        facebookAppId: appId,
        facebookAppSecret: appSecret,
        verifyToken: integrations.value.meta.verifyToken,
      },
    });

    // Get OAuth URL from backend
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

function applyOAuthAccount(account: OAuthAccount) {
  integrations.value.meta.pageId = account.pageId;
  integrations.value.meta.igUserId = account.igUserId;
  integrations.value.meta.igUsername = account.igUsername ?? '';
  // pageAccessToken saved to DB by backend — reload to show masked indicator
  fetchIntegrations();
  showOAuthSnackbar(
    `Підключено @${account.igUsername || account.igUserId} (Page: ${account.pageName || account.pageId}). Webhook підписано.`,
  );
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

    integrations.value.meta = {
      facebookAppId:     m.facebookAppId     ?? '',
      facebookAppSecret: m.facebookAppSecret ?? '',
      pageId:            m.pageId            ?? '',
      pageAccessToken:   m.pageAccessToken   ?? '',
      igUserId:          m.igUserId          ?? '',
      igUsername:        m.igUsername        ?? '',
      verifyToken:       m.verifyToken       ?? '',
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
