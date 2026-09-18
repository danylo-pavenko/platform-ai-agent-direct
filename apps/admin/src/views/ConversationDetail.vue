<template>
  <v-container fluid class="detail-root pa-0" :class="{ 'detail-root--mobile': mobile }">
    <!-- Mobile: slim immersive chat chrome -->
    <header v-if="mobile" class="chat-mobile-top">
      <div class="chat-mobile-bar">
        <v-btn
          icon
          variant="text"
          class="tap-target"
          aria-label="Назад до розмов"
          @click="router.push({ name: 'conversations' })"
        >
          <v-icon>mdi-arrow-left</v-icon>
        </v-btn>
        <button
          type="button"
          class="chat-mobile-identity"
          @click="showProfile = true"
        >
          <span class="chat-mobile-name text-truncate">{{ clientName }}</span>
          <span class="chat-mobile-status">
            <span
              class="chat-status-dot"
              :class="`chat-status-dot--${conversation?.state || 'bot'}`"
              aria-hidden="true"
            />
            <span class="text-truncate">{{ mobileStatusLine }}</span>
            <span v-if="livePollActive" class="chat-live-dot" title="На звʼязку" />
          </span>
        </button>
        <v-btn
          icon
          variant="text"
          class="tap-target"
          aria-label="Профіль"
          @click="showProfile = true"
        >
          <v-icon>mdi-account-circle-outline</v-icon>
        </v-btn>
        <v-menu location="bottom end">
          <template #activator="{ props: menuProps }">
            <v-btn
              v-bind="menuProps"
              icon
              variant="text"
              class="tap-target"
              aria-label="Ще"
            >
              <v-icon>mdi-dots-vertical</v-icon>
            </v-btn>
          </template>
          <v-list density="comfortable" min-width="220">
            <v-list-item
              prepend-icon="mdi-robot-outline"
              title="Керування ботом"
              @click="mobileControlsSheet = 'bot'"
            />
            <v-list-item
              prepend-icon="mdi-star-outline"
              title="Якість ліда"
              @click="mobileControlsSheet = 'quality'"
            />
            <v-list-item
              prepend-icon="mdi-brain"
              title="Навчити агента"
              @click="router.push({ name: 'teach', query: { conversationId: conversation?.id } })"
            />
            <v-list-item
              v-if="authStore.isOwner"
              prepend-icon="mdi-message-text-remove-outline"
              title="Очистити переписку"
              base-color="error"
              @click="clearChatDialog = true"
            />
          </v-list>
        </v-menu>
      </div>

      <button
        v-if="conversation?.state === 'handoff' && conversation?.handoffReason"
        type="button"
        class="chat-handoff-compact"
        @click="handoffExpanded = !handoffExpanded"
      >
        <v-icon size="16" color="info">mdi-account-arrow-right</v-icon>
        <span class="chat-handoff-compact__text" :class="{ 'is-expanded': handoffExpanded }">
          {{ conversation.handoffReason }}
        </span>
        <v-icon size="16">{{ handoffExpanded ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon>
      </button>
    </header>

    <div class="detail-layout" :class="{ 'with-profile': showProfile && !mobile }">
      <!-- Main: chat -->
      <div class="chat-col d-flex flex-column">
        <!-- Desktop header -->
        <div v-if="!mobile" class="chat-header d-flex align-center pa-3 ga-2">
          <v-btn icon variant="text" size="small" @click="router.push({ name: 'conversations' })">
            <v-icon>mdi-arrow-left</v-icon>
          </v-btn>
          <div class="flex-grow-1" style="min-width: 0;">
            <div class="text-subtitle-2 font-weight-bold text-truncate">{{ clientName }}</div>
            <div class="text-caption text-grey">
              {{ conversation?.channel?.toUpperCase() }} · #{{ conversation?.id?.substring(0, 8) }}
            </div>
          </div>
          <v-chip v-if="conversation?.state" :color="stateColor(conversation.state)" size="small" label>
            {{ stateLabel(conversation.state) }}
          </v-chip>
          <v-chip
            v-if="livePollActive"
            size="x-small"
            color="success"
            variant="tonal"
            class="live-chip"
          >
            <v-icon start size="12">mdi-access-point</v-icon>
            На звʼязку
          </v-chip>
          <v-btn
            :icon="showProfile ? 'mdi-account-details' : 'mdi-account-details-outline'"
            variant="text"
            size="small"
            title="Профіль клієнта"
            @click="showProfile = !showProfile"
          />
          <v-btn
            icon="mdi-brain"
            variant="text"
            size="small"
            title="Навчити агента на цьому діалозі"
            @click="router.push({ name: 'teach', query: { conversationId: conversation?.id } })"
          />
        </div>

        <v-divider v-if="!mobile" />

        <!-- Quality + bot controls: desktop always; mobile via bottom sheets -->
        <template v-if="conversation && !mobile">
        <div class="quality-bar d-flex align-center ga-2 px-3 py-2">
          <span class="text-caption text-grey">Якість ліда:</span>
          <v-rating
            :model-value="qualityDraft ?? 0"
            :length="5"
            size="small"
            color="amber"
            active-color="amber"
            hover
            clearable
            density="compact"
            :disabled="qualitySaving"
            @update:model-value="onQualityChange"
          />
          <span v-if="qualityDraft != null" class="text-caption font-weight-medium">{{ qualityDraft }} / 5</span>
          <v-spacer />
          <v-btn
            size="x-small"
            variant="text"
            density="compact"
            :prepend-icon="showQualityNote ? 'mdi-chevron-up' : 'mdi-note-text-outline'"
            @click="showQualityNote = !showQualityNote"
          >
            Нотатка
          </v-btn>
        </div>
        <div v-if="showQualityNote" class="px-3 pb-2 d-flex ga-2 align-end">
          <v-textarea
            v-model="qualityNoteDraft"
            placeholder="Чому така оцінка? (опційно)"
            variant="outlined"
            density="compact"
            rows="1"
            auto-grow
            hide-details
            :disabled="qualitySaving"
          />
          <v-btn
            size="small"
            color="primary"
            variant="tonal"
            :loading="qualitySaving"
            :disabled="qualityNoteDraft === (conversation?.briefQualityNote ?? '')"
            @click="saveQualityNote"
          >
            Зберегти
          </v-btn>
        </div>
        <div
          v-if="conversation?.state === 'handoff' && conversation?.handoffReason"
          class="handoff-reason-banner mx-3 mt-2 mb-1 pa-3"
        >
          <div class="handoff-reason-title text-caption font-weight-bold mb-1">
            Причина передачі менеджеру
          </div>
          <div class="handoff-reason-body text-body-2">
            {{ conversation.handoffReason }}
          </div>
        </div>

        <div class="bot-control-bar d-flex flex-column ga-2 px-3 py-2">
          <div class="d-flex align-center ga-2 flex-wrap">
            <v-switch
              :model-value="botResponsesEnabled"
              :loading="botResponsesSaving"
              :disabled="botResponsesSaving || isGloballyIgnored"
              color="primary"
              density="compact"
              hide-details
              inset
              @update:model-value="onBotResponsesToggle"
            >
              <template #label>
                <span class="text-body-2">Бот відповідає</span>
              </template>
            </v-switch>
            <v-chip
              v-if="isGloballyIgnored"
              size="x-small"
              color="error"
              variant="tonal"
              prepend-icon="mdi-account-cancel"
            >
              У глобальному чорному списку
            </v-chip>
            <v-chip
              v-else-if="conversation.state === 'handoff'"
              size="x-small"
              color="orange"
              variant="tonal"
            >
              {{ conversation.assigneeLabel
                ? `Взяв: ${conversation.assigneeLabel}`
                : 'Зараз відповідає менеджер' }}
            </v-chip>
            <v-chip
              v-else-if="conversation.state === 'paused'"
              size="x-small"
              color="purple"
              variant="tonal"
            >
              Бот вимкнено для цієї розмови
            </v-chip>
            <v-spacer />
            <v-btn
              v-if="authStore.isOwner"
              size="small"
              color="error"
              variant="tonal"
              prepend-icon="mdi-message-text-remove-outline"
              :disabled="clearChatLoading"
              @click="clearChatDialog = true"
            >
              Очистити переписку
            </v-btn>
            <v-chip
              v-if="debugEnabled"
              size="x-small"
              color="secondary"
              variant="tonal"
              prepend-icon="mdi-bug"
            >
              debug_enabled
            </v-chip>
          </div>
          <div class="text-caption text-medium-emphasis">
            <template v-if="debugEnabled">
              Debug увімкнено — у чаті видно ходи агента (tools / rounds). Без `?debug_enabled=true` ці нотатки приховані.
            </template>
            <template v-else-if="isGloballyIgnored">
              @{{ conversation.client.igUsername }} у чорному списку в Налаштуваннях — бот не відповідає незалежно від перемикача.
            </template>
            <template v-else-if="conversation.state === 'handoff'">
              Увімкніть перемикач, щоб бот знову відповідав клієнту (навіть після передачі менеджеру).
            </template>
            <template v-else-if="conversation.state === 'paused'">
              Увімкніть перемикач, щоб бот знову відповідав у цій розмові.
            </template>
            <template v-else>
              Вимкніть, якщо бот більше не повинен відповідати цьому клієнту.
            </template>
          </div>
        </div>

        <v-divider />
        </template>

        <!-- Messages -->
        <div
          v-if="loading"
          class="d-flex justify-center align-center flex-grow-1"
        >
          <v-progress-circular indeterminate color="primary" />
        </div>

        <div
          v-else
          ref="messagesContainer"
          class="messages-area flex-grow-1 overflow-y-auto"
          :class="mobile ? 'messages-area--mobile' : 'pa-3 pa-md-4'"
          style="min-height: 0;"
        >
          <div v-if="messages.length === 0" class="d-flex justify-center align-center" style="height: 100%;">
            <div class="text-body-2 text-grey">Повідомлень поки немає</div>
          </div>

          <template v-for="(msg, msgIndex) in visibleMessages" :key="msg.id">
          <div
            v-if="showDayDivider(msg, msgIndex)"
            class="chat-day-divider"
            role="separator"
          >
            <span class="chat-day-divider__label">{{ formatDayDivider(msg.createdAt) }}</span>
          </div>
          <div
            class="message-row"
            :class="[messageAlignment(msg), { 'message-row--tight': mobile }]"
          >
            <div v-if="rendersAsSystemNote(msg)" class="text-center system-note-wrap">
              <v-chip
                v-if="!isMultilineSystemNote(msg.text)"
                size="x-small"
                variant="outlined"
                class="font-italic"
              >
                {{ formatChatPlain(msg.text) }}
              </v-chip>
              <v-card
                v-else
                flat
                rounded="lg"
                variant="tonal"
                :color="isAgentTurnDebugNote(msg.text) ? 'secondary' : 'info'"
                class="system-note-card text-left pa-3 mx-auto"
              >
                <div class="text-caption font-weight-medium mb-1">
                  {{
                    isAgentTurnDebugNote(msg.text)
                      ? 'Debug ходу агента (лише адмінка)'
                      : 'Системна нота (лише адмінка)'
                  }}
                </div>
                <div class="text-caption system-note-text">{{ formatChatPlain(msg.text) }}</div>
              </v-card>
            </div>
            <div v-else class="message-bubble-wrap" :style="{ maxWidth: mobile ? '92%' : '72%' }">
              <div
                v-if="!shouldHideSenderMeta(msg, msgIndex)"
                class="message-meta text-caption text-grey mb-1"
                :class="msg.direction === 'out' ? 'text-right' : ''"
              >
                {{ senderIcon(msg) }} {{ senderLabel(msg) }} · {{ formatTime(msg.createdAt) }}
              </div>
              <v-card flat rounded="xl" class="pa-3 message-bubble-card" :class="bubbleCardClass(msg)">
                <div
                  v-if="msg.text"
                  class="message-bubble-text"
                  :class="mobile ? 'message-bubble-text--mobile' : 'text-body-2'"
                  style="word-break: break-word; white-space: pre-wrap;"
                >
                  {{ formatChatPlain(msg.text) }}
                </div>
                <v-chip
                  v-if="isNativeIgEcho(msg)"
                  size="x-small"
                  variant="tonal"
                  color="pink-darken-2"
                  class="mt-1 native-ig-echo-chip"
                  prepend-icon="mdi-instagram"
                >
                  З Instagram
                </v-chip>
                <v-chip
                  v-else-if="isDetectedPhoneMessage(msg)"
                  size="x-small"
                  variant="tonal"
                  color="primary"
                  class="mt-1"
                  prepend-icon="mdi-phone"
                >
                  Instagram розпізнав номер
                </v-chip>
                <div
                  v-else-if="!msg.text && getDisplayMediaItems(msg).length === 0 && !hasSharedPostPreview(msg.sharedPost)"
                  class="text-caption text-medium-emphasis font-italic"
                >
                  Порожнє повідомлення Instagram (картка без тексту)
                </div>
                <v-alert
                  v-if="msg.sender === 'bot' && msg.botFailureDetail"
                  type="warning"
                  variant="tonal"
                  density="compact"
                  class="mt-2 text-caption bot-failure-alert"
                  :text="msg.botFailureDetail"
                >
                  <template #title>
                    <span class="text-caption font-weight-bold">Чому бот не зміг відповісти</span>
                  </template>
                </v-alert>
                <div
                  v-if="getDisplayMediaItems(msg).length > 0"
                  class="message-media d-flex flex-column ga-2"
                  :class="{ 'mt-2': msg.text }"
                >
                  <template
                    v-for="(item, idx) in getDisplayMediaItems(msg)"
                    :key="`${msg.id}-media-${idx}`"
                  >
                    <video
                      v-if="item.playable && item.kind === 'video' && item.src"
                      :src="item.src"
                      class="message-media-video"
                      controls
                      preload="metadata"
                    />
                    <div
                      v-else-if="item.kind === 'audio'"
                      class="message-audio-block d-flex flex-column ga-1"
                    >
                      <audio
                        v-if="item.playable && item.src"
                        :src="item.src"
                        class="message-media-audio"
                        controls
                        preload="metadata"
                      />
                      <div
                        v-else
                        class="message-media-placeholder d-flex align-center ga-2 pa-2"
                      >
                        <v-icon size="small" color="grey" :icon="mediaKindIcon('audio')" />
                        <span class="text-body-2 text-medium-emphasis">
                          {{ item.unavailableLabel }}
                        </span>
                      </div>
                      <div
                        v-if="item.transcript"
                        class="message-voice-transcript text-caption text-medium-emphasis"
                      >
                        📝 {{ item.transcript }}
                      </div>
                      <div
                        v-else-if="item.playable && item.sttStatus === 'failed'"
                        class="message-voice-transcript text-caption text-medium-emphasis"
                      >
                        Транскрипція недоступна — прослухайте аудіо вище
                      </div>
                    </div>
                    <a
                      v-else-if="item.playable && item.kind === 'image' && item.src"
                      :href="item.src"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="message-media-link"
                    >
                      <img
                        :src="item.src"
                        class="message-media-image"
                        alt="Вкладення"
                        loading="lazy"
                      />
                    </a>
                    <a
                      v-else-if="item.playable && item.kind === 'file' && item.downloadHref"
                      :href="item.downloadHref"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="message-media-file-link text-body-2"
                    >
                      <v-icon size="small" class="mr-1">mdi-paperclip</v-icon>
                      Завантажити файл
                    </a>
                    <div
                      v-else
                      class="message-media-placeholder d-flex align-center ga-2 pa-2"
                    >
                      <v-icon size="small" color="grey" :icon="mediaKindIcon(item.kind)" />
                      <span class="text-body-2 text-medium-emphasis">
                        {{ item.unavailableLabel }}
                      </span>
                    </div>
                  </template>
                </div>
                <div v-if="hasSharedPostPreview(msg.sharedPost)" class="shared-post-card mt-2">
                  <a
                    v-if="sharedPostImageSrc(msg)"
                    :href="
                      isIgPermalinkHref(msg.sharedPost?.postUrl)
                        ? msg.sharedPost!.postUrl
                        : sharedPostImageSrc(msg)
                    "
                    target="_blank"
                    rel="noopener noreferrer"
                    class="shared-post-image-link"
                  >
                    <img
                      :src="sharedPostImageSrc(msg)"
                      class="message-media-image shared-post-image"
                      alt="Пост Instagram"
                      loading="lazy"
                    />
                  </a>
                  <div class="shared-post-meta pa-2">
                    <div class="d-flex align-center ga-2 mb-1">
                      <v-icon size="16" icon="mdi-instagram" />
                      <span class="text-caption font-weight-medium">Пост Instagram</span>
                    </div>
                    <div
                      v-if="msg.sharedPost?.caption"
                      class="text-caption text-medium-emphasis shared-post-caption"
                    >
                      {{ msg.sharedPost.caption }}
                    </div>
                    <a
                      v-if="isIgPermalinkHref(msg.sharedPost?.postUrl)"
                      :href="msg.sharedPost!.postUrl"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-caption d-inline-block mt-1"
                    >
                      Відкрити в Instagram
                    </a>
                  </div>
                </div>
              </v-card>
            </div>
          </div>
          </template>

          <!-- Bot typing indicator -->
          <div v-if="botIsThinking" class="mb-3 d-flex justify-end">
            <div :style="{ maxWidth: mobile ? '88%' : '72%' }">
              <div class="text-caption text-grey mb-1 text-right">🤖 Бот</div>
              <v-card flat rounded="lg" class="pa-3 message-bubble-card bubble-out-bot">
                <div class="typing-dots">
                  <span /><span /><span />
                </div>
              </v-card>
            </div>
          </div>
        </div>

        <!-- Reply input -->
        <v-divider />
        <div class="pa-2 pa-md-3 agent-chat-input">
          <div class="manager-chat-actions">
            <v-btn
              variant="tonal"
              color="primary"
              class="tap-target manager-chat-action-btn"
              :density="mobile ? 'comfortable' : 'compact'"
              prepend-icon="mdi-credit-card-outline"
              :loading="managerActionRunning === 'send_payment_details'"
              :disabled="Boolean(managerActionRunning) || sending"
              @click="runManagerAction('send_payment_details')"
            >
              {{ mobile ? 'Реквізити' : 'Надіслати реквізити' }}
            </v-btn>
            <v-btn
              variant="tonal"
              color="secondary"
              class="tap-target manager-chat-action-btn"
              :density="mobile ? 'comfortable' : 'compact'"
              prepend-icon="mdi-message-text-outline"
              :loading="managerActionRunning === 'analyze_reply'"
              :disabled="Boolean(managerActionRunning) || sending"
              @click="runManagerAction('analyze_reply')"
            >
              {{ mobile ? 'Відповісти' : 'Відповісти по суті' }}
            </v-btn>
            <v-btn
              variant="tonal"
              color="success"
              class="tap-target manager-chat-action-btn"
              :density="mobile ? 'comfortable' : 'compact'"
              prepend-icon="mdi-clipboard-check-outline"
              :loading="managerActionRunning === 'complete_order'"
              :disabled="Boolean(managerActionRunning) || sending"
              @click="runManagerAction('complete_order')"
            >
              {{ mobile ? 'Оформити' : 'Оформити замовлення' }}
            </v-btn>
          </div>
          <div class="d-flex ga-2 align-end">
            <v-textarea
              v-model="replyText"
              placeholder="Повідомлення від менеджера..."
              variant="outlined"
              :density="mobile ? 'comfortable' : 'compact'"
              rows="1"
              max-rows="4"
              auto-grow
              hide-details
              :disabled="sending || Boolean(managerActionRunning)"
              @keydown.ctrl.enter="sendReply"
              @keydown.meta.enter="sendReply"
            />
            <v-btn
              color="green"
              icon="mdi-send"
              class="agent-send-btn tap-target"
              :loading="sending"
              :disabled="!replyText.trim()"
              @click="sendReply"
            />
          </div>
          <v-alert v-if="sendError" type="error" density="compact" class="mt-2 text-caption">
            {{ sendError }}
          </v-alert>
        </div>
      </div>

      <!-- Profile sidebar (desktop) / bottom sheet (mobile) -->
      <template v-if="mobile">
        <v-bottom-sheet v-model="showProfile" inset>
          <v-card class="pa-0">
            <client-profile-panel
              :client="conversation?.client"
              :conversation-id="props.id"
              :lead-summary="leadSummary"
              @updated="onClientUpdated"
              @profile-editing="onProfileEditing"
            />
          </v-card>
        </v-bottom-sheet>

        <v-bottom-sheet
          :model-value="mobileControlsSheet === 'bot'"
          inset
          @update:model-value="(v: boolean) => { if (!v) mobileControlsSheet = null }"
        >
          <v-card class="pa-4">
            <div class="text-subtitle-2 mb-3">Керування ботом</div>
            <v-switch
              :model-value="botResponsesEnabled"
              :loading="botResponsesSaving"
              :disabled="botResponsesSaving || isGloballyIgnored || !conversation"
              color="primary"
              density="comfortable"
              hide-details
              inset
              label="Бот відповідає"
              class="mb-3"
              @update:model-value="onBotResponsesToggle"
            />
            <p class="text-caption text-medium-emphasis mb-0">
              <template v-if="isGloballyIgnored">
                Клієнт у глобальному чорному списку — бот не відповідає.
              </template>
              <template v-else-if="conversation?.state === 'handoff'">
                Увімкніть, щоб бот знову відповідав після handoff.
              </template>
              <template v-else-if="conversation?.state === 'paused'">
                Бот вимкнено для цієї розмови.
              </template>
              <template v-else>
                Вимкніть, якщо бот не повинен відповідати цьому клієнту.
              </template>
            </p>
          </v-card>
        </v-bottom-sheet>

        <v-bottom-sheet
          :model-value="mobileControlsSheet === 'quality'"
          inset
          @update:model-value="(v: boolean) => { if (!v) mobileControlsSheet = null }"
        >
          <v-card class="pa-4">
            <div class="text-subtitle-2 mb-3">Якість ліда</div>
            <div class="d-flex align-center ga-2 mb-3">
              <v-rating
                :model-value="qualityDraft ?? 0"
                :length="5"
                size="large"
                color="amber"
                active-color="amber"
                hover
                clearable
                density="comfortable"
                :disabled="qualitySaving"
                @update:model-value="onQualityChange"
              />
              <span v-if="qualityDraft != null" class="text-body-2">{{ qualityDraft }} / 5</span>
            </div>
            <v-textarea
              v-model="qualityNoteDraft"
              placeholder="Чому така оцінка? (опційно)"
              variant="outlined"
              density="comfortable"
              rows="2"
              auto-grow
              hide-details
              class="mb-3"
              :disabled="qualitySaving"
            />
            <v-btn
              block
              color="primary"
              class="tap-target"
              :loading="qualitySaving"
              :disabled="qualityNoteDraft === (conversation?.briefQualityNote ?? '')"
              @click="saveQualityNote"
            >
              Зберегти нотатку
            </v-btn>
          </v-card>
        </v-bottom-sheet>
      </template>

      <div v-else-if="showProfile" class="profile-col">
        <client-profile-panel
          :client="conversation?.client"
          :conversation-id="props.id"
          :lead-summary="leadSummary"
          @updated="onClientUpdated"
          @profile-editing="onProfileEditing"
        />
      </div>
    </div>

    <v-dialog v-model="clearChatDialog" max-width="520" persistent>
      <v-card>
        <v-card-title class="text-error d-flex align-center ga-2">
          <v-icon color="error">mdi-message-text-remove-outline</v-icon>
          Очистити переписку?
        </v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-2">
            Видалить <strong>усі повідомлення</strong> цієї розмови з бази платформи.
            Instagram у Meta <strong>не змінюється</strong> — лише локальна історія для агента й адмінки.
          </p>
          <p class="text-caption text-medium-emphasis mb-3">
            Клієнт, замовлення та оцінка ліда залишаться. Контекст для Claude буде порожнім,
            доки не зʼявляться нові повідомлення.
          </p>
          <v-alert type="warning" variant="tonal" density="compact" class="mb-3">
            Щоб підтвердити, введіть
            <code class="text-error">{{ clearChatConfirmPhrase }}</code>
          </v-alert>
          <v-text-field
            v-model="clearChatConfirmInput"
            label="Підтвердження"
            variant="outlined"
            density="compact"
            hide-details
            autocomplete="off"
            :disabled="clearChatLoading"
            @keyup.enter="confirmClearChat"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn
            variant="text"
            :disabled="clearChatLoading"
            @click="closeClearChatDialog"
          >
            Скасувати
          </v-btn>
          <v-btn
            color="error"
            variant="flat"
            prepend-icon="mdi-delete-outline"
            :loading="clearChatLoading"
            :disabled="!clearChatConfirmReady || clearChatLoading"
            @click="confirmClearChat"
          >
            Очистити
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="snackbar" :color="snackbarColor" :timeout="3000">
      {{ snackbarText }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, defineComponent, h } from 'vue';
import type { PropType } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDisplay } from 'vuetify';
import api from '@/api';
import { useAuthStore } from '@/stores/auth';
import { formatChatPlain } from '@/lib/chatDisplay';
import { isAgentTurnDebugNote } from '@/lib/agentTurnDebug';
import {
  getDisplayMediaItems,
  hasSharedPostPreview,
  isIgPermalinkHref,
  mediaKindIcon,
  sharedPostImageSrc,
  type StoredMediaAttachment,
} from '@/lib/messageMedia';

const { mobile } = useDisplay();
const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

/** Desktop: profile column open by default. Mobile: closed — open via account button only. */
const showProfile = ref(!mobile.value);

watch(mobile, (isMobile) => {
  showProfile.value = !isMobile;
});

/** Opt-in debug UI: /conversations/:id?debug_enabled=true (same as sandbox). */
const debugEnabled = computed(() => {
  const q = route.query.debug_enabled;
  const raw = Array.isArray(q) ? q[0] : q;
  return raw === 'true' || raw === '1';
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SharedPostData {
  postUrl?: string;
  imageUrl?: string;
  caption?: string;
  mediaId?: string;
  kind?: string;
}

interface Message {
  id: string;
  direction: 'in' | 'out' | 'system';
  sender: 'client' | 'bot' | 'manager' | 'system';
  text: string | null;
  createdAt: string;
  igMessageId?: string | null;
  botFailureCode?: string | null;
  botFailureDetail?: string | null;
  mediaUrls?: string[];
  mediaAttachments?: StoredMediaAttachment[];
  sharedPost?: SharedPostData | null;
  igContext?: { kind?: string; phone?: string; source?: string } | null;
}

interface ClientData {
  id: string;
  igUserId?: string;
  igUsername?: string;
  igFullName?: string;
  displayName?: string;
  phone?: string;
  email?: string;
  deliveryCity?: string;
  deliveryNpBranch?: string;
  deliveryNpType?: string;
  notes?: string;
  tags?: string[];
  crmBuyerId?: string | null;
  crmProvider?: string | null;
  crmLinkedAt?: string | null;
}

interface ConversationData {
  id: string;
  client: ClientData;
  channel: string;
  state: string;
  intent?: string | null;
  handoffReason?: string | null;
  createdAt: string;
  firstInboundAt?: string | null;
  lastMessageAt?: string | null;
  messages: Message[];
  orders?: Array<{ id: string; status: string; items: unknown[] }>;
  briefQuality?: number | null;
  briefQualityNote?: string | null;
  assigneeLabel?: string | null;
}

interface LeadSummary {
  channel: string;
  intent: string | null;
  createdAt: string;
  firstInboundAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
}

interface LivePollPayload {
  conversation: Partial<ConversationData> & { id: string };
  client: ClientData;
  newMessages: Message[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const props = defineProps<{ id: string }>();

const conversation = ref<ConversationData | null>(null);
const messages = ref<Message[]>([]);
/** Hide agent-turn debug system notes unless ?debug_enabled=true */
const visibleMessages = computed(() => {
  if (debugEnabled.value) return messages.value;
  return messages.value.filter((m) => !isAgentTurnDebugNote(m.text));
});
const loading = ref(false);
const replyText = ref('');
const sending = ref(false);
const sendError = ref('');
const managerActionRunning = ref<string | null>(null);
const messagesContainer = ref<HTMLElement | null>(null);

const CLEAR_CHAT_CONFIRM = 'ОЧИСТИТИ ЧАТ';
const clearChatDialog = ref(false);
const clearChatConfirmInput = ref('');
const clearChatLoading = ref(false);
const clearChatConfirmPhrase = CLEAR_CHAT_CONFIRM;
const clearChatConfirmReady = computed(
  () => clearChatConfirmInput.value.trim() === CLEAR_CHAT_CONFIRM,
);

function closeClearChatDialog() {
  clearChatDialog.value = false;
  clearChatConfirmInput.value = '';
}

async function confirmClearChat() {
  if (!clearChatConfirmReady.value || clearChatLoading.value || !conversation.value) return;
  clearChatLoading.value = true;
  try {
    const { data } = await api.post<{
      ok: boolean;
      deletedMessages: number;
      message: Message;
    }>(`/conversations/${conversation.value.id}/clear-messages`, {
      confirm: CLEAR_CHAT_CONFIRM,
    });
    messages.value = data.message ? [data.message] : [];
    if (conversation.value) {
      conversation.value.lastMessageAt = data.message?.createdAt ?? conversation.value.lastMessageAt;
    }
    closeClearChatDialog();
    showSnack(
      data.deletedMessages > 0
        ? `Переписку очищено (${data.deletedMessages} повід.)`
        : 'Переписка вже була порожня',
    );
    await nextTick();
    scrollToBottom();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } } };
    showSnack(err.response?.data?.error ?? 'Не вдалося очистити переписку', 'error');
  } finally {
    clearChatLoading.value = false;
  }
}

/** While true, live poll must not overwrite `conversation.client` (admin is editing the form). */
const profileEditing = ref(false);

/** Background sync with tenant API (new IG messages + tool-saved client fields). */
const livePollActive = ref(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;
const LIVE_POLL_MS = 2500;

const snackbar = ref(false);
const snackbarText = ref('');
const snackbarColor = ref('success');

// Quality rating local state (B.2)
const qualityDraft = ref<number | null>(null);
const qualityNoteDraft = ref('');
const qualitySaving = ref(false);
const showQualityNote = ref(false);

// Bot response toggle
const botResponsesSaving = ref(false);
const botIgnoreUsernames = ref<string[]>([]);

const botResponsesEnabled = computed(() => conversation.value?.state === 'bot');

const isGloballyIgnored = computed(() => {
  const username = conversation.value?.client?.igUsername?.trim().replace(/^@+/, '').toLowerCase();
  if (!username) return false;
  return botIgnoreUsernames.value.includes(username);
});

/** Mobile chrome: bot/quality sheets + compact handoff. */
const mobileControlsSheet = ref<'bot' | 'quality' | null>(null);
const handoffExpanded = ref(false);

const mobileStatusLine = computed(() => {
  const c = conversation.value;
  if (!c) return 'Завантаження…';
  if (livePollActive.value && c.state === 'handoff') {
    return c.assigneeLabel ? `Менеджер · ${c.assigneeLabel}` : 'Менеджер';
  }
  return stateLabel(c.state);
});

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

const clientName = computed(() => {
  const c = conversation.value?.client;
  if (!c) return 'Клієнт';
  return c.displayName || c.igFullName || (c.igUsername ? `@${c.igUsername}` : null) || c.igUserId || 'Клієнт';
});

const leadSummary = computed((): LeadSummary | undefined => {
  const c = conversation.value;
  if (!c) return undefined;
  return {
    channel: c.channel,
    intent: c.intent ?? null,
    createdAt: c.createdAt,
    firstInboundAt: c.firstInboundAt ?? null,
    lastMessageAt: c.lastMessageAt ?? null,
    messageCount: messages.value.length,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function showSnack(text: string, color = 'success') {
  snackbarText.value = text;
  snackbarColor.value = color;
  snackbar.value = true;
}

function stateColor(state: string): string {
  return ({ bot: 'blue', handoff: 'orange', closed: 'grey', paused: 'purple' } as Record<string, string>)[state] || 'grey';
}

function stateLabel(state: string): string {
  return ({ bot: 'Бот', handoff: 'Менеджер', closed: 'Закрито', paused: 'Бот вимкнено' } as Record<string, string>)[state] || state;
}

function formatTime(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function messageDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString();
}

function showDayDivider(msg: Message, index: number): boolean {
  if (!msg.createdAt || !messageDayKey(msg.createdAt)) return false;
  const prev = visibleMessages.value[index - 1];
  if (!prev?.createdAt) return true;
  return messageDayKey(prev.createdAt) !== messageDayKey(msg.createdAt);
}

function formatDayDivider(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const label = d.toLocaleDateString('uk-UA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  if (d.toDateString() === now.toDateString()) return `Сьогодні · ${label}`;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `Вчора · ${label}`;
  return label;
}

function messageAlignment(msg: Message): string {
  if (rendersAsSystemNote(msg)) return 'd-flex justify-center';
  return msg.direction === 'in' ? 'd-flex justify-start' : 'd-flex justify-end';
}

function bubbleCardClass(msg: Message): string {
  if (msg.direction === 'in') return 'bubble-incoming';
  if (isNativeIgEcho(msg)) return 'bubble-out-manager-echo';
  if (msg.sender === 'manager') return 'bubble-out-manager';
  return 'bubble-out-bot';
}

function senderIcon(msg: Message): string {
  return ({ client: '👤', bot: '🤖', manager: '💬', system: '⚙️' } as Record<string, string>)[msg.sender] || '';
}

const botIsThinking = computed(() => {
  if (managerActionRunning.value) return true;
  if (!conversation.value || conversation.value.state !== 'bot') return false;
  if (isGloballyIgnored.value) return false;
  const last = messages.value[messages.value.length - 1];
  if (!last || last.direction !== 'in') return false;
  return Date.now() - new Date(last.createdAt).getTime() < 3 * 60 * 1000;
});

function senderLabel(msg: Message): string {
  if (isNativeIgEcho(msg)) return 'Менеджер · Instagram';
  return ({ client: 'Клієнт', bot: 'Бот', manager: 'Менеджер', system: 'Система' } as Record<string, string>)[msg.sender] || msg.sender;
}

function isNativeIgEcho(msg: Message): boolean {
  return msg.sender === 'manager' && msg.igContext?.kind === 'ig_native_echo';
}

function managerBubbleSource(msg: Message): string {
  if (isNativeIgEcho(msg)) return 'ig_echo';
  return msg.sender;
}

function isDetectedPhoneMessage(msg: Message): boolean {
  if (msg.igContext?.kind === 'detected_phone') return true;
  return Boolean(msg.text?.trim().startsWith('📞'));
}

function isAdminRetryNote(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  return t.startsWith('[agent_retry]') || t.startsWith('Повторна спроба агента:');
}

function rendersAsSystemNote(msg: Message): boolean {
  return msg.sender === 'system' || isAdminRetryNote(msg.text);
}

/** Vision/CRM/agent-turn debug notes are multiline; keep short status chips compact. */
function isMultilineSystemNote(text: string | null | undefined): boolean {
  if (!text) return false;
  return (
    text.includes('\n') ||
    text.startsWith('🔍') ||
    isAgentTurnDebugNote(text) ||
    isAdminRetryNote(text)
  );
}

async function scrollToBottom(opts?: { force?: boolean }) {
  const run = () => {
    const el = messagesContainer.value;
    if (!el) return false;
    el.scrollTop = el.scrollHeight;
    return true;
  };

  await nextTick();
  if (!run() && !opts?.force) return;

  // Layout may still settle (fonts, bubbles, images) — nudge again.
  requestAnimationFrame(() => {
    run();
    requestAnimationFrame(() => {
      run();
      const el = messagesContainer.value;
      if (!el) return;
      const imgs = el.querySelectorAll('img');
      imgs.forEach((img) => {
        if (img.complete) return;
        img.addEventListener('load', () => run(), { once: true });
      });
    });
  });
}

function shouldHideSenderMeta(msg: Message, index: number): boolean {
  if (!mobile.value) return false;
  if (msg.sender === 'system') return false;
  const prev = visibleMessages.value[index - 1];
  if (!prev || prev.sender === 'system') return false;
  if (managerBubbleSource(prev) !== managerBubbleSource(msg) || prev.direction !== msg.direction) {
    return false;
  }
  const a = new Date(prev.createdAt).getTime();
  const b = new Date(msg.createdAt).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return true;
  return b - a < 2 * 60 * 1000;
}

function isNearBottom(thresholdPx = 120): boolean {
  const el = messagesContainer.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < thresholdPx;
}

function onProfileEditing(v: boolean) {
  profileEditing.value = v;
}

function lastMessageCursorIso(): string | undefined {
  if (messages.value.length === 0) return undefined;
  let maxMs = -1;
  let iso = messages.value[0]!.createdAt;
  for (const m of messages.value) {
    const t = new Date(m.createdAt).getTime();
    if (!Number.isNaN(t) && t >= maxMs) {
      maxMs = t;
      iso = m.createdAt;
    }
  }
  return iso;
}

function applyLiveUpdate(data: LivePollPayload) {
  if (!conversation.value) return;
  const { newMessages, client, conversation: conv } = data;

  conversation.value.state = conv.state ?? conversation.value.state;
  conversation.value.channel = conv.channel ?? conversation.value.channel;
  conversation.value.intent = conv.intent ?? conversation.value.intent;
  conversation.value.handoffReason =
    conv.handoffReason !== undefined ? conv.handoffReason : conversation.value.handoffReason;
  conversation.value.lastMessageAt = conv.lastMessageAt ?? conversation.value.lastMessageAt;
  conversation.value.firstInboundAt = conv.firstInboundAt ?? conversation.value.firstInboundAt;
  conversation.value.createdAt = conv.createdAt ?? conversation.value.createdAt;
  conversation.value.briefQuality =
    conv.briefQuality !== undefined ? conv.briefQuality : conversation.value.briefQuality;
  conversation.value.briefQualityNote =
    conv.briefQualityNote !== undefined ? conv.briefQualityNote : conversation.value.briefQualityNote;
  if ('assigneeLabel' in conv) {
    conversation.value.assigneeLabel =
      (conv as { assigneeLabel?: string | null }).assigneeLabel ?? null;
  }

  if (!profileEditing.value) {
    conversation.value.client = { ...conversation.value.client, ...client };
  }

  const seen = new Set(messages.value.map((m) => m.id));
  const seenIg = new Set(
    messages.value.map((m) => m.igMessageId).filter((x): x is string => Boolean(x)),
  );
  let appended = false;
  const stickToBottom = isNearBottom();
  for (const m of newMessages) {
    if (seen.has(m.id)) continue;
    if (m.igMessageId && seenIg.has(m.igMessageId)) continue;
    const last = messages.value[messages.value.length - 1];
    const t = (x: string | null | undefined) => (x ?? '').trim();
    if (
      last &&
      last.sender !== 'system' &&
      m.sender !== 'system' &&
      last.direction === m.direction &&
      last.sender === m.sender &&
      t(last.text) === t(m.text) &&
      t(m.text).length > 0
    ) {
      continue;
    }
    messages.value.push(m);
    seen.add(m.id);
    if (m.igMessageId) seenIg.add(m.igMessageId);
    appended = true;
  }
  if (appended && stickToBottom) void scrollToBottom();
}

async function pollLive() {
  if (document.hidden || loading.value || !conversation.value) return;
  const after = lastMessageCursorIso();
  try {
    const { data } = await api.get<LivePollPayload>(`/conversations/${props.id}/live`, {
      params: after ? { after } : {},
    });
    applyLiveUpdate(data);
  } catch {
    /* offline or 404 — ignore until next tick */
  }
}

function onVisibilityChange() {
  if (!document.hidden) void pollLive();
}

function startLivePoll() {
  stopLivePoll();
  livePollActive.value = true;
  pollTimer = setInterval(() => {
    void pollLive();
  }, LIVE_POLL_MS);
  document.addEventListener('visibilitychange', onVisibilityChange);
}

function stopLivePoll() {
  livePollActive.value = false;
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  document.removeEventListener('visibilitychange', onVisibilityChange);
}

async function fetchBotIgnoreList() {
  try {
    const { data } = await api.get('/settings');
    const raw = data.runtime_mode as { botIgnoreUsernames?: unknown } | undefined;
    const list = Array.isArray(raw?.botIgnoreUsernames)
      ? raw!.botIgnoreUsernames.filter((v): v is string => typeof v === 'string')
      : [];
    botIgnoreUsernames.value = list.map((h) => h.trim().replace(/^@+/, '').toLowerCase()).filter(Boolean);
  } catch {
    botIgnoreUsernames.value = [];
  }
}

async function onBotResponsesToggle(enabled: boolean | null) {
  if (!conversation.value || enabled === null || botResponsesSaving.value) return;
  if (enabled && isGloballyIgnored.value) {
    showSnack('Клієнт у глобальному чорному списку — приберіть @нік з Налаштувань', 'warning');
    return;
  }

  botResponsesSaving.value = true;
  try {
    const { data } = await api.patch(`/conversations/${conversation.value.id}/bot-responses`, {
      enabled,
    });
    conversation.value.state = data.state;
    conversation.value.handoffReason = data.handoffReason ?? null;
    await pollLive();
    showSnack(enabled ? 'Бот знову відповідає' : 'Бот вимкнено для цієї розмови');
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } } };
    showSnack(err.response?.data?.error ?? 'Не вдалося змінити режим бота', 'error');
  } finally {
    botResponsesSaving.value = false;
  }
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchConversation() {
  loading.value = true;
  try {
    const { data } = await api.get(`/conversations/${props.id}`);
    conversation.value = data;
    messages.value = data.messages || [];
    qualityDraft.value = data.briefQuality ?? null;
    qualityNoteDraft.value = data.briefQualityNote ?? '';
    showQualityNote.value = !!data.briefQualityNote;
  } catch {
    stopLivePoll();
    router.push({ name: 'conversations' });
  } finally {
    loading.value = false;
  }
  // Scroll after the messages container is mounted (it is v-else of loading).
  await scrollToBottom({ force: true });
}

async function persistQuality(quality: number | null, note: string | null) {
  qualitySaving.value = true;
  try {
    const { data } = await api.post(`/conversations/${props.id}/brief-quality`, {
      quality,
      note,
    });
    if (conversation.value) {
      conversation.value.briefQuality = data.briefQuality;
      conversation.value.briefQualityNote = data.briefQualityNote;
    }
    showSnack('Оцінку збережено');
  } catch (e: any) {
    showSnack(e.response?.data?.error || 'Не вдалося зберегти оцінку', 'error');
    // Roll back optimistic state to last persisted value
    qualityDraft.value = conversation.value?.briefQuality ?? null;
    qualityNoteDraft.value = conversation.value?.briefQualityNote ?? '';
  } finally {
    qualitySaving.value = false;
  }
}

function onQualityChange(val: string | number) {
  const n = typeof val === 'string' ? Number(val) : val;
  const q = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  qualityDraft.value = q;
  const note = qualityNoteDraft.value.trim() ? qualityNoteDraft.value.trim() : null;
  persistQuality(q, note);
}

function saveQualityNote() {
  const note = qualityNoteDraft.value.trim() ? qualityNoteDraft.value.trim() : null;
  persistQuality(qualityDraft.value, note);
}

async function sendReply() {
  if (!replyText.value.trim()) return;
  sending.value = true;
  sendError.value = '';
  try {
    const { data } = await api.post(`/conversations/${props.id}/reply`, {
      text: replyText.value.trim(),
    });
    messages.value.push(data);
    if (conversation.value && data.createdAt) {
      conversation.value.lastMessageAt = data.createdAt;
    }
    replyText.value = '';
    await scrollToBottom();
    void pollLive();
  } catch (e: any) {
    sendError.value = e.response?.data?.error || 'Помилка відправлення';
  } finally {
    sending.value = false;
  }
}

async function runManagerAction(action: string) {
  if (managerActionRunning.value) return;
  managerActionRunning.value = action;
  sendError.value = '';
  try {
    await api.post(
      `/conversations/${props.id}/manager-actions`,
      { action },
      { timeout: 180_000 },
    );
    await fetchConversation();
    const ok =
      action === 'send_payment_details'
        ? 'Реквізити надіслано клієнту'
        : action === 'complete_order'
          ? 'Агент оформив замовлення'
          : 'Агент відповів клієнту';
    showSnack(ok);
  } catch (e: any) {
    const msg = e.response?.data?.error || 'Не вдалося виконати дію';
    sendError.value = msg;
    showSnack(msg, 'error');
  } finally {
    managerActionRunning.value = null;
    void pollLive();
  }
}

function onClientUpdated(updated: ClientData) {
  if (conversation.value) {
    conversation.value.client = { ...conversation.value.client, ...updated };
  }
  showSnack('Профіль оновлено');
}

onMounted(async () => {
  await Promise.all([fetchConversation(), fetchBotIgnoreList()]);
  startLivePoll();
});

watch(
  () => props.id,
  async (newId, oldId) => {
    if (!newId || newId === oldId) return;
    stopLivePoll();
    handoffExpanded.value = false;
    mobileControlsSheet.value = null;
    await fetchConversation();
    startLivePoll();
  },
);

onBeforeUnmount(() => {
  stopLivePoll();
});

// ---------------------------------------------------------------------------
// ClientProfilePanel (inline component)
// ---------------------------------------------------------------------------

const INTENT_LABELS: Record<string, string> = {
  new_lead: 'Новий лід',
  service_question: 'Сервіс / питання',
  complaint: 'Скарга',
  partnership: 'Партнерство',
  jobs: 'Вакансії',
  spam: 'Спам',
};

const ClientProfilePanel = defineComponent({
  name: 'ClientProfilePanel',
  props: {
    client: { type: Object as () => ClientData | undefined, default: undefined },
    conversationId: { type: String, required: true },
    leadSummary: { type: Object as PropType<LeadSummary | undefined>, default: undefined },
  },
  emits: ['updated', 'profileEditing'],
  setup(props, { emit }) {
    const editing = ref(false);
    watch(editing, (v) => {
      emit('profileEditing', v);
    });
    const saving = ref(false);
    const importing = ref(false);
    const newTag = ref('');
    const crmLinking = ref(false);
    const crmHistoryLoading = ref(false);
    const crmManualId = ref('');
    const crmHistoryText = ref('');
    const crmLinkMessage = ref('');

    const form = ref<Partial<ClientData>>({});

    function startEdit() {
      form.value = {
        displayName: props.client?.displayName ?? '',
        phone: props.client?.phone ?? '',
        email: props.client?.email ?? '',
        deliveryCity: props.client?.deliveryCity ?? '',
        deliveryNpBranch: props.client?.deliveryNpBranch ?? '',
        deliveryNpType: props.client?.deliveryNpType ?? '',
        notes: props.client?.notes ?? '',
        tags: [...(props.client?.tags ?? [])],
        crmBuyerId: props.client?.crmBuyerId ?? '',
      };
      editing.value = true;
    }

    function cancelEdit() {
      editing.value = false;
      form.value = {};
      newTag.value = '';
    }

    function addTag() {
      const tag = newTag.value.trim().toLowerCase().replace(/\s+/g, '_');
      if (!tag) return;
      if (!Array.isArray(form.value.tags)) form.value.tags = [];
      if (!form.value.tags.includes(tag)) {
        form.value.tags.push(tag);
      }
      newTag.value = '';
    }

    function removeTag(tag: string) {
      if (Array.isArray(form.value.tags)) {
        form.value.tags = form.value.tags.filter((t) => t !== tag);
      }
    }

    async function saveProfile() {
      if (!props.client?.id) return;
      saving.value = true;
      try {
        const { data } = await api.put(`/conversations/clients/${props.client.id}`, form.value);
        emit('updated', data);
        editing.value = false;
        form.value = {};
      } catch (e: any) {
        alert(e.response?.data?.error || 'Помилка збереження');
      } finally {
        saving.value = false;
      }
    }

    function formatLeadDate(iso: string | null | undefined): string {
      if (!iso) return '—';
      try {
        return new Date(iso).toLocaleString('uk-UA', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch {
        return '—';
      }
    }

    function channelLabel(ch: string): string {
      return ch === 'ig' ? 'Instagram DM' : ch?.toUpperCase() ?? '—';
    }

    function intentLabel(intent: string | null | undefined): string {
      if (!intent) return '—';
      return INTENT_LABELS[intent] ?? intent;
    }

    async function importHistory() {
      if (!props.conversationId) return;
      importing.value = true;
      try {
        const { data } = await api.post(`/conversations/${props.conversationId}/import-ig-history`);
        alert(`Імпортовано: ${data.imported} повідомлень (пропущено: ${data.skipped})`);
        // Reload the page to show imported messages
        window.location.reload();
      } catch (e: any) {
        alert(e.response?.data?.error || 'Помилка імпорту');
      } finally {
        importing.value = false;
      }
    }

    async function linkCrmByPhone() {
      if (!props.client?.id) return;
      crmLinking.value = true;
      crmLinkMessage.value = '';
      try {
        const { data } = await api.post(`/conversations/clients/${props.client.id}/crm-link`);
        if (data.client) emit('updated', data.client);
        crmLinkMessage.value = data.linked
          ? `Привʼязано (${data.source})`
          : data.message || 'Не знайдено в CRM';
        if (data.linked) await loadCrmHistory();
      } catch (e: any) {
        crmLinkMessage.value = e.response?.data?.error || 'Помилка привʼязки';
      } finally {
        crmLinking.value = false;
      }
    }

    async function linkCrmManual() {
      if (!props.client?.id) return;
      const id = crmManualId.value.trim();
      if (!id) {
        crmLinkMessage.value = 'Вкажи CRM client UUID';
        return;
      }
      crmLinking.value = true;
      crmLinkMessage.value = '';
      try {
        const { data } = await api.post(`/conversations/clients/${props.client.id}/crm-link`, {
          crmBuyerId: id,
        });
        if (data.client) emit('updated', data.client);
        crmManualId.value = '';
        crmLinkMessage.value = 'Привʼязано вручну';
        await loadCrmHistory();
      } catch (e: any) {
        crmLinkMessage.value = e.response?.data?.error || 'Помилка привʼязки';
      } finally {
        crmLinking.value = false;
      }
    }

    async function unlinkCrm() {
      if (!props.client?.id) return;
      if (!confirm('Відвʼязати клієнта від CRM?')) return;
      crmLinking.value = true;
      try {
        const { data } = await api.delete(`/conversations/clients/${props.client.id}/crm-link`);
        if (data.client) emit('updated', data.client);
        crmHistoryText.value = '';
        crmLinkMessage.value = 'Відвʼязано';
      } catch (e: any) {
        crmLinkMessage.value = e.response?.data?.error || 'Помилка';
      } finally {
        crmLinking.value = false;
      }
    }

    async function loadCrmHistory() {
      if (!props.client?.id) return;
      crmHistoryLoading.value = true;
      try {
        const { data } = await api.get(`/conversations/clients/${props.client.id}/crm-history`);
        crmHistoryText.value = data.text || '';
        if (data.crmBuyerId && data.client === undefined && props.client && !props.client.crmBuyerId) {
          // history may have auto-linked — refresh via link response preferred
        }
      } catch (e: any) {
        crmHistoryText.value = e.response?.data?.error || 'Не вдалося завантажити історію';
      } finally {
        crmHistoryLoading.value = false;
      }
    }

    watch(
      () => props.client?.crmBuyerId,
      (id) => {
        if (id) void loadCrmHistory();
        else crmHistoryText.value = '';
      },
      { immediate: true },
    );

    return () => {
      const c = props.client;
      const displayTags = editing.value ? (form.value.tags ?? []) : (c?.tags ?? []);

      return h('div', { class: 'profile-panel d-flex flex-column', style: 'height: 100%; overflow-y: auto;' }, [
        // Header
        h('div', { class: 'pa-3 d-flex align-center ga-2' }, [
          h('div', { class: 'text-subtitle-2 flex-grow-1' }, 'Профіль клієнта'),
          !editing.value
            ? h('button', {
                class: 'profile-action-btn',
                title: 'Редагувати',
                onClick: startEdit,
                innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
              })
            : null,
        ]),
        h('hr', { class: 'v-divider' }),

        // Lead / thread summary
        props.leadSummary
          ? h('div', { class: 'pa-3 pb-0' }, [
              h('div', { class: 'text-caption text-grey text-uppercase mb-2', style: 'letter-spacing:0.04em;' }, 'Лід і тред'),
              h('div', { class: 'lead-summary-grid text-body-2' }, [
                h('div', { class: 'text-caption text-grey' }, 'Канал'),
                h('div', {}, channelLabel(props.leadSummary.channel)),
                h('div', { class: 'text-caption text-grey' }, 'Класифікація'),
                h('div', {}, intentLabel(props.leadSummary.intent)),
                h('div', { class: 'text-caption text-grey' }, 'Повідомлень'),
                h('div', {}, String(props.leadSummary.messageCount)),
                h('div', { class: 'text-caption text-grey' }, 'Тред відкрито'),
                h('div', {}, formatLeadDate(props.leadSummary.createdAt)),
                h('div', { class: 'text-caption text-grey' }, 'Перше від клієнта'),
                h('div', {}, formatLeadDate(props.leadSummary.firstInboundAt)),
                h('div', { class: 'text-caption text-grey' }, 'Остання активність'),
                h('div', {}, formatLeadDate(props.leadSummary.lastMessageAt)),
              ]),
            ])
          : null,

        props.leadSummary ? h('hr', { class: 'v-divider' }) : null,

        // IG identity + outbound links (profile + DM shortcut via ig.me)
        h('div', { class: 'pa-3 pb-0' }, [
          c?.igUsername
            ? h('div', { class: 'd-flex align-center ga-2 mb-2' }, [
                h('span', { class: 'text-pink', style: 'font-size:16px;' }, '📷'),
                h('span', { class: 'text-body-2' }, `@${String(c.igUsername).replace(/^@+/, '')}`),
              ])
            : null,
          (() => {
            const hnd = c?.igUsername?.replace(/^@+/, '').trim();
            if (!hnd) {
              return c?.igUserId
                ? h(
                    'div',
                    { class: 'text-caption text-grey mb-2' },
                    'Немає @username в профілі — посилання на Instagram зʼявляться після підтягування ніку (перше повідомлення або профіль IG).',
                  )
                : null;
            }
            const profileHref = `https://www.instagram.com/${encodeURIComponent(hnd)}/`;
            const dmHref = `https://ig.me/m/${encodeURIComponent(hnd)}`;
            return h('div', { class: 'd-flex flex-column ga-1 mb-2' }, [
              h('a', {
                class: 'profile-external-link',
                href: profileHref,
                target: '_blank',
                rel: 'noopener noreferrer',
              }, 'Профіль Instagram'),
              h('a', {
                class: 'profile-external-link',
                href: dmHref,
                target: '_blank',
                rel: 'noopener noreferrer',
              }, 'Чат у Instagram (DM)'),
            ]);
          })(),
          c?.igUserId
            ? h('div', { class: 'text-caption text-grey mb-2' }, `IGSID: ${c.igUserId}`)
            : null,
        ]),

        // Fields (view / edit)
        h('div', { class: 'pa-3 flex-grow-1' }, [
          // Name (prefer CRM displayName; fall back to IG display name)
          profileField('Імʼя', editing.value
            ? h('input', {
                class: 'profile-input',
                value: form.value.displayName,
                placeholder: c?.igFullName || 'Повне імʼя',
                onInput: (e: Event) => { form.value.displayName = (e.target as HTMLInputElement).value; },
              })
            : h('div', {}, [
                h('span', { class: 'text-body-2' }, c?.displayName || c?.igFullName || '-'),
                c?.displayName && c?.igFullName && c.displayName !== c.igFullName
                  ? h('div', { class: 'text-caption text-grey mt-1' }, `IG: ${c.igFullName}`)
                  : null,
              ]),
          ),

          // Phone
          profileField('Телефон', editing.value
            ? h('input', {
                class: 'profile-input',
                value: form.value.phone,
                placeholder: '+380...',
                onInput: (e: Event) => { form.value.phone = (e.target as HTMLInputElement).value; },
              })
            : h('span', { class: 'text-body-2' }, c?.phone || '-'),
          ),

          // Email
          profileField('Email', editing.value
            ? h('input', {
                class: 'profile-input',
                value: form.value.email,
                placeholder: 'email@example.com',
                onInput: (e: Event) => { form.value.email = (e.target as HTMLInputElement).value; },
              })
            : h('span', { class: 'text-body-2' }, c?.email || '-'),
          ),

          // City
          profileField('Місто', editing.value
            ? h('input', {
                class: 'profile-input',
                value: form.value.deliveryCity,
                placeholder: 'Київ',
                onInput: (e: Event) => { form.value.deliveryCity = (e.target as HTMLInputElement).value; },
              })
            : h('span', { class: 'text-body-2' }, c?.deliveryCity || '-'),
          ),

          // NP branch
          profileField('Відділення НП', editing.value
            ? h('input', {
                class: 'profile-input',
                value: form.value.deliveryNpBranch,
                placeholder: '12 або адреса поштомату',
                onInput: (e: Event) => { form.value.deliveryNpBranch = (e.target as HTMLInputElement).value; },
              })
            : h('span', { class: 'text-body-2' }, c?.deliveryNpBranch
                ? `${c.deliveryNpType === 'postamat' ? 'Поштомат' : 'Відділення'} ${c.deliveryNpBranch}`
                : '-'),
          ),

          // Tags
          h('div', { class: 'profile-field mb-2' }, [
            h('div', { class: 'text-caption text-grey mb-1' }, 'Теги'),
            h('div', { class: 'd-flex flex-wrap ga-1' }, [
              ...displayTags.map((tag) =>
                h('div', {
                  key: tag,
                  class: 'profile-tag d-flex align-center ga-1',
                }, [
                  h('span', { class: 'text-caption' }, tag),
                  editing.value
                    ? h('button', {
                        class: 'tag-remove-btn',
                        onClick: () => removeTag(tag),
                        innerHTML: '×',
                      })
                    : null,
                ]),
              ),
              editing.value
                ? h('div', { class: 'd-flex align-center ga-1' }, [
                    h('input', {
                      class: 'tag-input',
                      value: newTag.value,
                      placeholder: 'новий тег',
                      onInput: (e: Event) => { newTag.value = (e.target as HTMLInputElement).value; },
                      onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } },
                    }),
                    h('button', { class: 'tag-add-btn', onClick: addTag }, '+'),
                  ])
                : displayTags.length === 0 ? h('span', { class: 'text-caption text-grey' }, '-') : null,
            ]),
          ]),

          // Notes
          h('div', { class: 'profile-field mb-2' }, [
            h('div', { class: 'text-caption text-grey mb-1' }, 'Нотатка'),
            editing.value
              ? h('textarea', {
                  class: 'profile-textarea',
                  value: form.value.notes,
                  rows: 3,
                  placeholder: 'Будь-яка корисна інформація...',
                  onInput: (e: Event) => { form.value.notes = (e.target as HTMLTextAreaElement).value; },
                })
              : h('div', { class: 'text-body-2', style: 'white-space: pre-wrap; word-break: break-word;' },
                  c?.notes || h('span', { class: 'text-grey' }, '-'),
                ),
          ]),

          // Edit actions
          editing.value
            ? h('div', { class: 'd-flex ga-2 mt-3' }, [
                h('button', {
                  class: 'profile-save-btn',
                  disabled: saving.value,
                  onClick: saveProfile,
                }, saving.value ? 'Збереження...' : 'Зберегти'),
                h('button', {
                  class: 'profile-cancel-btn',
                  onClick: cancelEdit,
                }, 'Скасувати'),
              ])
            : null,
        ]),

        h('hr', { class: 'v-divider' }),

        // CRM link + visit history
        h('div', { class: 'pa-3' }, [
          h('div', { class: 'text-caption text-grey text-uppercase mb-2', style: 'letter-spacing:0.04em;' }, 'CRM клієнт'),
          c?.crmBuyerId
            ? h('div', { class: 'mb-2' }, [
                h('div', { class: 'text-body-2 text-break' }, c.crmBuyerId),
                h('div', { class: 'text-caption text-grey' },
                  [c.crmProvider, c.crmLinkedAt ? `з ${formatLeadDate(c.crmLinkedAt)}` : null]
                    .filter(Boolean)
                    .join(' · ') || 'привʼязано',
                ),
              ])
            : h('div', { class: 'text-body-2 text-grey mb-2' }, 'Не привʼязано'),
          h('div', { class: 'd-flex flex-wrap ga-2 mb-2' }, [
            h('button', {
              class: 'import-btn',
              disabled: crmLinking.value || !c?.phone,
              onClick: linkCrmByPhone,
              title: c?.phone ? 'Знайти в CRM за телефоном' : 'Спочатку вкажи телефон',
            }, crmLinking.value ? '…' : 'Знайти за телефоном'),
            c?.crmBuyerId
              ? h('button', {
                  class: 'profile-cancel-btn',
                  disabled: crmLinking.value,
                  onClick: unlinkCrm,
                }, 'Відвʼязати')
              : null,
            h('button', {
              class: 'import-btn',
              disabled: crmHistoryLoading.value || !c?.id,
              onClick: loadCrmHistory,
            }, crmHistoryLoading.value ? '…' : 'Оновити історію'),
          ]),
          h('div', { class: 'd-flex ga-1 mb-2' }, [
            h('input', {
              class: 'profile-input flex-grow-1',
              value: crmManualId.value,
              placeholder: 'CRM client UUID (вручну)',
              onInput: (e: Event) => { crmManualId.value = (e.target as HTMLInputElement).value; },
            }),
            h('button', {
              class: 'profile-save-btn',
              disabled: crmLinking.value,
              onClick: linkCrmManual,
            }, 'Привʼязати'),
          ]),
          crmLinkMessage.value
            ? h('div', { class: 'text-caption mb-2' }, crmLinkMessage.value)
            : null,
          crmHistoryText.value
            ? h('pre', {
                class: 'text-caption',
                style: 'white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; margin: 0;',
              }, crmHistoryText.value)
            : h('div', { class: 'text-caption text-grey' },
                'Історія візитів зʼявиться після привʼязки (тривалість послуг для планування запису).',
              ),
        ]),

        h('hr', { class: 'v-divider' }),

        // Import history
        h('div', { class: 'pa-3' }, [
          h('div', { class: 'text-caption text-grey mb-2' }, 'Інструменти'),
          h('button', {
            class: 'import-btn d-flex align-center ga-2',
            disabled: importing.value,
            onClick: importHistory,
          }, [
            importing.value
              ? h('span', { class: 'import-spinner' })
              : h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor' },
                  h('path', { d: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z' }),
                ),
            h('span', { class: 'text-body-2' }, importing.value ? 'Імпортую...' : 'Завантажити IG-переписку'),
          ]),
          h('div', { class: 'text-caption text-grey mt-1' },
            'Імпортує старі повідомлення з Instagram до цього діалогу',
          ),
        ]),
      ]);
    };

    function profileField(label: string, content: ReturnType<typeof h>) {
      return h('div', { class: 'profile-field mb-2' }, [
        h('div', { class: 'text-caption text-grey mb-1' }, label),
        content,
      ]);
    }
  },
});
</script>

<style scoped>
.system-note-wrap {
  max-width: min(560px, 100%);
  margin-inline: auto;
}

.system-note-card {
  width: 100%;
  border: 1px dashed rgba(var(--v-theme-info), 0.45);
}

.system-note-text {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.45;
  opacity: 0.95;
}

.detail-root {
  height: calc(100dvh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px));
  max-height: calc(100dvh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px));
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.detail-root--mobile {
  /* Full-bleed chat: no global app bar on hideBottomNav routes */
  background: #f3f5f8;
}

.chat-mobile-top {
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.92);
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  backdrop-filter: blur(10px);
  padding-top: env(safe-area-inset-top, 0px);
  z-index: 2;
}

.chat-mobile-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 52px;
  padding: 2px 4px 2px 2px;
}

.chat-mobile-identity {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 4px 6px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.chat-mobile-name {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.015em;
  color: var(--color-text, #0a2540);
  max-width: 100%;
  line-height: 1.25;
}

.chat-mobile-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  font-size: 11.5px;
  color: var(--color-text-secondary, #6c7688);
  line-height: 1.2;
}

.chat-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #94a3b8;
}

.chat-status-dot--bot { background: #635bff; }
.chat-status-dot--handoff { background: #f59e0b; }
.chat-status-dot--closed { background: #94a3b8; }
.chat-status-dot--paused { background: #a855f7; }

.chat-live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.2);
  flex-shrink: 0;
}

.chat-handoff-compact {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  margin: 0;
  padding: 8px 12px 10px;
  border: 0;
  border-top: 1px solid rgba(var(--v-theme-info), 0.15);
  background: rgba(var(--v-theme-info), 0.08);
  text-align: left;
  cursor: pointer;
  color: inherit;
}

.chat-handoff-compact__text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.chat-handoff-compact__text.is-expanded {
  display: block;
  -webkit-line-clamp: unset;
  white-space: pre-wrap;
  word-break: break-word;
}

.detail-layout {
  flex: 1 1 auto;
  display: flex;
  overflow: hidden;
}

.chat-col {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}

.profile-col {
  width: 300px;
  min-width: 300px;
  border-left: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));
  overflow-y: auto;
  flex-shrink: 0;
}

.chat-header {
  background: rgb(var(--v-theme-surface));
}

.live-chip {
  flex-shrink: 0;
}

.messages-area {
  background: #fafafa;
}

.messages-area--mobile {
  padding: 10px 12px 12px;
  background: linear-gradient(180deg, #f3f5f8 0%, #eef1f6 100%);
  -webkit-overflow-scrolling: touch;
}

.message-row {
  margin-bottom: 12px;
}

.message-row--tight {
  margin-bottom: 8px;
}

.chat-day-divider {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin: 10px 0 12px;
  width: 100%;
}

.chat-day-divider::before,
.chat-day-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: rgba(0, 0, 0, 0.08);
}

.chat-day-divider__label {
  flex-shrink: 0;
  font-size: 12px;
  line-height: 1.3;
  color: rgba(0, 0, 0, 0.48);
  text-align: center;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.85);
}

.message-bubble-text--mobile {
  font-size: 15.5px;
  line-height: 1.45;
  letter-spacing: -0.01em;
  color: inherit;
}

.quality-bar {
  background: #fafafa;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  flex-shrink: 0;
}

.handoff-reason-banner {
  flex-shrink: 0;
  background: rgba(var(--v-theme-info), 0.1);
  border: 1px solid rgba(var(--v-theme-info), 0.28);
  border-radius: 10px;
  overflow: visible;
}

.handoff-reason-title {
  color: rgb(var(--v-theme-info));
  line-height: 1.35;
}

.handoff-reason-body {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.45;
  color: rgb(var(--v-theme-on-surface));
}

.message-bubble-card.bubble-incoming {
  background: rgb(var(--v-theme-surface-variant));
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

/* Incoming body: Vuetify `text-body-2` uses medium-emphasis; on surface-variant it reads as invisible */
.messages-area .message-bubble-card.bubble-incoming .message-bubble-text {
  color: rgb(var(--v-theme-on-surface));
  opacity: 1;
}

.message-bubble-card.bubble-out-bot {
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
}

.message-bubble-card.bubble-out-manager {
  background: rgb(var(--v-theme-success));
  color: rgb(var(--v-theme-on-success));
}

.message-bubble-card.bubble-out-manager-echo {
  background: rgb(var(--v-theme-success));
  color: rgb(var(--v-theme-on-success));
  box-shadow: inset 3px 0 0 0 #e4405f;
}

.message-bubble-card.bubble-out-manager-echo .native-ig-echo-chip {
  background: rgba(255, 255, 255, 0.22);
  color: inherit;
}

.native-ig-echo-chip {
  max-width: 100%;
}

.message-media-image {
  display: block;
  max-width: 100%;
  max-height: 320px;
  border-radius: 8px;
  object-fit: contain;
  background: rgba(0, 0, 0, 0.04);
}

.message-media-video {
  display: block;
  max-width: 100%;
  max-height: 320px;
  border-radius: 8px;
  background: #000;
}

.message-media-audio {
  display: block;
  width: 100%;
  min-width: 220px;
  max-width: 320px;
}

.message-media-placeholder {
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.05);
  border: 1px dashed rgba(var(--v-border-color), var(--v-border-opacity));
}

.shared-post-card {
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));
  max-width: 280px;
}

.shared-post-image {
  max-height: 240px;
  width: 100%;
  object-fit: cover;
}

.shared-post-caption {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.message-media-file-link {
  display: inline-flex;
  align-items: center;
  color: inherit;
  text-decoration: none;
  font-weight: 500;
}
.message-media-file-link:hover {
  text-decoration: underline;
}

.message-media-link {
  display: block;
  line-height: 0;
}

.typing-dots {
  display: flex;
  gap: 5px;
  align-items: center;
  padding: 2px 4px;
}
.typing-dots span {
  width: 8px;
  height: 8px;
  background: rgba(255, 255, 255, 0.7);
  border-radius: 50%;
  animation: typing-bounce 1.4s infinite both;
}
.typing-dots span:nth-child(2) { animation-delay: 0.2s; }
.typing-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes typing-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

/* Profile panel styles */
:deep(.profile-panel) {
  height: 100%;
}

:deep(.lead-summary-grid) {
  display: grid;
  grid-template-columns: minmax(0, auto) 1fr;
  gap: 6px 14px;
  align-items: baseline;
}

:deep(.profile-field) {
  margin-bottom: 10px;
}

:deep(.profile-input) {
  width: 100%;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 13px;
  outline: none;
  background: #fff;
}
:deep(.profile-input:focus) {
  border-color: rgb(var(--v-theme-primary));
}

:deep(.profile-textarea) {
  width: 100%;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
  resize: vertical;
  background: #fff;
}
:deep(.profile-textarea:focus) {
  border-color: rgb(var(--v-theme-primary));
}

:deep(.profile-save-btn) {
  flex: 1;
  background: rgb(var(--v-theme-primary));
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 7px 12px;
  font-size: 13px;
  cursor: pointer;
}
:deep(.profile-save-btn:disabled) {
  opacity: 0.6;
  cursor: default;
}
:deep(.profile-cancel-btn) {
  border: 1px solid #ccc;
  background: #fff;
  border-radius: 6px;
  padding: 7px 12px;
  font-size: 13px;
  cursor: pointer;
  color: #555;
}

.profile-external-link {
  color: rgb(var(--v-theme-primary));
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  word-break: break-all;
}
.profile-external-link:hover {
  text-decoration: underline;
}

:deep(.profile-action-btn) {
  border: none;
  background: none;
  cursor: pointer;
  color: #666;
  padding: 4px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
:deep(.profile-action-btn:hover) {
  background: rgba(0,0,0,0.06);
}

:deep(.profile-tag) {
  background: rgba(var(--v-theme-primary), 0.1);
  color: rgb(var(--v-theme-primary));
  border-radius: 12px;
  padding: 2px 8px;
  font-size: 11px;
}

:deep(.tag-remove-btn) {
  border: none;
  background: none;
  cursor: pointer;
  color: rgb(var(--v-theme-primary));
  padding: 0;
  font-size: 14px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
}

:deep(.tag-input) {
  border: 1px dashed rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 12px;
  padding: 2px 8px;
  font-size: 11px;
  outline: none;
  width: 80px;
}

:deep(.tag-add-btn) {
  border: none;
  background: rgba(var(--v-theme-primary), 0.1);
  color: rgb(var(--v-theme-primary));
  border-radius: 50%;
  width: 20px;
  height: 20px;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

:deep(.import-btn) {
  width: 100%;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: #fff;
  border-radius: 8px;
  padding: 8px 12px;
  cursor: pointer;
  color: #444;
  text-align: left;
  transition: background 0.15s;
}
:deep(.import-btn:hover:not(:disabled)) {
  background: #f5f5f5;
}
:deep(.import-btn:disabled) {
  opacity: 0.6;
  cursor: default;
}

:deep(.import-spinner) {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(var(--v-theme-primary), 0.2);
  border-top-color: rgb(var(--v-theme-primary));
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.manager-chat-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.manager-chat-action-btn {
  min-height: var(--tap-min, 44px);
}

/* Mobile */
@media (max-width: 960px) {
  .detail-root--mobile .agent-chat-input {
    background: #fff;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    padding-bottom: max(10px, env(safe-area-inset-bottom));
  }

  .manager-chat-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 8px;
  }

  .manager-chat-action-btn {
    flex: 1 1 calc(33.33% - 8px);
    min-height: var(--tap-min, 44px);
    min-width: 0;
  }

  .message-bubble-card.bubble-incoming {
    background: #fff;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  }
}
</style>
