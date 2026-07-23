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
      <v-row>
        <v-col cols="12" lg="3" class="settings-nav-col">
          <v-select
            class="d-lg-none mb-4"
            :model-value="activeSection"
            :items="settingsNavFlat"
            item-title="title"
            item-value="id"
            label="Розділ"
            variant="outlined"
            density="compact"
            hide-details
            @update:model-value="onMobileSectionSelect"
          />
          <v-card variant="outlined" class="settings-nav-card mb-4 d-none d-lg-block">
            <v-list density="compact" nav>
              <template v-for="(group, gi) in settingsNavGroups" :key="group.label">
                <v-divider v-if="gi > 0" class="my-2" />
                <v-list-subheader>{{ group.label }}</v-list-subheader>
                <v-list-item
                  v-for="item in group.items"
                  :key="item.id"
                  :prepend-icon="item.icon"
                  :title="item.title"
                  :active="activeSection === item.id"
                  color="primary"
                  rounded
                  @click="selectSection(item.id)"
                />
              </template>
              <v-divider class="my-2" />
              <v-list-item
                prepend-icon="mdi-sync"
                title="Синхронізація"
                subtitle="Каталог / CRM"
                rounded
                :to="{ name: 'sync' }"
              />
            </v-list>
          </v-card>
        </v-col>
        <v-col cols="12" lg="9">

      <div v-if="activeSection === 'settings-health'" class="settings-section">
      <!-- Health Check -->
      <v-card id="settings-health" class="mb-4">
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
      </div>

      <div v-if="activeSection === 'settings-claude'" class="settings-section">
      <!-- Claude CLI auth -->
      <v-card id="settings-claude" class="mb-4">
        <v-card-title class="d-flex align-center flex-wrap ga-2">
          <v-icon start color="indigo">mdi-login</v-icon>
          <span>Claude — авторизація агента</span>
          <v-chip
            v-if="claudeAuth"
            size="small"
            :color="claudeAuthChipColor"
            variant="tonal"
          >
            {{ claudeAuthStatusLabel }}
          </v-chip>
        </v-card-title>
        <v-card-subtitle class="pb-2">
          Статус підписки Claude Pro або Max для роботи AI-агента в Direct.
        </v-card-subtitle>
        <v-card-text>
          <div class="d-flex flex-wrap align-center ga-2 mb-3">
            <v-btn
              v-if="showClaudeAuthorizeButton"
              color="indigo"
              variant="flat"
              prepend-icon="mdi-login"
              :loading="claudeLoginLoading"
              :disabled="claudeLoginLoading || claudeAuthLoading"
              @click="startClaudeLogin"
            >
              {{ claudeAuthorizeButtonLabel }}
            </v-btn>
            <v-btn
              color="indigo"
              variant="tonal"
              prepend-icon="mdi-refresh"
              :loading="claudeAuthLoading"
              :disabled="claudeAuthLoading"
              @click="loadClaudeAuth(true)"
            >
              Перевірити статус
            </v-btn>
          </div>

          <v-alert
            v-if="claudeAuthLoading && !claudeAuth"
            type="info"
            variant="tonal"
            density="compact"
            class="mb-3"
          >
            Перевіряємо статус Claude…
          </v-alert>

          <v-alert
            v-if="claudeAuthError"
            type="error"
            variant="tonal"
            density="compact"
            class="mb-3"
          >
            {{ claudeAuthError }}
          </v-alert>

          <v-alert
            v-if="claudeAuth && !claudeAuth.loggedIn && !claudeLoginActive"
            :type="claudeAuth.sessionExpired ? 'warning' : 'info'"
            variant="tonal"
            density="compact"
            class="mb-3"
          >
            <div class="font-weight-medium mb-1">
              {{ claudeAuthNeedsAuthTitle }}
            </div>
            <div class="text-caption">
              AI-агент не може відповідати клієнтам, поки не увійдете в підписку Claude
              (Pro або Max) з цього акаунта.
            </div>
            <div v-if="claudeAuth.email" class="text-caption mt-2 text-medium-emphasis">
              Останній акаунт: {{ claudeAuth.email }}
              <span v-if="claudeAuth.subscriptionType"> · {{ claudeAuth.subscriptionType }}</span>
            </div>
          </v-alert>

          <v-card
            v-if="claudeLoginActive"
            variant="outlined"
            class="mb-3"
          >
            <v-card-title class="text-body-1 font-weight-medium py-3">
              Вхід у Claude
            </v-card-title>
            <v-card-text class="pt-0">
              <v-alert
                v-if="claudeLoginError"
                type="error"
                variant="tonal"
                density="compact"
                class="mb-3"
              >
                {{ claudeLoginError }}
              </v-alert>

              <v-stepper
                :model-value="claudeLoginStep"
                flat
                class="claude-login-stepper"
              >
                <v-stepper-header>
                  <v-stepper-item :value="1" title="Посилання" />
                  <v-divider />
                  <v-stepper-item :value="2" title="Код" />
                  <v-divider />
                  <v-stepper-item :value="3" title="Готово" />
                </v-stepper-header>
              </v-stepper>

              <div v-if="claudeLoginStep === 1" class="mt-3">
                <p class="text-body-2 mb-2">
                  1. Відкрийте посилання в браузері, де ви вже залогінені в Claude
                  (той самий акаунт Pro/Max).
                </p>
                <p v-if="!claudeLoginAuthUrl" class="text-caption text-medium-emphasis mb-2">
                  Генеруємо посилання…
                </p>
                <v-text-field
                  v-else
                  :model-value="claudeLoginAuthUrl"
                  label="Посилання для авторизації"
                  readonly
                  density="compact"
                  variant="outlined"
                  hide-details
                  class="mb-2"
                />
                <div class="d-flex flex-wrap ga-2">
                  <v-btn
                    color="indigo"
                    variant="flat"
                    size="small"
                    prepend-icon="mdi-open-in-new"
                    :disabled="!claudeLoginAuthUrl"
                    @click="openClaudeAuthUrl"
                  >
                    Відкрити в браузері
                  </v-btn>
                  <v-btn
                    variant="tonal"
                    size="small"
                    prepend-icon="mdi-content-copy"
                    :disabled="!claudeLoginAuthUrl"
                    @click="copyClaudeAuthUrl"
                  >
                    Копіювати
                  </v-btn>
                </div>
                <p class="text-caption text-medium-emphasis mt-3 mb-0">
                  Після підтвердження в браузері скопіюйте код і перейдіть до кроку 2.
                  На вхід є 5 хвилин.
                </p>
              </div>

              <div v-else-if="claudeLoginStep === 2" class="mt-3">
                <p class="text-body-2 mb-2">
                  2. Вставте код з браузера після підтвердження доступу.
                </p>
                <v-alert
                  v-if="claudeLoginCodeSubmitted"
                  type="info"
                  variant="tonal"
                  density="compact"
                  class="mb-3"
                >
                  Код надіслано — перевіряємо авторизацію…
                </v-alert>
                <v-text-field
                  v-model="claudeLoginCode"
                  label="Код авторизації"
                  placeholder="PaZZ6JWg...#jrzWU1LEs..."
                  density="compact"
                  variant="outlined"
                  hide-details
                  class="mb-3"
                  autocomplete="off"
                  :disabled="claudeLoginCodeSubmitted"
                  @keyup.enter="submitClaudeLoginCode"
                />
                <div class="d-flex flex-wrap ga-2">
                  <v-btn
                    color="indigo"
                    variant="flat"
                    size="small"
                    prepend-icon="mdi-check"
                    :loading="claudeLoginSubmitting"
                    :disabled="!claudeLoginCode.trim() || claudeLoginSubmitting"
                    @click="submitClaudeLoginCode"
                  >
                    Підтвердити
                  </v-btn>
                  <v-btn
                    variant="text"
                    size="small"
                    @click="claudeLoginStep = 1"
                  >
                    Назад до посилання
                  </v-btn>
                </div>
              </div>

              <div v-else class="mt-3">
                <v-alert type="success" variant="tonal" density="compact">
                  Claude авторизовано. Агент знову може відповідати клієнтам.
                </v-alert>
              </div>

              <div v-if="claudeLoginStep < 3" class="d-flex flex-wrap ga-2 mt-4">
                <v-btn
                  v-if="claudeLoginAuthUrl && claudeLoginStep === 1"
                  variant="tonal"
                  size="small"
                  :loading="claudeLoginAdvancing"
                  :disabled="claudeLoginAdvancing"
                  @click="advanceToClaudeCodeStep"
                >
                  Маю код — далі
                </v-btn>
                <v-btn
                  variant="text"
                  size="small"
                  color="error"
                  :disabled="claudeLoginLoading"
                  @click="cancelClaudeLogin"
                >
                  Скасувати
                </v-btn>
              </div>
            </v-card-text>
          </v-card>

          <v-list v-if="claudeAuth && claudeAuth.loggedIn" density="compact" class="pa-0">
            <v-list-item class="px-0">
              <v-list-item-title class="text-body-2">Акаунт</v-list-item-title>
              <v-list-item-subtitle class="text-caption">
                {{ claudeAuth.email || '—' }}
                <span v-if="claudeAuth.subscriptionType"> · {{ claudeAuth.subscriptionType }}</span>
              </v-list-item-subtitle>
            </v-list-item>
          </v-list>
        </v-card-text>
      </v-card>

      <!-- Claude subscription usage -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center flex-wrap ga-2">
          <v-icon start color="deep-purple">mdi-gauge</v-icon>
          <span>Claude — ліміти підписки</span>
          <v-chip
            v-if="claudeUsageSnapshot && claudeAuth?.loggedIn"
            size="small"
            :color="claudeUsageStatusColor"
            variant="tonal"
          >
            {{ claudeUsageStatusLabel }}
          </v-chip>
        </v-card-title>
        <v-card-subtitle class="pb-2">
          Автоперевірка кожні {{ claudeUsageCheckIntervalMin }} хв через <code>claude /usage</code>
          (лише коли Claude авторизовано).
          Telegram-сповіщення при ≥{{ claudeUsageWarningPercent }}% або вичерпаному ліміті.
        </v-card-subtitle>
        <v-card-text>
          <v-alert
            v-if="claudeAuth && !claudeAuth.loggedIn"
            type="info"
            variant="tonal"
            density="compact"
            class="mb-3"
          >
            Ліміти підписки з’являться після авторизації Claude.
            Поки агент не увійшов — live-перевірка <code>/usage</code> не запускається.
          </v-alert>

          <template v-else>
          <div class="d-flex flex-wrap align-center ga-2 mb-3">
            <v-btn
              color="deep-purple"
              variant="tonal"
              prepend-icon="mdi-refresh"
              :loading="claudeUsageLoading"
              :disabled="claudeUsageLoading || !claudeAuth?.loggedIn"
              @click="refreshClaudeUsage(true)"
            >
              Оновити зараз
            </v-btn>
            <span v-if="claudeUsageSnapshot" class="text-caption text-medium-emphasis">
              Остання перевірка: {{ formatHealthCheckTime(claudeUsageSnapshot.checkedAt) }}
            </span>
          </div>

          <v-alert
            v-if="claudeUsageError"
            type="error"
            variant="tonal"
            density="compact"
            class="mb-3"
          >
            {{ claudeUsageError }}
          </v-alert>

          <v-alert
            v-else-if="claudeUsageSnapshot"
            :type="claudeUsageAlertType"
            variant="tonal"
            density="compact"
            class="mb-3"
            :text="claudeUsageSnapshot.message"
          />

          <div v-if="claudeUsageSnapshot?.subscriptionType" class="text-caption text-medium-emphasis mb-3">
            План: <strong>{{ claudeUsageSnapshot.subscriptionType }}</strong>
            <span v-if="claudeUsageSnapshot.authEmail"> · {{ claudeUsageSnapshot.authEmail }}</span>
          </div>

          <v-row v-if="claudeUsageSnapshot?.buckets?.length" dense>
            <v-col
              v-for="bucket in claudeUsageSnapshot.buckets"
              :key="bucket.id"
              cols="12"
              md="6"
            >
              <div class="text-body-2 font-weight-medium mb-1">{{ bucket.label }}</div>
              <v-progress-linear
                :model-value="bucket.percentUsed"
                :color="claudeUsageBarColor(bucket.percentUsed)"
                height="10"
                rounded
              />
              <div class="text-caption text-medium-emphasis mt-1">
                {{ bucket.percentUsed }}% · скидання {{ bucket.resetsAt }}
              </div>
            </v-col>
          </v-row>
          </template>
        </v-card-text>
      </v-card>

      <!-- Runtime mode (Public / Debug) -->
      </div>

      <div v-if="activeSection === 'settings-runtime'" class="settings-section">
      <v-card id="settings-runtime" class="mb-4">
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

          <div class="bot-ignore-block">
            <div class="text-subtitle-2 d-flex align-center ga-2 mb-1">
              <v-icon size="16">mdi-account-cancel-outline</v-icon>
              Чорний список @нікнеймів
            </div>
            <div class="text-caption text-medium-emphasis mb-1">
              Бот <strong>ніколи не відповідає</strong> цим користувачам — у Public і Debug.
              Повідомлення зберігаються в діалозі, менеджер може відповісти вручну.
              Через кому, регістр не важливий.
            </div>
            <v-textarea
              v-model="botIgnoreUsernamesRaw"
              variant="outlined"
              density="compact"
              rows="2"
              auto-grow
              hide-details
              placeholder="@spam_account, @competitor_brand"
            />
            <div v-if="botIgnoreUsernamesParsed.length > 0" class="d-flex flex-wrap ga-1 mt-2">
              <v-chip
                v-for="tag in botIgnoreUsernamesParsed"
                :key="tag"
                size="x-small"
                color="error"
                variant="tonal"
                prepend-icon="mdi-at"
              >
                {{ tag }}
              </v-chip>
            </div>
          </div>

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
        <v-card-title class="d-flex align-center flex-wrap ga-2">
          <v-icon start color="primary">mdi-robot</v-icon>
          <span>Режим роботи AI-агента</span>
          <v-chip
            v-if="scheduleSaveState === 'saving'"
            size="small"
            color="primary"
            variant="tonal"
            prepend-icon="mdi-content-save-outline"
          >
            Зберігаю…
          </v-chip>
          <v-chip
            v-else-if="scheduleSaveState === 'saved'"
            size="small"
            color="success"
            variant="tonal"
            prepend-icon="mdi-check"
          >
            Збережено
          </v-chip>
          <v-chip
            v-else-if="scheduleSaveState === 'error'"
            size="small"
            color="error"
            variant="tonal"
            prepend-icon="mdi-alert-circle-outline"
          >
            Помилка збереження
          </v-chip>
        </v-card-title>
        <v-card-text>
          <v-alert type="info" variant="tonal" density="compact" class="mb-4">
            AI-агент може працювати <strong>24/7</strong> без перерв. Робочі години впливають лише на те,
            чи відповідає бот автоматично, чи надсилає шаблон "ми зараз не працюємо".
            Зміни зберігаються одразу.
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
      </div>

      <div v-if="activeSection === 'settings-agent'" class="settings-section">
      <!-- Agent type & SLA (agent_config) -->
      <v-card id="settings-agent" class="mb-4">
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
                  { title: 'Запис (booking) — салон, послуги, CleverBOX', value: 'booking' },
                ]"
                item-title="title"
                item-value="value"
                label="Режим агента"
                variant="outlined"
                density="compact"
                hide-details
              />
              <div class="text-caption text-medium-emphasis mt-1">
                <strong>sales</strong>: collect_order; <strong>leadgen</strong>: submit_brief;
                <strong>booking</strong>: search_services + book_appointment (CleverBOX).
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
            <v-col cols="12" sm="6">
              <v-text-field
                v-model.number="agentConfig.responseDelayMinSeconds"
                type="number"
                min="0"
                max="60"
                label="Затримка відповіді: від (сек)"
                variant="outlined"
                density="compact"
                hide-details
              />
              <div class="text-caption text-medium-emphasis mt-1">
                0 = відповідати одразу після coalesce. Typing показується під час паузи.
              </div>
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model.number="agentConfig.responseDelayMaxSeconds"
                type="number"
                min="0"
                max="60"
                label="Затримка відповіді: до (сек)"
                variant="outlined"
                density="compact"
                hide-details
              />
              <div class="text-caption text-medium-emphasis mt-1">
                Випадкова пауза в діапазоні [від; до], макс. 60 с. Якщо рівні — фіксована затримка.
              </div>
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- Smart-trigger: remarketing silence follow-up -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start color="teal">mdi-bell-ring-outline</v-icon>
          Smart-trigger (ремаркетинг)
        </v-card-title>
        <v-card-subtitle class="pb-2">
          Якщо бот написав, а клієнт не відповів — один раз надіслати нагадування після паузи (у годинах).
          Після відповіді клієнта лічильник скидається.
        </v-card-subtitle>
        <v-card-text>
          <v-switch
            v-model="followUpConfig.enabled"
            label="Увімкнути Smart-trigger (ремаркетинг)"
            color="teal"
            hide-details
            class="mb-3"
          />
          <v-row dense>
            <v-col cols="12" sm="4">
              <v-text-field
                v-model.number="followUpConfig.delayHours"
                type="number"
                min="1"
                max="168"
                label="Затримка (годин)"
                variant="outlined"
                density="compact"
                hint="За замовчуванням 72 (3 дні), максимум 168 (7 днів)"
                persistent-hint
                :disabled="!followUpConfig.enabled"
              />
            </v-col>
            <v-col cols="12" sm="8">
              <v-textarea
                v-model="followUpConfig.template"
                label="Текст нагадування"
                variant="outlined"
                density="compact"
                rows="3"
                auto-grow
                hide-details
                :disabled="!followUpConfig.enabled"
              />
            </v-col>
          </v-row>
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
          <v-text-field
            v-model.number="handoffReturnToBotMinutes"
            class="mt-4"
            type="number"
            min="0"
            max="10080"
            variant="outlined"
            hide-details
            suffix="хв"
            label="Повернути боту, якщо менеджер не завершив"
          />
          <div class="text-caption text-medium-emphasis mt-1">
            Після перехоплення бот знову підхопить діалог, якщо менеджер не писав клієнту вказаний час.
            0 — вимкнено. За замовчуванням: 60 хв.
          </div>
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
      </div>

      <div v-if="activeSection === 'settings-crm-routing'" class="settings-section">
      <CrmRoutingCard v-model="crmRouting" />
      </div>

      <div v-if="activeSection === 'settings-branches'" class="settings-section">
      <BranchesCard />

      </div>

      <div v-if="activeSection === 'settings-instagram'" class="settings-section">
      <!-- Instagram -->
      <v-card id="settings-instagram" class="mb-4">
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

      <IntegrationsSaveBar
        :saving="savingIntegrations"
        :saved="integrationsSaved"
        @save="saveIntegrations"
      />
      </div>

      <div v-if="activeSection === 'settings-telegram'" class="settings-section">
      <TelegramBotsCard
        v-model="integrations.telegram.bots"
        :saving="savingIntegrations"
        @save="saveTelegramBots"
      >
        <template #actions>
          <v-btn
            color="primary"
            variant="tonal"
            size="small"
            prepend-icon="mdi-send"
            :loading="telegramTestLoading === 'connectivity'"
            :disabled="!!telegramTestLoading"
            @click="sendTelegramTest('connectivity')"
          >
            Тест Telegram
          </v-btn>
          <v-btn
            color="deep-purple"
            variant="tonal"
            size="small"
            prepend-icon="mdi-robot-outline"
            :loading="telegramTestLoading === 'meta_agent'"
            :disabled="!!telegramTestLoading"
            @click="sendTelegramTest('meta_agent')"
          >
            Тест сповіщення мета-агента
          </v-btn>
          <v-btn
            color="amber-darken-2"
            variant="outlined"
            size="small"
            prepend-icon="mdi-brain"
            :loading="metaAgentTestLoading"
            :disabled="metaAgentTestLoading"
            @click="runMetaAgentClaudeTest"
          >
            Перевірити мета-агента (Claude)
          </v-btn>
        </template>
      </TelegramBotsCard>

      <v-alert
        v-if="telegramTestResult"
        :type="telegramTestResult.ok ? 'success' : 'error'"
        variant="tonal"
        density="compact"
        class="mb-4"
        closable
        @click:close="telegramTestResult = null"
      >
        {{ telegramTestResult.message }}
        <div v-if="telegramTestResult.sentTo?.length" class="text-caption mt-1">
          Групи: {{ telegramTestResult.sentTo.join(', ') }}
        </div>
      </v-alert>

      <v-alert
        v-if="metaAgentTestResult"
        :type="metaAgentTestResult.ok ? 'success' : 'warning'"
        variant="tonal"
        density="compact"
        class="mb-4"
        closable
        @click:close="metaAgentTestResult = null"
      >
        <div class="font-weight-medium">{{ metaAgentTestResult.message }}</div>
        <div v-if="metaAgentTestResult.reply" class="text-body-2 mt-2" style="white-space: pre-wrap;">
          {{ metaAgentTestResult.reply }}
        </div>
      </v-alert>
      </div>

      <div v-if="activeSection === 'settings-keycrm'" class="settings-section">
      <!-- KeyCRM -->
      <v-card id="settings-keycrm" class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start color="green-darken-1">mdi-database-sync</v-icon>
          KeyCRM
        </v-card-title>
        <v-card-subtitle class="pb-2">API ключ, джерело замовлень і синхронізація каталогу</v-card-subtitle>
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
                <li>
                  <strong>URL веб-інтерфейсу KeyCRM</strong> — адреса вашого акаунту (наприклад
                  <code>https://blessed.keycrm.app</code> або <code>app.keycrm.app</code>).
                  Потрібна для кнопки «Відкрити в KeyCRM» у замовленнях. Open API домен не повертає —
                  вкажіть вручну те посилання, з якого ви заходите в KeyCRM.
                </li>
                <li>
                  <strong>ID джерела замовлень (source_id)</strong> — обовʼязковий для API при створенні замовлень ботом:
                  <ol class="pl-4 mt-1" style="line-height:1.8;">
                    <li>KeyCRM → <strong>Налаштування → Джерела</strong> (або «Джерела замовлень»).</li>
                    <li>Створіть джерело типу <strong>Інше</strong>, напр. «Instagram AI Agent».</li>
                    <li>У списку джерел наведіть на іконку <strong>i</strong> біля назви — там числовий <strong>ID</strong>.</li>
                    <li>Вставте це число в поле нижче. Замовлення з бота потраплятимуть у KeyCRM з цим джерелом.</li>
                  </ol>
                  Якщо поле порожнє — використовується <code>KEYCRM_DEFAULT_SOURCE_ID</code> з .env (зазвичай <code>1</code>).
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
            <v-col cols="12" sm="5">
              <v-text-field
                v-model.number="integrations.keycrm.defaultSourceId"
                label="ID джерела замовлень (source_id)"
                type="number"
                variant="outlined"
                density="compact"
                hide-details
                min="1"
                placeholder="напр. 245"
                hint="KeyCRM → Налаштування → Джерела → іконка i"
                persistent-hint
              />
            </v-col>
            <v-col cols="12">
              <v-text-field
                v-model="integrations.keycrm.appUrl"
                label="URL веб-інтерфейсу KeyCRM"
                variant="outlined"
                density="compact"
                placeholder="https://blessed.keycrm.app"
                hint="Для кнопки «Відкрити в KeyCRM» у замовленнях (без URL кнопка не показується)"
                persistent-hint
              />
            </v-col>
          </v-row>

          <v-switch
            v-model="featureFlags.crm_write_enabled"
            color="primary"
            hide-details
            class="mt-4"
          >
            <template #label>
              <div>
                <strong>Записувати замовлення в KeyCRM</strong>
                <div class="text-caption text-medium-emphasis">
                  Каталог синхронізується завжди (read). Цей перемикач вмикає створення замовлень і клієнтів у CRM.
                  Альтернатива: <code>CRM_WRITE_ENABLED=true</code> у .env на сервері.
                </div>
              </div>
            </template>
          </v-switch>
        </v-card-text>
      </v-card>

      <IntegrationsSaveBar
        :saving="savingIntegrations"
        :saved="integrationsSaved"
        @save="saveIntegrations"
      />
      </div>

      <div v-if="activeSection === 'settings-cleverbox'" class="settings-section">
      <CleverboxCard v-model="integrations.cleverbox" />

      <IntegrationsSaveBar
        :saving="savingIntegrations"
        :saved="integrationsSaved"
        @save="saveIntegrations"
      />
      </div>

      <div v-if="activeSection === 'settings-beautypro'" class="settings-section">
      <BeautyproCard v-model="integrations.beautypro" />

      <IntegrationsSaveBar
        :saving="savingIntegrations"
        :saved="integrationsSaved"
        @save="saveIntegrations"
      />
      </div>

      <div v-if="activeSection === 'settings-novaposhta'" class="settings-section">
      <!-- Nova Poshta -->
      <v-card id="settings-novaposhta" class="mb-4">
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

      <IntegrationsSaveBar
        :saving="savingIntegrations"
        :saved="integrationsSaved"
        @save="saveIntegrations"
      />
      </div>

      <div v-if="activeSection === 'settings-account'" class="settings-section">
      <!-- Account security -->
      <v-card id="settings-account" class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon start color="primary">mdi-shield-key</v-icon>
          Обліковий запис
        </v-card-title>
        <v-card-subtitle class="pb-2">
          Зміна пароля для входу в цю панель. Логін:
          <strong>{{ accountUsername }}</strong>
          (зазвичай <code>admin</code>).
        </v-card-subtitle>
        <v-card-text>
          <v-alert
            v-if="passwordChangeError"
            type="error"
            variant="tonal"
            density="compact"
            class="mb-3"
          >
            {{ passwordChangeError }}
          </v-alert>
          <v-row dense>
            <v-col cols="12" md="4">
              <v-text-field
                v-model="passwordForm.currentPassword"
                label="Поточний пароль"
                :type="showAccountSecrets.current ? 'text' : 'password'"
                variant="outlined"
                density="compact"
                autocomplete="current-password"
                :append-inner-icon="showAccountSecrets.current ? 'mdi-eye-off' : 'mdi-eye'"
                @click:append-inner="showAccountSecrets.current = !showAccountSecrets.current"
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field
                v-model="passwordForm.newPassword"
                label="Новий пароль"
                :type="showAccountSecrets.next ? 'text' : 'password'"
                variant="outlined"
                density="compact"
                autocomplete="new-password"
                hint="Щонайменше 12 символів"
                persistent-hint
                :append-inner-icon="showAccountSecrets.next ? 'mdi-eye-off' : 'mdi-eye'"
                @click:append-inner="showAccountSecrets.next = !showAccountSecrets.next"
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field
                v-model="passwordForm.confirmPassword"
                label="Підтвердження"
                :type="showAccountSecrets.confirm ? 'text' : 'password'"
                variant="outlined"
                density="compact"
                autocomplete="new-password"
                :append-inner-icon="showAccountSecrets.confirm ? 'mdi-eye-off' : 'mdi-eye'"
                @click:append-inner="showAccountSecrets.confirm = !showAccountSecrets.confirm"
              />
            </v-col>
          </v-row>
          <v-btn
            color="primary"
            variant="tonal"
            prepend-icon="mdi-lock-reset"
            :loading="passwordChangeLoading"
            :disabled="passwordChangeLoading"
            @click="submitPasswordChange"
          >
            Змінити пароль
          </v-btn>
        </v-card-text>
      </v-card>

      <!-- Danger zone -->
      <v-card class="mb-4 danger-zone-card" variant="outlined">
        <v-card-title class="d-flex align-center text-error">
          <v-icon start color="error">mdi-alert-octagon-outline</v-icon>
          Небезпечна зона
        </v-card-title>
        <v-card-subtitle class="pb-2">
          Незворотні дії. Використовуйте після зміни Instagram-акаунта або для повного скидання історії чатів.
        </v-card-subtitle>
        <v-card-text>
          <p class="text-body-2 mb-3">
            Видаляє <strong>усіх клієнтів</strong>, <strong>діалоги</strong>, <strong>повідомлення</strong>,
            замовлення та брифі з бази цього тенанта. Instagram DM у Meta не чіпається — лише локальна копія.
          </p>
          <v-btn
            color="error"
            variant="outlined"
            prepend-icon="mdi-delete-sweep"
            :loading="purgeDialogsLoading"
            :disabled="purgeDialogsLoading"
            @click="purgeDialogsDialog = true"
          >
            Очистити всі діалоги
          </v-btn>
        </v-card-text>
      </v-card>
      </div>

      <v-alert v-if="error" type="error" density="compact" class="mb-4">
        {{ error }}
      </v-alert>
      <v-snackbar v-model="passwordChangeSuccess" color="success" :timeout="4000">
        Пароль змінено. Сесію оновлено.
      </v-snackbar>
      <v-snackbar v-model="success" color="success" :timeout="3000">
        Налаштування збережено
      </v-snackbar>
      <v-snackbar v-model="oauthSnackbar" :color="oauthSnackbarColor" :timeout="4000">
        {{ oauthSnackbarText }}
      </v-snackbar>

      <v-dialog v-model="telegramTestDialog" max-width="440">
        <v-card>
          <v-card-title class="text-h6">Тест Telegram</v-card-title>
          <v-card-text>
            Токен збережено. Спочатку напишіть боту <code>/login &lt;пароль&gt;</code> у особистих повідомленнях,
            потім надішліть тест (або додайте бота в групу).
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="text" @click="telegramTestDialog = false">Пізніше</v-btn>
            <v-btn
              color="primary"
              variant="flat"
              :loading="telegramTestLoading === 'connectivity'"
              @click="sendTelegramTest('connectivity', true)"
            >
              Надіслати тест
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

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

      <!-- Purge all dialogs confirmation -->
      <v-dialog v-model="purgeDialogsDialog" max-width="520" persistent>
        <v-card>
          <v-card-title class="d-flex align-center text-error">
            <v-icon start color="error">mdi-delete-sweep</v-icon>
            Очистити всі діалоги?
          </v-card-title>
          <v-card-text class="text-body-2">
            <v-alert type="error" variant="tonal" density="compact" class="mb-3">
              Цю дію <strong>неможливо скасувати</strong>.
            </v-alert>
            <ul class="pl-4 mb-3" style="line-height: 1.6;">
              <li>Усі клієнти та їхні IG/Telegram ID в адмінці будуть видалені.</li>
              <li>Зникнуть історія повідомлень, замовлення та брифі.</li>
              <li>Після перепідключення Instagram знову зʼявляться лише <strong>нові</strong> вхідні DM.</li>
              <li>Налаштування, промпти та інтеграції <strong>не</strong> змінюються.</li>
            </ul>
            <p class="mb-2">
              Щоб підтвердити, введіть:
              <code class="text-error">{{ purgeDialogsConfirmPhrase }}</code>
            </p>
            <v-text-field
              v-model="purgeDialogsConfirmInput"
              label="Підтвердження"
              variant="outlined"
              density="compact"
              hide-details
              autocomplete="off"
              :disabled="purgeDialogsLoading"
              @keyup.enter="purgeAllDialogs"
            />
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn
              variant="text"
              :disabled="purgeDialogsLoading"
              @click="closePurgeDialogsDialog"
            >
              Скасувати
            </v-btn>
            <v-btn
              color="error"
              variant="flat"
              prepend-icon="mdi-delete-forever"
              :loading="purgeDialogsLoading"
              :disabled="!purgeDialogsConfirmReady"
              @click="purgeAllDialogs"
            >
              Видалити назавжди
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
        </v-col>
      </v-row>
    </template>
  </v-container>

</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import api from '@/api';
import { useAuthStore } from '@/stores/auth';
import BranchesCard from '@/components/settings/BranchesCard.vue';
import CrmRoutingCard, { type CrmRoutingShape } from '@/components/settings/CrmRoutingCard.vue';
import CleverboxCard from '@/components/settings/CleverboxCard.vue';
import BeautyproCard from '@/components/settings/BeautyproCard.vue';
import TelegramBotsCard, { type TelegramBotForm } from '@/components/settings/TelegramBotsCard.vue';
import IntegrationsSaveBar from '@/components/settings/IntegrationsSaveBar.vue';

const settingsNavGroups = [
  {
    label: 'Система',
    items: [
      { id: 'settings-health', title: 'Health Check', icon: 'mdi-heart-pulse' },
      { id: 'settings-claude', title: 'Claude', icon: 'mdi-robot' },
      { id: 'settings-runtime', title: 'Режим бота', icon: 'mdi-toggle-switch' },
      { id: 'settings-agent', title: 'Агент і SLA', icon: 'mdi-head-cog' },
    ],
  },
  {
    label: 'CRM і філії',
    items: [
      { id: 'settings-crm-routing', title: 'CRM routing', icon: 'mdi-routes' },
      { id: 'settings-branches', title: 'Філії', icon: 'mdi-store-marker' },
    ],
  },
  {
    label: 'Інтеграції',
    items: [
      { id: 'settings-instagram', title: 'Instagram', icon: 'mdi-instagram' },
      { id: 'settings-telegram', title: 'Telegram', icon: 'mdi-send' },
      { id: 'settings-keycrm', title: 'KeyCRM', icon: 'mdi-database' },
      { id: 'settings-cleverbox', title: 'CleverBOX', icon: 'mdi-calendar-clock' },
      { id: 'settings-beautypro', title: 'BeautyPro', icon: 'mdi-spa' },
      { id: 'settings-novaposhta', title: 'Нова Пошта', icon: 'mdi-truck-fast' },
    ],
  },
  {
    label: 'Акаунт',
    items: [
      { id: 'settings-account', title: 'Обліковий запис', icon: 'mdi-account-key' },
    ],
  },
] as const;

type SettingsSectionId = (typeof settingsNavGroups)[number]['items'][number]['id'];

const settingsNavFlat = settingsNavGroups.flatMap((g) => [...g.items]);

const activeSection = ref<SettingsSectionId>('settings-health');
const integrationsLoaded = ref(false);
const claudeSectionLoaded = ref(false);

const INTEGRATION_SECTION_SET = new Set<string>([
  'settings-instagram',
  'settings-telegram',
  'settings-keycrm',
  'settings-cleverbox',
  'settings-beautypro',
  'settings-novaposhta',
]);

function selectSection(id: SettingsSectionId) {
  activeSection.value = id;
  if (typeof history !== 'undefined' && history.replaceState) {
    history.replaceState(null, '', `#${id}`);
  }
  void ensureSectionData(id);
}

function onMobileSectionSelect(id: unknown) {
  if (typeof id !== 'string') return;
  if (!settingsNavFlat.some((item) => item.id === id)) return;
  selectSection(id as SettingsSectionId);
}

async function ensureSectionData(id: SettingsSectionId) {
  if (INTEGRATION_SECTION_SET.has(id) && !integrationsLoaded.value) {
    await fetchIntegrations();
    integrationsLoaded.value = true;
  }
  if (id === 'settings-claude' && !claudeSectionLoaded.value) {
    // Cached auth + DB usage snapshot only — no live Haiku probe / /usage spawn on open.
    await loadClaudeAuth(false, false).then(() => resumeClaudeLoginIfNeeded());
    await refreshClaudeUsage(false);
    claudeSectionLoaded.value = true;
  }
}

const authStore = useAuthStore();
const accountUsername = computed(() => authStore.user?.username ?? 'admin');

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

const loading = ref(true);
const saving = ref(false);
const savingIntegrations = ref(false);
const integrationsSaved = ref(false);

type TelegramTestVariant = 'connectivity' | 'meta_agent';

interface TelegramTestResponse {
  ok: boolean;
  message: string;
  sentTo?: string[];
}

interface MetaAgentTestResponse {
  ok: boolean;
  message: string;
  reply?: string;
  durationMs?: number;
}

const telegramTestLoading = ref<TelegramTestVariant | ''>('');
const telegramTestResult = ref<TelegramTestResponse | null>(null);
const telegramTestDialog = ref(false);
const metaAgentTestLoading = ref(false);
const metaAgentTestResult = ref<MetaAgentTestResponse | null>(null);

const error = ref('');
const success = ref(false);

const passwordForm = ref({
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
});
const showAccountSecrets = ref({
  current: false,
  next: false,
  confirm: false,
});
const passwordChangeLoading = ref(false);
const passwordChangeError = ref('');
const passwordChangeSuccess = ref(false);

async function submitPasswordChange() {
  passwordChangeError.value = '';
  passwordChangeLoading.value = true;
  try {
    await authStore.changePassword(
      passwordForm.value.currentPassword,
      passwordForm.value.newPassword,
      passwordForm.value.confirmPassword,
    );
    passwordForm.value = { currentPassword: '', newPassword: '', confirmPassword: '' };
    passwordChangeSuccess.value = true;
  } catch (e: any) {
    passwordChangeError.value =
      e.response?.data?.error ?? 'Не вдалося змінити пароль';
  } finally {
    passwordChangeLoading.value = false;
  }
}

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
    bots: [] as TelegramBotForm[],
  },
  keycrm: {
    apiKey: '',
    syncIntervalMin: 30,
    defaultSourceId: 1,
    appUrl: '',
  },
  cleverbox: {
    apiToken: '',
    defaultBranchId: '',
    syncIntervalMin: 60,
  },
  beautypro: {
    applicationId: '',
    applicationSecret: '',
    databaseCode: '',
    defaultLocationId: '',
    syncIntervalMin: 60,
    accessToken: '',
    refreshToken: '',
    tokenExpiresAt: '',
    apiServer: 1,
    authStatus: '' as '' | 'pending' | 'granted' | 'refused',
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

interface ClaudeAuthStatus {
  binaryOk: boolean;
  binaryPath: string;
  binaryVersion: string | null;
  loggedIn: boolean;
  sessionExpired: boolean;
  previouslyAuthorized: boolean;
  authMethod: string | null;
  email: string | null;
  subscriptionType: string | null;
  orgName: string | null;
  error: string | null;
  loginInProgress: boolean;
}

const claudeAuthLoading = ref(false);
const claudeAuthError = ref('');
const claudeAuth = ref<ClaudeAuthStatus | null>(null);

const claudeAuthStatusLabel = computed(() => {
  if (!claudeAuth.value) return '—';
  if (claudeAuth.value.loggedIn) return 'Авторизовано';
  if (claudeAuth.value.sessionExpired) return 'Сесія застаріла';
  if (!claudeAuth.value.binaryOk) return 'Недоступно';
  if (!claudeAuth.value.previouslyAuthorized) return 'Не авторизовано';
  return 'Потрібна авторизація';
});

const claudeAuthChipColor = computed(() => {
  if (!claudeAuth.value) return 'grey';
  if (claudeAuth.value.loggedIn) return 'success';
  if (claudeAuth.value.sessionExpired) return 'error';
  if (!claudeAuth.value.binaryOk) return 'error';
  return 'warning';
});

const claudeAuthorizeButtonLabel = computed(() => {
  if (!claudeAuth.value || !claudeAuth.value.previouslyAuthorized) {
    return 'Авторизувати Claude';
  }
  return claudeAuth.value.sessionExpired ? 'Увійти знову' : 'Увійти в Claude';
});

const claudeAuthNeedsAuthTitle = computed(() => {
  if (!claudeAuth.value) return 'Потрібна авторизація агента';
  if (claudeAuth.value.sessionExpired) return 'Сесія Claude застаріла';
  if (!claudeAuth.value.previouslyAuthorized) return 'Claude ще не авторизовано';
  return 'Потрібна авторизація агента';
});

async function loadClaudeAuth(manual = false, fresh = manual) {
  if (manual || !claudeAuth.value) claudeAuthLoading.value = true;
  claudeAuthError.value = '';
  try {
    const { data } = await api.get<ClaudeAuthStatus>('/settings/claude-auth', {
      params: manual || fresh ? { fresh: 'true' } : undefined,
    });
    claudeAuth.value = data;
  } catch (e: any) {
    claudeAuthError.value = e.response?.data?.error ?? 'Не вдалося перевірити Claude';
    if (manual) claudeAuth.value = null;
  } finally {
    claudeAuthLoading.value = false;
  }
}

interface ClaudeLoginStartResult {
  sessionId: string;
  authUrl: string | null;
  status: string;
  error: string | null;
}

interface ClaudeLoginStatusResult {
  sessionId: string;
  status: string;
  authUrl: string | null;
  error: string | null;
  expectsCode: boolean;
  codeSubmitted: boolean;
  auth: ClaudeAuthStatus | null;
}

const CLAUDE_LOGIN_SESSION_KEY = 'claude_login_session_id';
const claudeLoginSessionId = ref('');
const claudeLoginAuthUrl = ref<string | null>(null);
const claudeLoginCode = ref('');
const claudeLoginStep = ref(1);
const claudeLoginLoading = ref(false);
const claudeLoginAdvancing = ref(false);
const claudeLoginSubmitting = ref(false);
const claudeLoginCodeSubmitted = ref(false);
const claudeLoginError = ref('');
let claudeLoginPollTimer: ReturnType<typeof setInterval> | null = null;

const claudeLoginActive = computed(() => !!claudeLoginSessionId.value);

const showClaudeAuthorizeButton = computed(() => {
  if (claudeLoginActive.value) return false;
  if (claudeAuthLoading.value && !claudeAuth.value) return true;
  if (!claudeAuth.value) return false;
  return claudeAuth.value.binaryOk && !claudeAuth.value.loggedIn;
});

function stopClaudeLoginPoll() {
  if (claudeLoginPollTimer) {
    clearInterval(claudeLoginPollTimer);
    claudeLoginPollTimer = null;
  }
}

function resetClaudeLoginUi() {
  stopClaudeLoginPoll();
  claudeLoginSessionId.value = '';
  claudeLoginAuthUrl.value = null;
  claudeLoginCode.value = '';
  claudeLoginStep.value = 1;
  claudeLoginError.value = '';
  claudeLoginLoading.value = false;
  claudeLoginAdvancing.value = false;
  claudeLoginSubmitting.value = false;
  claudeLoginCodeSubmitted.value = false;
  sessionStorage.removeItem(CLAUDE_LOGIN_SESSION_KEY);
}

async function pollClaudeLoginStatus(): Promise<ClaudeLoginStatusResult | null> {
  if (!claudeLoginSessionId.value) return null;
  try {
    const { data } = await api.get<ClaudeLoginStatusResult>('/settings/claude-auth/login/status', {
      params: { sessionId: claudeLoginSessionId.value },
    });
    if (data.authUrl && !claudeLoginAuthUrl.value) {
      claudeLoginAuthUrl.value = data.authUrl;
    }
    if (data.codeSubmitted) {
      claudeLoginCodeSubmitted.value = true;
    }
    if (data.status === 'completed' && data.auth?.loggedIn) {
      stopClaudeLoginPoll();
      claudeLoginStep.value = 3;
      claudeLoginLoading.value = false;
      claudeLoginAdvancing.value = false;
      claudeLoginSubmitting.value = false;
      claudeLoginCodeSubmitted.value = false;
      claudeAuth.value = data.auth;
      void refreshClaudeUsage(true);
      setTimeout(() => resetClaudeLoginUi(), 2500);
      return data;
    }
    if (data.status === 'completed' && !data.auth?.loggedIn) {
      stopClaudeLoginPoll();
      claudeLoginError.value = data.auth?.error ?? 'Авторизацію не завершено';
      claudeLoginLoading.value = false;
      claudeLoginAdvancing.value = false;
      claudeLoginSubmitting.value = false;
      return data;
    }
    if (data.status === 'failed' || data.status === 'cancelled') {
      stopClaudeLoginPoll();
      claudeLoginError.value = data.error ?? 'Авторизацію не завершено';
      claudeLoginLoading.value = false;
      claudeLoginAdvancing.value = false;
      claudeLoginSubmitting.value = false;
      return data;
    }
    return data;
  } catch (e: any) {
    if (e.response?.status === 404) {
      stopClaudeLoginPoll();
      claudeLoginError.value = 'Сесія входу закінчилась (5 хвилин). Почніть заново.';
      claudeLoginLoading.value = false;
      claudeLoginAdvancing.value = false;
      claudeLoginSubmitting.value = false;
      resetClaudeLoginUi();
    }
    return null;
  }
}

function startClaudeLoginPoll() {
  stopClaudeLoginPoll();
  void pollClaudeLoginStatus();
  claudeLoginPollTimer = setInterval(() => {
    void pollClaudeLoginStatus();
  }, 2000);
}

async function advanceToClaudeCodeStep() {
  if (claudeLoginAdvancing.value || !claudeLoginSessionId.value) return;
  claudeLoginAdvancing.value = true;
  claudeLoginError.value = '';
  try {
    const data = await pollClaudeLoginStatus();
    if (!data) return;
    if (data.status === 'completed') return;
    if (data.status === 'failed' || data.status === 'cancelled') return;
    if (data.expectsCode) {
      claudeLoginStep.value = 2;
      return;
    }
    claudeLoginError.value =
      data.error ?? 'Сесія ще не готова прийняти код — зачекайте кілька секунд і спробуйте знову';
  } finally {
    claudeLoginAdvancing.value = false;
  }
}

async function startClaudeLogin() {
  if (claudeLoginLoading.value) return;
  resetClaudeLoginUi();
  claudeLoginLoading.value = true;
  claudeLoginError.value = '';
  try {
    const { data } = await api.post<ClaudeLoginStartResult>('/settings/claude-auth/login/start');
    if (!data.sessionId) {
      claudeLoginError.value = data.error ?? 'Не вдалося запустити вхід';
      return;
    }
    claudeLoginSessionId.value = data.sessionId;
    sessionStorage.setItem(CLAUDE_LOGIN_SESSION_KEY, data.sessionId);
    claudeLoginAuthUrl.value = data.authUrl;
    claudeLoginStep.value = 1;
    startClaudeLoginPoll();
  } catch (e: any) {
    claudeLoginError.value = e.response?.data?.error ?? 'Не вдалося запустити вхід у Claude';
  } finally {
    claudeLoginLoading.value = false;
  }
}

function openClaudeAuthUrl() {
  if (!claudeLoginAuthUrl.value) return;
  window.open(claudeLoginAuthUrl.value, 'claude_oauth', 'width=640,height=720,scrollbars=yes');
}

async function copyClaudeAuthUrl() {
  if (!claudeLoginAuthUrl.value) return;
  try {
    await navigator.clipboard.writeText(claudeLoginAuthUrl.value);
    showOAuthSnackbar('Посилання скопійовано', 'success');
  } catch {
    showOAuthSnackbar('Не вдалося скопіювати — виділіть текст вручну', 'warning');
  }
}

async function submitClaudeLoginCode() {
  const code = claudeLoginCode.value.trim();
  if (!code || !claudeLoginSessionId.value || claudeLoginSubmitting.value || claudeLoginCodeSubmitted.value) {
    return;
  }
  claudeLoginSubmitting.value = true;
  claudeLoginError.value = '';
  try {
    await api.post('/settings/claude-auth/login/code', {
      sessionId: claudeLoginSessionId.value,
      code,
    });
    claudeLoginCodeSubmitted.value = true;
    startClaudeLoginPoll();
  } catch (e: any) {
    claudeLoginError.value = e.response?.data?.error ?? 'Не вдалося надіслати код';
    claudeLoginSubmitting.value = false;
  }
}

async function cancelClaudeLogin() {
  const sessionId = claudeLoginSessionId.value;
  resetClaudeLoginUi();
  if (sessionId) {
    try {
      await api.post('/settings/claude-auth/login/cancel', { sessionId });
    } catch {
      /* ignore */
    }
  }
}

async function resumeClaudeLoginIfNeeded() {
  const saved = sessionStorage.getItem(CLAUDE_LOGIN_SESSION_KEY);
  if (!saved || claudeAuth.value?.loggedIn) return;
  claudeLoginSessionId.value = saved;
  claudeLoginStep.value = 1;
  startClaudeLoginPoll();
}

interface ClaudeUsageBucket {
  id: string;
  label: string;
  percentUsed: number;
  resetsAt: string;
}

interface ClaudeUsageSnapshot {
  checkedAt: string;
  status: 'ok' | 'warning' | 'exhausted' | 'unavailable';
  subscriptionType: string | null;
  authEmail: string | null;
  buckets: ClaudeUsageBucket[];
  worstPercent: number;
  message: string;
}

const claudeUsageLoading = ref(false);
const claudeUsageError = ref('');
const claudeUsageSnapshot = ref<ClaudeUsageSnapshot | null>(null);
const claudeUsageCheckIntervalMin = ref(30);
const claudeUsageWarningPercent = ref(90);

const claudeUsageStatusColor = computed(() => {
  const s = claudeUsageSnapshot.value?.status;
  if (s === 'exhausted') return 'error';
  if (s === 'warning') return 'warning';
  if (s === 'unavailable') return 'grey';
  return 'success';
});

const claudeUsageStatusLabel = computed(() => {
  const s = claudeUsageSnapshot.value?.status;
  if (s === 'exhausted') return 'Вичерпано';
  if (s === 'warning') return 'Майже ліміт';
  if (s === 'unavailable') return 'Недоступно';
  return 'OK';
});

const claudeUsageAlertType = computed(() => {
  const s = claudeUsageSnapshot.value?.status;
  if (s === 'exhausted') return 'error';
  if (s === 'warning') return 'warning';
  return 'info';
});

function claudeUsageBarColor(percent: number): string {
  if (percent >= 100) return 'error';
  if (percent >= claudeUsageWarningPercent.value) return 'warning';
  return 'success';
}

async function refreshClaudeUsage(live = false) {
  claudeUsageLoading.value = true;
  claudeUsageError.value = '';
  try {
    const { data } = live
      ? await api.post<{
          snapshot: ClaudeUsageSnapshot;
          checkIntervalMin: number;
          warningPercent: number;
        }>('/settings/claude-usage/check')
      : await api.get<{
          snapshot: ClaudeUsageSnapshot | null;
          checkIntervalMin: number;
          warningPercent: number;
        }>('/settings/claude-usage');
    claudeUsageSnapshot.value = data.snapshot;
    claudeUsageCheckIntervalMin.value = data.checkIntervalMin;
    claudeUsageWarningPercent.value = data.warningPercent;
  } catch (e: any) {
    claudeUsageError.value = e.response?.data?.error ?? 'Не вдалося завантажити ліміти Claude';
    claudeUsageSnapshot.value = null;
  } finally {
    claudeUsageLoading.value = false;
  }
}

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

// Derived URLs to display in the setup instructions.
function resolveApiHostFromAdmin(hostname: string): string {
  if (hostname === 'localhost' || hostname === '127.0.0.1') return hostname;
  if (hostname.startsWith('agent.')) return hostname.replace(/^agent\./, 'api.');
  const platform = hostname.match(/^agent-([a-z0-9-]+)\.(.+)$/i);
  if (platform) return `api-${platform[1]}.${platform[2]}`;
  return hostname;
}

const redirectUrl = computed(() => {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:3000/settings/meta/oauth-callback';
  }
  const apiHost = resolveApiHostFromAdmin(host);
  // Platform tenants use a single hub redirect on admin.{base} (see meta-oauth-hub).
  const platformHub = apiHost.match(/^api-([a-z0-9-]+)\.(.+)$/i);
  if (platformHub) {
    return `https://admin.${platformHub[2]}/settings/meta/oauth-callback`;
  }
  return `https://${apiHost}/settings/meta/oauth-callback`;
});
const webhookUrl = computed(() => {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:3000/webhooks/instagram';
  }
  const apiHost = resolveApiHostFromAdmin(host);
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
        void applyOAuthAccount(msg.account as OAuthAccount);
      } else if (msg.type === 'meta_oauth_select') {
        openMetaOAuthSelectDialog(msg);
      } else if (msg.type === 'meta_oauth_partial') {
        void applyOAuthAccount(msg.account as OAuthAccount);
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

async function applyOAuthAccount(account: OAuthAccount) {
  integrations.value.meta.pageId = account.pageId;
  integrations.value.meta.igUserId = account.igUserId ?? '';
  integrations.value.meta.igUsername = account.igUsername ?? '';
  await fetchIntegrations();
  if (account.igUserId) {
    showMetaManualHelp.value = false;
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

    await applyOAuthAccount(data.account);
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

const PURGE_DIALOGS_CONFIRM = 'ВИДАЛИТИ ДІАЛОГИ';
const purgeDialogsDialog = ref(false);
const purgeDialogsConfirmInput = ref('');
const purgeDialogsLoading = ref(false);
const purgeDialogsConfirmPhrase = PURGE_DIALOGS_CONFIRM;
const purgeDialogsConfirmReady = computed(
  () => purgeDialogsConfirmInput.value.trim() === PURGE_DIALOGS_CONFIRM,
);

function closePurgeDialogsDialog() {
  purgeDialogsDialog.value = false;
  purgeDialogsConfirmInput.value = '';
}

async function purgeAllDialogs() {
  if (!purgeDialogsConfirmReady.value || purgeDialogsLoading.value) return;
  purgeDialogsLoading.value = true;
  try {
    const { data } = await api.post<{
      ok: boolean;
      deleted: {
        clients: number;
        conversations: number;
        messages: number;
        orders: number;
        briefs: number;
      };
    }>('/settings/purge-dialogs', { confirm: PURGE_DIALOGS_CONFIRM });

    const d = data.deleted;
    closePurgeDialogsDialog();
    showOAuthSnackbar(
      `Видалено: ${d.clients} клієнтів, ${d.conversations} діалогів, ${d.messages} повідомлень.`,
      'success',
    );
  } catch (e: any) {
    showOAuthSnackbar(
      e.response?.data?.error ?? 'Не вдалося очистити діалоги',
      'error',
    );
  } finally {
    purgeDialogsLoading.value = false;
  }
}

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
const botIgnoreUsernamesRaw = ref('');
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

const botIgnoreUsernamesParsed = computed<string[]>(() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of botIgnoreUsernamesRaw.value.split(/[,\n]/)) {
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
        botIgnoreUsernames: botIgnoreUsernamesParsed.value,
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

watch([runtimeMode, debugWhitelistRaw, botIgnoreUsernamesRaw, runtimeBackfillLimit], scheduleRuntimeSave);

// ── Schedule / working hours autosave ───────────────────────────────────────
// 24/7 vs schedule + day hours should apply immediately (same UX as Public/Debug).
type ScheduleSaveState = 'idle' | 'saving' | 'saved' | 'error';
const scheduleSaveState = ref<ScheduleSaveState>('idle');
let scheduleSaveTimer: ReturnType<typeof setTimeout> | null = null;

async function saveScheduleSettingsNow() {
  scheduleSaveState.value = 'saving';
  try {
    await api.put('/settings', {
      working_hours: workingHours.value,
      out_of_hours_template: outOfHoursTemplate.value,
    });
    scheduleSaveState.value = 'saved';
    setTimeout(() => {
      if (scheduleSaveState.value === 'saved') scheduleSaveState.value = 'idle';
    }, 2000);
  } catch {
    scheduleSaveState.value = 'error';
  }
}

function scheduleScheduleSave() {
  if (!runtimeHydrated) return;
  if (scheduleSaveTimer) clearTimeout(scheduleSaveTimer);
  scheduleSaveTimer = setTimeout(() => {
    void saveScheduleSettingsNow();
  }, 500);
}

type AgentModeValue = 'sales' | 'leadgen' | 'booking';
type OutOfHoursStrategyValue = 'warn_early' | 'defer_to_end';

interface AgentConfigShape {
  mode: AgentModeValue;
  outOfHoursStrategy: OutOfHoursStrategyValue;
  managerSlaHoursBusiness: number;
  sessionFreshnessDays: number;
  responseDelayMinSeconds: number;
  responseDelayMaxSeconds: number;
}

const agentConfig = ref<AgentConfigShape>({
  mode: 'sales',
  outOfHoursStrategy: 'warn_early',
  managerSlaHoursBusiness: 2,
  sessionFreshnessDays: 14,
  responseDelayMinSeconds: 0,
  responseDelayMaxSeconds: 0,
});

const DEFAULT_FOLLOW_UP_TEMPLATE =
  'Вітаю! Чи ще актуальне Ваше питання? Можу допомогти з вибором або оформленням — напишіть, коли буде зручно.';

interface FollowUpConfigShape {
  enabled: boolean;
  delayHours: number;
  template: string;
}

const followUpConfig = ref<FollowUpConfigShape>({
  enabled: false,
  delayHours: 72,
  template: DEFAULT_FOLLOW_UP_TEMPLATE,
});

const defaultCrmRouting = (): CrmRoutingShape => ({
  mode: 'by_action',
  default: 'keycrm',
  enabled_providers: ['keycrm', 'cleverbox'],
  routes: {
    catalog: 'keycrm',
    services: 'cleverbox',
    branches: 'cleverbox',
    booking: 'cleverbox',
    order: 'keycrm',
    lead: 'keycrm',
    client_upsert: 'keycrm',
  },
});

const crmRouting = ref<CrmRoutingShape>(defaultCrmRouting());

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
const handoffReturnToBotMinutes = ref(60);
const featureFlags = ref({
  auto_handoff: true,
  send_typing_indicator: true,
  crm_write_enabled: true,
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
  } else {
    // Leaving 24/7: restore a typical business schedule so "за розкладом" persists on reload
    // (schedule mode is inferred from hours, not a separate Setting key).
    const all247 = days.every((d) => {
      const h = workingHours.value[d.key];
      return h?.enabled && h.start === '00:00' && h.end === '23:59';
    });
    if (all247) {
      for (const day of days) {
        const isWeekend = day.key === 'sat' || day.key === 'sun';
        workingHours.value[day.key] = isWeekend
          ? { start: '10:00', end: '18:00', enabled: day.key === 'sat' }
          : { start: '09:00', end: '20:00', enabled: true };
      }
    }
  }
  scheduleScheduleSave();
}

watch(
  workingHours,
  () => {
    scheduleScheduleSave();
  },
  { deep: true },
);

watch(outOfHoursTemplate, () => {
  scheduleScheduleSave();
});

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

    if (typeof data.handoff_return_to_bot_minutes === 'number') {
      handoffReturnToBotMinutes.value = Math.max(0, Math.floor(data.handoff_return_to_bot_minutes));
    }

    if (data.feature_flags && typeof data.feature_flags === 'object') {
      featureFlags.value = { ...featureFlags.value, ...data.feature_flags };
    }

    if (data.agent_config && typeof data.agent_config === 'object') {
      const raw = data.agent_config as Partial<AgentConfigShape>;
      agentConfig.value = {
        mode:
          raw.mode === 'leadgen'
            ? 'leadgen'
            : raw.mode === 'booking'
              ? 'booking'
              : 'sales',
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
        responseDelayMinSeconds: (() => {
          const n = Number(raw.responseDelayMinSeconds);
          if (!Number.isFinite(n) || n < 0) return 0;
          return Math.min(60, Math.floor(n));
        })(),
        responseDelayMaxSeconds: (() => {
          const n = Number(raw.responseDelayMaxSeconds);
          if (!Number.isFinite(n) || n < 0) return 0;
          return Math.min(60, Math.floor(n));
        })(),
      };
      if (agentConfig.value.responseDelayMaxSeconds < agentConfig.value.responseDelayMinSeconds) {
        agentConfig.value.responseDelayMaxSeconds = agentConfig.value.responseDelayMinSeconds;
      }
    }

    if (data.follow_up_config && typeof data.follow_up_config === 'object') {
      const raw = data.follow_up_config as Partial<FollowUpConfigShape> & {
        delayMinutes?: number;
      };
      const delay =
        typeof raw.delayHours === 'number' && Number.isFinite(raw.delayHours)
          ? Math.max(1, Math.min(168, Math.floor(raw.delayHours)))
          : 72;
      followUpConfig.value = {
        enabled: raw.enabled === true,
        delayHours: delay,
        template:
          typeof raw.template === 'string' && raw.template.trim()
            ? raw.template.trim()
            : DEFAULT_FOLLOW_UP_TEMPLATE,
      };
    }

    if (data.crm_routing && typeof data.crm_routing === 'object') {
      const raw = data.crm_routing as Record<string, unknown>;
      const base = defaultCrmRouting();
      const mode =
        raw.mode === 'single' || raw.mode === 'by_action' || raw.mode === 'prompt'
          ? raw.mode
          : base.mode;
      const defaultProvider =
        raw.default === 'cleverbox' ||
        raw.default === 'keycrm' ||
        raw.default === 'beautypro'
          ? raw.default
          : base.default;
      const enabledRaw = Array.isArray(raw.enabled_providers) ? raw.enabled_providers : [];
      const enabled = enabledRaw.filter(
        (p): p is 'keycrm' | 'cleverbox' | 'beautypro' =>
          p === 'keycrm' || p === 'cleverbox' || p === 'beautypro',
      );
      const routesRaw =
        raw.routes && typeof raw.routes === 'object' && !Array.isArray(raw.routes)
          ? (raw.routes as Record<string, unknown>)
          : {};
      const routes = { ...base.routes };
      for (const [key, val] of Object.entries(routesRaw)) {
        if (val === 'keycrm' || val === 'cleverbox' || val === 'beautypro') {
          routes[key] = val;
        }
      }
      crmRouting.value = {
        mode,
        default: defaultProvider,
        enabled_providers: enabled.length > 0 ? enabled : base.enabled_providers,
        routes,
      };
    }

    if (data.runtime_mode && typeof data.runtime_mode === 'object') {
      const raw = data.runtime_mode as {
        mode?: string;
        debugWhitelist?: unknown;
        botIgnoreUsernames?: unknown;
        backfillLimit?: number;
      };
      runtimeMode.value = raw.mode === 'debug' ? 'debug' : 'public';
      const list = Array.isArray(raw.debugWhitelist)
        ? raw.debugWhitelist.filter((v): v is string => typeof v === 'string')
        : [];
      debugWhitelistRaw.value = list.join(', ');
      const ignoreList = Array.isArray(raw.botIgnoreUsernames)
        ? raw.botIgnoreUsernames.filter((v): v is string => typeof v === 'string')
        : [];
      botIgnoreUsernamesRaw.value = ignoreList.join(', ');
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
      handoff_return_to_bot_minutes: Math.max(
        0,
        Math.min(10080, Math.floor(Number(handoffReturnToBotMinutes.value) || 0)),
      ),
      feature_flags: featureFlags.value,
      agent_config: {
        ...agentConfig.value,
        responseDelayMinSeconds: (() => {
          const n = Math.floor(Number(agentConfig.value.responseDelayMinSeconds) || 0);
          return Math.max(0, Math.min(60, n));
        })(),
        responseDelayMaxSeconds: (() => {
          const min = Math.max(
            0,
            Math.min(60, Math.floor(Number(agentConfig.value.responseDelayMinSeconds) || 0)),
          );
          const max = Math.max(
            0,
            Math.min(60, Math.floor(Number(agentConfig.value.responseDelayMaxSeconds) || 0)),
          );
          return Math.max(min, max);
        })(),
      },
      follow_up_config: {
        enabled: followUpConfig.value.enabled === true,
        delayHours: Math.max(
          1,
          Math.min(168, Math.floor(Number(followUpConfig.value.delayHours) || 72)),
        ),
        template:
          (followUpConfig.value.template || '').trim() || DEFAULT_FOLLOW_UP_TEMPLATE,
      },
      crm_routing: crmRouting.value,
      runtime_mode: {
        mode: runtimeMode.value,
        debugWhitelist: debugWhitelistParsed.value,
        botIgnoreUsernames: botIgnoreUsernamesParsed.value,
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
    const cb = data.integration_cleverbox ?? {};
    const bp = data.integration_beautypro ?? {};
    const np = data.integration_novaposhta ?? {};

    metaPageTokenMasked.value = m.pageAccessToken === '••••••';
    metaPageTokenReplacing.value = false;
    integrations.value.meta = {
      pageId:          m.pageId          ?? '',
      pageAccessToken: metaPageTokenMasked.value ? META_TOKEN_MASK : (m.pageAccessToken ?? ''),
      igUserId:        m.igUserId        ?? '',
      igUsername:      m.igUsername      ?? '',
    };
    integrations.value.telegram = normalizeTelegramFromApi(t);
    integrations.value.keycrm = {
      apiKey:            k.apiKey            ?? '',
      syncIntervalMin:   k.syncIntervalMin   ?? 30,
      defaultSourceId:   typeof k.defaultSourceId === 'number' && k.defaultSourceId > 0
        ? k.defaultSourceId
        : 1,
      appUrl:            typeof k.appUrl === 'string' ? k.appUrl : '',
    };
    integrations.value.cleverbox = {
      apiToken:          cb.apiToken          ?? '',
      defaultBranchId:   cb.defaultBranchId   ?? '',
      syncIntervalMin:   cb.syncIntervalMin   ?? 60,
    };
    const bpAuth =
      bp.authStatus === 'pending' ||
      bp.authStatus === 'granted' ||
      bp.authStatus === 'refused'
        ? bp.authStatus
        : '';
    integrations.value.beautypro = {
      applicationId: bp.applicationId ?? '',
      applicationSecret: bp.applicationSecret ?? '',
      databaseCode: bp.databaseCode ?? '',
      defaultLocationId: bp.defaultLocationId ?? '',
      syncIntervalMin: bp.syncIntervalMin ?? 60,
      accessToken: bp.accessToken ?? '',
      refreshToken: bp.refreshToken ?? '',
      tokenExpiresAt: bp.tokenExpiresAt ?? '',
      apiServer: typeof bp.apiServer === 'number' ? bp.apiServer : 1,
      authStatus: bpAuth,
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

async function sendTelegramTest(variant: TelegramTestVariant, fromDialog = false) {
  telegramTestLoading.value = variant;
  telegramTestResult.value = null;
  try {
    const payload: Record<string, string> = { variant };
    const primary =
      integrations.value.telegram.bots.find((b) => b.isPrimary) ??
      integrations.value.telegram.bots[0];
    const tgToken = (primary?.botToken || integrations.value.telegram.botToken).trim();
    if (tgToken && tgToken !== '••••••') {
      payload.botToken = tgToken;
    }
    const groupId = (primary?.managerGroupId || integrations.value.telegram.managerGroupId).trim();
    if (groupId) {
      payload.managerGroupId = groupId;
    }

    const { data } = await api.post<TelegramTestResponse>('/settings/telegram/test', payload);
    telegramTestResult.value = data;
    if (fromDialog) telegramTestDialog.value = false;
  } catch (e: any) {
    telegramTestResult.value = {
      ok: false,
      message: e.response?.data?.message ?? e.response?.data?.error ?? 'Не вдалося надіслати тест',
      sentTo: e.response?.data?.sentTo,
    };
  } finally {
    telegramTestLoading.value = '';
  }
}

async function runMetaAgentClaudeTest() {
  metaAgentTestLoading.value = true;
  metaAgentTestResult.value = null;
  try {
    const { data } = await api.post<MetaAgentTestResponse>('/settings/meta-agent/test');
    metaAgentTestResult.value = data;
  } catch (e: any) {
    metaAgentTestResult.value = {
      ok: false,
      message: e.response?.data?.message ?? 'Мета-агент не відповів',
      reply: e.response?.data?.reply,
      durationMs: e.response?.data?.durationMs,
    };
  } finally {
    metaAgentTestLoading.value = false;
  }
}

async function saveIntegrations() {
  savingIntegrations.value = true;
  integrationsSaved.value = false;
  error.value = '';
  try {
    const metaPayload: Record<string, unknown> = {
      pageId: integrations.value.meta.pageId,
      igUserId: integrations.value.meta.igUserId,
      igUsername: integrations.value.meta.igUsername,
    };
    const pageToken = integrations.value.meta.pageAccessToken.trim();
    if (pageToken && !pageToken.startsWith('••••••')) {
      metaPayload.pageAccessToken = pageToken;
    }

    const telegramPayload = buildTelegramPayload(integrations.value.telegram);
    const tgTokenUpdated = Boolean(
      (telegramPayload.bots as Array<{ botToken?: string }> | undefined)?.some(
        (b) => typeof b.botToken === 'string' && b.botToken && b.botToken !== '••••••',
      ),
    );

    const keycrmPayload: Record<string, unknown> = {
      syncIntervalMin: integrations.value.keycrm.syncIntervalMin,
      defaultSourceId: integrations.value.keycrm.defaultSourceId,
      appUrl: integrations.value.keycrm.appUrl.trim(),
    };
    const keycrmKey = integrations.value.keycrm.apiKey.trim();
    if (keycrmKey && keycrmKey !== '••••••') {
      keycrmPayload.apiKey = keycrmKey;
    }

    const cleverboxPayload: Record<string, unknown> = {
      defaultBranchId: integrations.value.cleverbox.defaultBranchId.trim(),
      syncIntervalMin: integrations.value.cleverbox.syncIntervalMin,
    };
    const cbToken = integrations.value.cleverbox.apiToken.trim();
    if (cbToken && cbToken !== '••••••') {
      cleverboxPayload.apiToken = cbToken;
    }

    const beautyproPayload: Record<string, unknown> = {
      applicationId: integrations.value.beautypro.applicationId.trim(),
      databaseCode: integrations.value.beautypro.databaseCode.trim(),
      defaultLocationId: integrations.value.beautypro.defaultLocationId.trim(),
      syncIntervalMin: integrations.value.beautypro.syncIntervalMin,
      apiServer: integrations.value.beautypro.apiServer || 1,
      authStatus: integrations.value.beautypro.authStatus || '',
      tokenExpiresAt: integrations.value.beautypro.tokenExpiresAt || '',
    };
    const bpSecret = integrations.value.beautypro.applicationSecret.trim();
    if (bpSecret && bpSecret !== '••••••') {
      beautyproPayload.applicationSecret = bpSecret;
    }
    // Keep existing tokens unless admin pasted new ones (normally managed by adapter)
    const bpAccess = integrations.value.beautypro.accessToken.trim();
    if (bpAccess && bpAccess !== '••••••') {
      beautyproPayload.accessToken = bpAccess;
    }
    const bpRefresh = integrations.value.beautypro.refreshToken.trim();
    if (bpRefresh && bpRefresh !== '••••••') {
      beautyproPayload.refreshToken = bpRefresh;
    }

    const npPayload: Record<string, unknown> = {
      senderCity: integrations.value.novaposhta.senderCity,
      senderCityRef: integrations.value.novaposhta.senderCityRef,
    };
    const npKey = integrations.value.novaposhta.apiKey.trim();
    if (npKey && npKey !== '••••••') {
      npPayload.apiKey = npKey;
    }

    await Promise.all([
      api.put('/settings/integrations', {
        integration_meta: metaPayload,
        integration_telegram: telegramPayload,
        integration_keycrm: keycrmPayload,
        integration_cleverbox: cleverboxPayload,
        integration_beautypro: beautyproPayload,
        integration_novaposhta: npPayload,
      }),
      api.put('/settings', {
        feature_flags: featureFlags.value,
      }),
    ]);
    integrationsSaved.value = true;
    if (tgTokenUpdated) {
      telegramTestDialog.value = true;
    }
  } catch {
    error.value = 'Не вдалося зберегти інтеграції';
  } finally {
    savingIntegrations.value = false;
  }
}

function normalizeTelegramFromApi(t: Record<string, unknown>): typeof integrations.value.telegram {
  const rawBots = Array.isArray(t.bots) ? t.bots : [];
  let bots: TelegramBotForm[] = rawBots.map((raw, i) => {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      id: typeof b.id === 'string' && b.id ? b.id : crypto.randomUUID(),
      label: typeof b.label === 'string' && b.label ? b.label : i === 0 ? 'Основний бот' : `Бот ${i + 1}`,
      rolePrompt: typeof b.rolePrompt === 'string' ? b.rolePrompt : '',
      botToken: typeof b.botToken === 'string' ? b.botToken : '',
      adminPassword: typeof b.adminPassword === 'string' ? b.adminPassword : '',
      managerGroupId: typeof b.managerGroupId === 'string' ? b.managerGroupId : '',
      enabled: b.enabled !== false,
      isPrimary: b.isPrimary === true,
      channels: Array.isArray(b.channels)
        ? (b.channels.filter((c) => typeof c === 'string') as TelegramBotForm['channels'])
        : (['handoff', 'order', 'brief', 'agent_failure', 'crm_fallback', 'auth', 'ops'] as TelegramBotForm['channels']),
    };
  });

  if (bots.length === 0) {
    bots = [
      {
        id: crypto.randomUUID(),
        label: 'Основний бот',
        rolePrompt:
          'Основний бот для сповіщень менеджерам: ескалації, замовлення, ліди, системні алерти.',
        botToken: typeof t.botToken === 'string' ? t.botToken : '',
        adminPassword: typeof t.adminPassword === 'string' ? t.adminPassword : '',
        managerGroupId: typeof t.managerGroupId === 'string' ? t.managerGroupId : '',
        enabled: true,
        isPrimary: true,
        channels: ['handoff', 'order', 'brief', 'agent_failure', 'crm_fallback', 'auth', 'ops'],
      },
    ];
  }

  if (!bots.some((b) => b.isPrimary)) {
    bots[0]!.isPrimary = true;
  }

  const primary = bots.find((b) => b.isPrimary) ?? bots[0]!;
  return {
    botToken: primary.botToken,
    managerGroupId: primary.managerGroupId,
    adminPassword: primary.adminPassword,
    bots,
  };
}

function buildTelegramPayload(tg: typeof integrations.value.telegram): Record<string, unknown> {
  const bots = (tg.bots?.length ? tg.bots : []).map((b) => ({
    id: b.id,
    label: b.label,
    rolePrompt: b.rolePrompt,
    botToken: b.botToken,
    adminPassword: b.adminPassword,
    managerGroupId: b.managerGroupId,
    enabled: b.enabled,
    isPrimary: b.isPrimary,
    channels: b.channels,
  }));
  const primary = bots.find((b) => b.isPrimary) ?? bots[0];
  return {
    botToken: primary?.botToken ?? tg.botToken,
    managerGroupId: primary?.managerGroupId ?? tg.managerGroupId,
    adminPassword: primary?.adminPassword ?? tg.adminPassword,
    bots,
  };
}

async function saveTelegramBots() {
  savingIntegrations.value = true;
  error.value = '';
  try {
    const telegramPayload = buildTelegramPayload(integrations.value.telegram);
    await api.put('/settings/integrations', {
      integration_telegram: telegramPayload,
    });
    integrationsSaved.value = true;
    await fetchIntegrations();
  } catch {
    error.value = 'Не вдалося зберегти Telegram ботів';
  } finally {
    savingIntegrations.value = false;
  }
}

onMounted(async () => {
  await fetchSettings();
  const hash = (typeof location !== 'undefined' ? location.hash : '').replace(/^#/, '');
  const allIds = settingsNavGroups.flatMap((g) => g.items.map((i) => i.id));
  if (allIds.includes(hash as SettingsSectionId)) {
    activeSection.value = hash as SettingsSectionId;
  }
  await ensureSectionData(activeSection.value);
});

onUnmounted(() => {
  stopClaudeLoginPoll();
});
</script>

<style scoped>
.claude-login-stepper :deep(.v-stepper-header) {
  box-shadow: none;
}

/* ── Section divider title ─────────────────────────────────────────────── */
.integrations-title {
  font-size: 15px;
  font-weight: 700;
  color: #0a2540;
  letter-spacing: -0.01em;
  margin-bottom: 12px;
}

.danger-zone-card {
  border-color: rgba(var(--v-theme-error), 0.45) !important;
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

.settings-section {
  min-height: 120px;
}

/* ── Settings side nav ─────────────────────────────────────────────────── */
.settings-nav-col {
  position: relative;
}

@media (min-width: 1280px) {
  .settings-nav-card {
    position: sticky;
    top: 72px;
  }
}

/* ── Dense divider inside cards ────────────────────────────────────────── */
:deep(.v-card-text .v-divider) {
  margin-top: 12px !important;
  margin-bottom: 12px !important;
}
</style>
