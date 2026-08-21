import pino from 'pino';
import { config } from '../config.js';
import { isCrmWriteEnabled } from '../lib/crm-write.js';
import { prisma } from '../lib/prisma.js';
import { askClaude, type ClaudeCallContext, type ClaudeRequest } from './claude.js';
import { sendText } from './instagram.js';
import { beginIgTypingIndicator, stopIgTypingBeforeSend } from './ig-typing-indicator.js';
import {
  buildRuntimePrompt,
  getWorkingHours,
  isWithinWorkingHours,
  loadCatalogSnippetForMode,
  type ClientProfile,
} from './prompt-builder.js';
import {
  createRuntimePromptSession,
  getActiveSystemPrompt,
  getPromptRuntimeGeneration,
} from './prompt-runtime.js';
import { resolveVisualMediaPathsForClaude } from './media.js';
import type { StoredMediaAttachment } from '../lib/media-attachments.js';
import { visualStorageKeys } from '../lib/media-attachments.js';
import { buildClaudeHistoryTurns } from '../lib/conversation-history.js';
import { formatHandoffMessageLine } from '../lib/handoff-format.js';
import { notifyAgentFailure, notifyHandoff } from './telegram-notify.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { formatTelegramBotsPromptBlock } from '../lib/telegram-bots.js';
import { buildAgentTools, type AgentMode } from '../lib/tool-definitions.js';
import { getActiveCrmFieldMappings } from '../lib/crm-field-mappings.js';
import { getAgentConfig, resolveResponseDelayMs,
  CLAUDE_ROUTER_MODEL,
  normalizeClaudeReplyModel,
} from '../lib/agent-config.js';
import { formatBranchesForPrompt, resolveBranchSlug } from './branches.js';
import { handleBookAppointment } from './appointment.js';
import { saveClientReferencePhoto } from './reference-photos.js';
import {
  cancelPendingFollowUpsSafe,
  scheduleFollowUpAfterBotOutboundSafe,
} from '../lib/follow-up-schedule.js';
import { handleCollectOrder, handleCreateLocalOrder } from './order.js';
import { parseOrderSummaryFromText } from '../lib/order-summary-detect.js';
import { isBotTurnStillValid } from '../lib/conversation-bot-guard.js';
import { autoReturnHandoffToBotIfExpired } from '../lib/handoff-auto-return.js';
import { getRuntimeConfig, isUsernameBotIgnored } from '../lib/runtime-config.js';
import { handleClassifyIntent, handleSubmitBrief } from './brief.js';
import { mirrorClientToCrm } from './crm-sync.js';
import { fetchClientCrmHistory, formatCrmLinkHintForPrompt } from './client-crm-link.js';
import { markFirstOutboundAt } from '../lib/conversation-metrics.js';
import {
  searchActiveProductsForContext,
  extractKeywordsFromCaption,
} from './product-search.js';
import { getDeliveryCost } from './nova-poshta.js';
import type { SharedPostData } from '../routes/webhooks.js';
import {
  enrichUserMessageWithIgContext,
  isReactionOnlyInbound,
  type IgInboundContext,
} from '../lib/ig-inbound-context.js';
import { stripMarkdownForInstagram } from '../lib/instagram-text.js';
import { gateCustomerFacingReply } from '../lib/assistant-output.js';
import {
  buildDeferredLookupNudge,
  looksLikeDeferredLookupPromise,
  looksLikeDeferredSlotsPromise,
} from '../lib/deferred-lookup.js';
import {
  buildServiceCorrectionNudge,
  looksLikeServiceCorrection,
} from '../lib/service-search-intent.js';
import {
  buildFalseBookingConfirmNudge,
  looksLikeBookingConfirmation,
  sanitizeFalseBookingConfirmReply,
} from '../lib/false-booking-confirm.js';
import { buildClientFacingTimeConflictReply } from '../lib/booking-time-conflict.js';
import {
  createAgentTurnDebugCollector,
  formatAgentTurnDebugNote,
  recordTurnRound,
  recordTurnSpawn,
  recordTurnTool,
  shouldPersistAgentTurnDebug,
  type AgentTurnDebugCollector,
} from '../lib/agent-turn-debug.js';
import { createTurnClaudeSessions } from '../lib/turn-claude-sessions.js';
import {
  executeGetAvailableSlotsTool,
  formatSearchServicesToolResult,
  searchServicesWithFallback,
  parseSearchServicesLimit,
} from './booking-lookup.js';
import { dedupeConversationMessages } from '../lib/message-dedupe.js';
import {
  claimInboundMessages,
  joinInboundBatch,
  loadPendingInbound,
  markInboundSkipped,
  MAX_DRAIN_ITERATIONS,
  newClaudeTurnId,
  releaseInboundClaim,
} from '../lib/inbound-coalesce.js';
import {
  AGENT_FALLBACK_RETRY_NOTE,
  countConsecutiveBotFallbacks,
  detectClientLanguage,
  formatBotFailureDetail,
  isAgentFallbackReply,
  isCustomerVisibleFallbackReply,
  normalizeClientLanguage,
  resolveCustomerFallback,
  shouldHandoffAfterAgentFallback,
  shouldSuppressDuplicateCustomerFallback,
  type BotFailureCode,
} from '../lib/agent-fallback.js';
import { isClaudeVisionImagePath } from '../lib/claude-vision.js';
import {
  extractVisionInterpretation,
  formatVisionDebugNote,
  type CatalogDebugMatch,
} from '../lib/vision-debug-note.js';
import type { ClaudeResponse } from './claude.js';

const log = pino({ name: 'conversation' });

/** Max messages to include in Claude conversation history */
const MAX_HISTORY_MESSAGES = 30;

const CUSTOMER_CHANNELS = new Set(['ig', 'tg']);

/** Outcome of one Claude turn — drives inbound claim keep / skip / release. */
export type BotTurnOutcome = 'completed' | 'skipped' | 'released';

// ---------------------------------------------------------------------------
// Handoff helper
// ---------------------------------------------------------------------------

async function performManagerHandoff(params: {
  conversationId: string;
  client: { id: string; igUserId: string | null };
  reason: string;
  turnStartedAt?: Date;
}): Promise<void> {
  const { conversationId, client, reason, turnStartedAt } = params;

  if (turnStartedAt && !(await isBotTurnStillValid(conversationId, turnStartedAt))) {
    log.info({ conversationId }, 'Handoff skipped — manager took over during turn');
    return;
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      state: 'handoff',
      handoffReason: reason,
      handedOffAt: new Date(),
    },
  });
  cancelPendingFollowUpsSafe(conversationId, 'handoff');

  const handoffMessage = 'Зачекайте, будь ласка, зʼєдную Вас з менеджером.';

  if (client.igUserId) {
    try {
      await sendText(client.igUserId, handoffMessage);
    } catch (err) {
      log.error({ err, conversationId }, 'Failed to send handoff message');
    }
  }

  await prisma.message.create({
    data: {
      conversationId,
      direction: 'out',
      sender: 'bot',
      text: handoffMessage,
    },
  });
  markFirstOutboundAt(conversationId).catch((err) =>
    log.warn({ err, conversationId }, 'markFirstOutboundAt failed (non-fatal)'),
  );

  log.info({ conversationId, reason }, 'Conversation handed off to manager');

  if (client.igUserId) {
    const recentMsgs = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { sender: true, text: true, mediaAttachments: true },
    });
    const lastMessages = recentMsgs
      .reverse()
      .map((m) =>
        formatHandoffMessageLine({
          sender: m.sender,
          text: m.text,
          mediaAttachments: m.mediaAttachments as StoredMediaAttachment[] | null,
        }),
      )
      .filter((line): line is NonNullable<typeof line> => line !== null)
      .map((line) => ({
        sender: line.sender,
        text: line.text,
        isVoice: line.isVoice,
      }));
    notifyHandoff({
      conversationId,
      clientIgUserId: client.igUserId,
      reason,
      lastMessages,
    }).catch((err) => log.error({ err }, 'Failed to send handoff notification'));
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Drain unclaimed inbound client messages into one or more Claude turns.
 * Caller must already hold `runConversationTurnSerialized` (see inbound-coalesce flush).
 */
export async function drainPendingInboundTurns(conversationId: string): Promise<void> {
  let onlyAfter: Date | undefined;

  for (let i = 0; i < MAX_DRAIN_ITERATIONS; i++) {
    const pending = await loadPendingInbound(conversationId, { onlyAfter });
    if (pending.length === 0) break;

    const turnId = newClaudeTurnId();
    const claimed = await claimInboundMessages(
      pending.map((m) => m.id),
      turnId,
    );
    if (claimed === 0) break;

    const batch = joinInboundBatch(pending);
    const turnGateAt = new Date();

    log.info(
      {
        conversationId,
        turnId,
        batchSize: pending.length,
        igMessageIds: batch.igMessageIds,
        textChars: batch.text.length,
        hasMedia: (batch.mediaUrls?.length ?? 0) > 0,
        hasSharedPost: !!batch.sharedPost,
        igContextKind: batch.igContext?.kind ?? null,
        drainIteration: i,
        onlyAfter: onlyAfter?.toISOString() ?? null,
      },
      'Starting coalesced inbound bot turn',
    );

    let outcome: BotTurnOutcome = 'released';
    try {
      outcome = await handleIncomingMessageImpl(
        conversationId,
        batch.text,
        batch.mediaUrls,
        batch.sharedPost,
        batch.mediaAttachments,
        batch.igMessageIds,
        batch.igContext,
      );
    } catch (err) {
      await releaseInboundClaim(turnId);
      log.error(
        { err, conversationId, turnId, drainIteration: i },
        'Coalesced inbound bot turn threw — claim released',
      );
      throw err;
    }

    if (outcome === 'skipped') {
      await markInboundSkipped(turnId);
    } else if (outcome === 'released') {
      await releaseInboundClaim(turnId);
    }

    log.info(
      {
        conversationId,
        turnId,
        outcome,
        claimDisposition:
          outcome === 'skipped'
            ? 'skipped'
            : outcome === 'released'
              ? 'released'
              : 'kept',
        drainIteration: i,
      },
      'Finished coalesced inbound bot turn',
    );

    // Follow-up iterations only pick up mids that arrived during this turn.
    onlyAfter = turnGateAt;
  }
}

async function handleIncomingMessageImpl(
  conversationId: string,
  messageText: string,
  mediaUrls?: string[],
  sharedPost?: SharedPostData,
  mediaAttachments?: StoredMediaAttachment[],
  sourceIgMessageIds?: string[],
  igContext?: IgInboundContext,
): Promise<BotTurnOutcome> {
  // ── 1. Fetch conversation with client ─────────────────────────────
  let conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { client: true, branch: true },
  });

  if (!conversation) {
    log.error({ conversationId }, 'Conversation not found');
    return 'released';
  }

  const { client } = conversation;

  /** Clear coalesce bootstrap typing when this turn will not produce a bot reply. */
  const clearTypingOnSkip = async (): Promise<void> => {
    if (client.igUserId) {
      await stopIgTypingBeforeSend(client.igUserId);
    }
  };

  // Remember conversation language once (heuristic from inbound text).
  if (!client.preferredLanguage && messageText.trim()) {
    const detected = detectClientLanguage(messageText);
    if (detected) {
      try {
        await prisma.client.update({
          where: { id: client.id },
          data: { preferredLanguage: detected },
        });
        client.preferredLanguage = detected;
      } catch (err) {
        log.warn({ err, clientId: client.id }, 'Failed to persist preferredLanguage');
      }
    }
  }

  if (!client.igUserId) {
    log.error({ conversationId, clientId: client.id }, 'Client has no igUserId');
    return 'released';
  }

  if (
    isReactionOnlyInbound({
      messageText,
      igContext,
      hasVisualMedia: visualStorageKeys(mediaAttachments, mediaUrls).length > 0,
      hasSharedPost: Boolean(sharedPost),
    })
  ) {
    log.info(
      {
        conversationId,
        reaction: igContext?.reaction?.reaction ?? igContext?.reaction?.emoji ?? null,
      },
      'Skipping Claude turn for reaction-only inbound',
    );
    await clearTypingOnSkip();
    return 'completed';
  }

  // Build a typed profile object from the client record.
  // Claude uses this to address the customer by name and skip asking
  // for data it already has (phone, delivery details from prior sessions).

  // Load previous orders for repeat-customer context
  const previousOrders = await prisma.order.findMany({
    where: {
      clientId: client.id,
      status: { not: 'draft' },
      conversationId: { not: conversationId }, // exclude current conversation's orders
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { items: true, status: true },
  });

  const conversationsCount = await prisma.conversation.count({
    where: { clientId: client.id },
  });

  // Build a short human-readable summary of past orders
  let previousOrdersSummary: string | undefined;
  if (previousOrders.length > 0) {
    const itemNames = previousOrders.flatMap((o) => {
      const items = Array.isArray(o.items) ? o.items : [];
      return items.map((i) => (i && typeof i === 'object' && !Array.isArray(i) ? String((i as Record<string, unknown>).name ?? '') : '')).filter(Boolean);
    });
    // Deduplicate and count
    const counts = itemNames.reduce<Record<string, number>>((acc, name: string) => {
      acc[name] = (acc[name] ?? 0) + 1;
      return acc;
    }, {});
    previousOrdersSummary = Object.entries(counts)
      .map(([name, count]) => (count > 1 ? `${name} (×${count})` : name))
      .join(', ');
  }

  const clientProfile: ClientProfile = {
    igUsername: client.igUsername ?? undefined,
    igFullName: client.igFullName ?? undefined,
    phone: client.phone ?? undefined,
    email: client.email ?? undefined,
    deliveryCity: client.deliveryCity ?? undefined,
    deliveryNpBranch: client.deliveryNpBranch ?? undefined,
    deliveryNpType: client.deliveryNpType ?? undefined,
    notes: client.notes ?? undefined,
    tags: client.tags.length > 0 ? client.tags : undefined,
    previousOrdersCount: previousOrders.length > 0 ? previousOrders.length : undefined,
    previousOrdersSummary,
    conversationsCount: conversationsCount > 1 ? conversationsCount : undefined,
    crmBuyerId: client.crmBuyerId ?? undefined,
  };

  // Salon CRM: compact link hint only (full visits via get_client_crm_history tool).
  if (client.crmBuyerId) {
    clientProfile.crmVisitHistory = formatCrmLinkHintForPrompt({
      crmBuyerId: client.crmBuyerId,
    });
  }

  // ── 2. Handoff state - skip bot response (unless idle timeout expired) ──
  if (conversation.state === 'handoff') {
    const returnedToBot = await autoReturnHandoffToBotIfExpired(conversation);
    if (returnedToBot) {
      const refreshed = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { client: true, branch: true },
      });
      if (!refreshed) {
        log.error({ conversationId }, 'Conversation not found after handoff auto-return');
        await clearTypingOnSkip();
        return 'released';
      }
      conversation = refreshed;
    } else {
      log.info(
        { conversationId },
        'Message in handoff mode, skipping bot response',
      );
      const handoffLine = formatHandoffMessageLine({
        sender: 'client',
        text: messageText,
        mediaAttachments,
      });
      notifyHandoff({
        conversationId,
        clientIgUserId: client.igUserId!,
        reason: conversation.handoffReason || 'Клієнт написав під час хендофу',
        lastMessages: handoffLine
          ? [{ sender: handoffLine.sender, text: handoffLine.text, isVoice: handoffLine.isVoice }]
          : [],
      }).catch((err) => log.error({ err }, 'Failed to forward to Telegram'));
      await clearTypingOnSkip();
      return 'skipped';
    }
  }

  // ── 3. Closed / paused - ignore ──────────────────────────────────
  if (conversation.state === 'closed' || conversation.state === 'paused') {
    log.debug(
      { conversationId, state: conversation.state },
      'Conversation closed or paused, ignoring',
    );
    await clearTypingOnSkip();
    return 'skipped';
  }

  // ── 3.5 Tenant-wide bot ignore list ───────────────────────────────
  const runtime = await getRuntimeConfig();
  if (isUsernameBotIgnored(runtime, client.igUsername)) {
    log.info(
      { conversationId, igUsername: client.igUsername },
      'Username on bot ignore list — skipping bot response',
    );
    await clearTypingOnSkip();
    return 'skipped';
  }

  const agentCfg = await getAgentConfig();

  const igTyping = await beginIgTypingIndicator({
    channel: conversation.channel,
    recipientId: client.igUserId,
  });

  let turnDebug: AgentTurnDebugCollector | null = null;
  const turnStartedMs = Date.now();

  try {
  // Human-like pause before Claude (typing indicator already on).
  const responseDelayMs = resolveResponseDelayMs(agentCfg);
  if (responseDelayMs > 0) {
    log.debug({ conversationId, responseDelayMs }, 'Applying response delay before Claude');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, responseDelayMs);
    });
  }

  // ── 4. Working hours check ────────────────────────────────────────
  const hours = await getWorkingHours();
  const now = new Date();
  const outOfHours = !isWithinWorkingHours(now, hours);

  if (outOfHours) {
    log.info(
      { conversationId },
      'Outside working hours - bot will respond with out-of-hours context',
    );
  }

  // ── 5. Build prompt ───────────────────────────────────────────────
  const [activeSystemPrompt, runtimeGeneration] = await Promise.all([
    getActiveSystemPrompt(),
    getPromptRuntimeGeneration(),
  ]);
  const catalog = await loadCatalogSnippetForMode(agentCfg.mode);

  // Per-tenant CRM field mappings — shapes both the prompt (extra-fields
  // hints) and the tool schema (update_client_info.custom_fields). Cache
  // TTL inside the module keeps this at ~0 cost on hot paths.
  //
  // Gated on CRM writes so the extended surface only appears when we can
  // persist what Claude extracts.
  const crmWritesEnabled = await isCrmWriteEnabled();
  const crmMappings = crmWritesEnabled
    ? await getActiveCrmFieldMappings()
    : null;

  // B.3 — returning-lead context: surface a recap of the most recent
  // finalized brief so the agent doesn't re-ask qualification questions.
  // Gate R6 (per FEATURE_AGENT_MODE_PLAN): prior brief must still be
  // "fresh enough" (≤ sessionFreshnessDays × 3) AND of decent quality.
  // Quality proxy = completenessPct ≥ 60 until B.2 ships manager star
  // ratings; swap the proxy for `briefQuality ≥ 3` once that lands.
  const previousBriefSummary = await loadPreviousBriefSummary(
    client.id,
    conversationId,
    agentCfg.sessionFreshnessDays,
  );

  const branchesList = await formatBranchesForPrompt();
  const activeBranchCount = await prisma.branch.count({ where: { isActive: true } });
  const { telegram: telegramCfg } = await getIntegrationConfig();
  const telegramBotsBlock = formatTelegramBotsPromptBlock(telegramCfg);

  const promptSession = createRuntimePromptSession({
    initial: activeSystemPrompt,
    generation: runtimeGeneration,
    rebuild: (content) =>
      buildRuntimePrompt({
        activePromptContent: content,
        catalogSnippet: catalog,
        currentTime: now,
        workingHours: hours,
        conversationState: conversation.state as 'bot' | 'handoff',
        clientIgUserId: client.igUserId ?? undefined,
        clientProfile,
        conversationIdShort: conversation.id.slice(0, 8),
        isOutOfHours: outOfHours,
        customFieldHints: crmMappings?.buyer.map((m) => ({
          localKey: m.localKey,
          label: m.label,
          promptHint: m.promptHint,
        })),
        agentMode: agentCfg.mode,
        outOfHoursStrategy: agentCfg.outOfHoursStrategy,
        managerSlaHoursBusiness: agentCfg.managerSlaHoursBusiness,
        previousBriefSummary,
        branchesList,
        telegramBotsBlock,
        selectedBranch: conversation.branch
          ? {
              slug: conversation.branch.slug,
              displayName: conversation.branch.displayName,
              address: conversation.branch.address,
              crmExternalId: conversation.branch.crmExternalId,
            }
          : undefined,
      }),
  });

  log.info(
    {
      conversationId,
      promptId: promptSession.getMeta().id,
      promptVersion: promptSession.getMeta().version,
      runtimeGeneration: promptSession.getMeta().generation,
    },
    'Turn using active system prompt',
  );

  const tools = buildAgentTools(agentCfg.mode, {
    buyerScopeMappings: crmMappings?.buyer ?? [],
    leadScopeMappings: crmMappings?.lead ?? [],
    hasBranches: activeBranchCount > 0,
  });

  // ── 6. Build conversation history (last 30 messages) ──────────────
  const rawMessages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: MAX_HISTORY_MESSAGES,
    select: {
      id: true,
      direction: true,
      text: true,
      sender: true,
      createdAt: true,
      igMessageId: true,
    },
  });

  const dedupedAsc = dedupeConversationMessages([...rawMessages].reverse());

  // Exclude current turn from history — it is passed separately as userMessage (Phase 4).
  const history = buildClaudeHistoryTurns(dedupedAsc, messageText, {
    excludeIgMessageIds: sourceIgMessageIds,
  });

  // ── 7. Resolve visual media for Claude (images/video only — not audio) ──
  const visualKeys = visualStorageKeys(mediaAttachments, mediaUrls);
  const localPaths =
    visualKeys.length > 0 ? await resolveVisualMediaPathsForClaude(visualKeys) : [];

  // ── 7b. Shared post - product availability lookup ─────────────────
  // When a user forwards an IG post, we search KeyCRM for matching active
  // products (non-archived, stock > 0) and inject the results into the
  // user message so Claude can answer availability questions accurately.
  //
  // Keywords come from the post caption. If the caption is empty or yields
  // no matches we fall through gracefully - the image + catalog.txt context
  // is still available to Claude via its vision capability.
  let enrichedMessageText = messageText;
  let catalogDebug: CatalogDebugMatch | null = null;

  const igContextHeader = enrichUserMessageWithIgContext(messageText, igContext);
  if (igContextHeader) {
    enrichedMessageText = igContextHeader;
    log.info(
      { conversationId, kind: igContext?.kind },
      'Message enriched with IG inbound context (story/reaction)',
    );
  }

  if (sharedPost) {
    log.info(
      { conversationId, postUrl: sharedPost.postUrl },
      'Shared post detected - enriching message with product availability',
    );

    // Prefix the message so Claude understands the user shared a post
    const sharedPostHeader = buildSharedPostHeader(sharedPost);

    // Try to find matching products from the caption keywords
    const caption = sharedPost.caption ?? '';
    const keywords = extractKeywordsFromCaption(caption);

    let availabilityBlock = '';

    if (keywords) {
      try {
        const { contextBlock, matchCount } = await searchActiveProductsForContext(keywords);
        availabilityBlock = contextBlock;
        catalogDebug = {
          query: keywords,
          matchCount,
          contextBlock,
          source: 'shared_post',
        };
      } catch (err) {
        // Non-critical - Claude can still use the image to identify the product
        log.warn({ err, keywords }, 'Product availability search failed (non-fatal)');
      }
    }

    // Build the enriched user message that Claude will receive.
    // Structure: [shared post header] + [availability data if found] + [original / IG context text]
    const parts: string[] = [sharedPostHeader];
    if (availabilityBlock) {
      parts.push(availabilityBlock);
    }
    if (igContextHeader) {
      parts.push(igContextHeader);
    } else if (messageText.trim()) {
      parts.push(`Повідомлення клієнта: "${messageText.trim()}"`);
    }
    enrichedMessageText = parts.join('\n\n');

    log.info(
      {
        conversationId,
        hasAvailability: !!availabilityBlock,
        keywords,
        enrichedLength: enrichedMessageText.length,
      },
      'Message enriched with shared post context',
    );
  } else if (!igContextHeader && !messageText.trim() && localPaths.length > 0) {
    // Image/video without caption — guide Claude to read product screenshots.
    enrichedMessageText =
      '[Клієнт надіслав зображення без тексту. Якщо це скрін/фото товару — прочитай назву, ціну, розмір/колір і допоможи оформити замовлення. Якщо відео не вклалось у vision — попроси фото або посилання.]';
  } else if (!igContextHeader && !messageText.trim() && localPaths.length === 0) {
    const audioItems = (mediaAttachments ?? []).filter((a) => a.kind === 'audio');
    const hasTranscript = audioItems.some((a) => a.transcript?.trim());
    if (audioItems.length > 0 && !hasTranscript) {
      const anyPlayable = audioItems.some((a) => a.status === 'ready' && a.storageKey);
      enrichedMessageText = anyPlayable
        ? '[Клієнт надіслав голосове повідомлення. Транскрипція не вдалась — відповідай коротко українською та запропонуй написати текстом.]'
        : '[Клієнт надіслав голосове повідомлення, але прослухати його поки неможливо — відповідай коротко та запропонуй написати текстом.]';
    }
  }

  // ── 8. Call Claude ────────────────────────────────────────────────
  const hasVoiceTranscript = (mediaAttachments ?? []).some(
    (a) => a.kind === 'audio' && a.sttStatus === 'ok' && !!a.transcript?.trim(),
  );
  const claudeTimeoutMs = hasVoiceTranscript
    ? config.CLAUDE_VOICE_TIMEOUT_MS
    : undefined;

  if (hasVoiceTranscript) {
    log.info(
      { conversationId, timeoutMs: claudeTimeoutMs },
      'Voice turn — using extended Claude timeout',
    );
  }

  const turnStartedAt = new Date();
  turnDebug = createAgentTurnDebugCollector();
  // Local non-null alias for the rest of the turn (finally still uses turnDebug).
  const debug = turnDebug;
  debug.agentMode = agentCfg.mode;
  debug.clientMessage = messageText;
  debug.promptId = promptSession.getMeta().id;
  debug.promptVersion = promptSession.getMeta().version;
  debug.runtimeGeneration = promptSession.getMeta().generation;

  /** Soft-refresh active prompt before every Claude round (P1: mid-turn activate). */
  const sessions = createTurnClaudeSessions();
  const replyModel = normalizeClaudeReplyModel(agentCfg.claudeModel);

  async function askTurnClaude(
    req: Omit<ClaudeRequest, 'systemPrompt'>,
    ctx: ClaudeCallContext,
    opts?: { purpose?: 'reply' | 'router' },
  ) {
    const purpose = opts?.purpose ?? 'reply';
    const model = purpose === 'router' ? CLAUDE_ROUTER_MODEL : replyModel;

    const { prompt: systemPrompt, refreshed, meta } = await promptSession.refreshIfStale();
    if (refreshed) {
      // New system prompt must start fresh Claude Code sessions.
      sessions.clearAll();
      debug.promptRefreshedMidTurn = true;
      debug.promptId = meta.id;
      debug.promptVersion = meta.version;
      debug.runtimeGeneration = meta.generation;
      log.info(
        {
          conversationId,
          promptId: meta.id,
          promptVersion: meta.version,
          runtimeGeneration: meta.generation,
        },
        'Rebuilt system prompt mid-turn after activate',
      );
    }

    const resumeSessionId = sessions.resumeIdFor(purpose);
    const response = await askClaude(
      {
        ...req,
        systemPrompt,
        ...(resumeSessionId ? { resumeSessionId } : {}),
      },
      { ...ctx, model },
    );

    recordTurnSpawn(debug, {
      purpose,
      model,
      resumed: Boolean(response.resumed),
      inputChars: response.inputChars,
    });

    if (response.fallback) {
      sessions.noteFallback(purpose);
    } else {
      sessions.noteSuccess(purpose, response.sessionId);
    }
    return response;
  }

  /**
   * Tool follow-up: Haiku decides whether to call more tools; customer-facing
   * prose resumes the reply-model session (no cold full prompt when possible).
   */
  async function askTurnClaudeFollowUp(
    req: Omit<ClaudeRequest, 'systemPrompt'>,
    ctx: ClaudeCallContext,
  ) {
    const routed = await askTurnClaude(req, ctx, { purpose: 'router' });
    if (routed.fallback) return routed;
    if (routed.toolCalls && routed.toolCalls.length > 0) return routed;
    return askTurnClaude(req, ctx, { purpose: 'reply' });
  }

  const response = await askTurnClaude(
    {
      conversationHistory: history,
      userMessage: enrichedMessageText,
      images: localPaths.length > 0 ? localPaths : undefined,
      tools,
    },
    {
      channel: conversation.channel,
      conversationId,
      clientId: client.id,
      timeoutMs: claudeTimeoutMs,
    },
  );

  // ── 9. Handle tool calls ──────────────────────────────────────────
  let responseText = response.text;
  let agentFallback: ClaudeResponse['fallback'] | undefined = response.fallback;
  let agentErrorDetail: string | undefined = response.errorDetail;
  /** First Claude text this turn — used for admin vision debug notes. */
  const firstClaudeText = response.text;

  recordTurnRound(debug, {
    label: 'first',
    toolCalls: (response.toolCalls ?? []).map((tc) => tc.name),
    toolCall: response.toolCalls?.[0]?.name ?? null,
    textPreview: response.text,
    fallback: response.fallback ?? null,
  });

  if (response.toolCalls && response.toolCalls.length > 0) {
    await runSideEffectToolCalls(
      response.toolCalls,
      client.id,
      conversationId,
      mediaAttachments,
      turnDebug,
    );

    if (
      await tryTerminalToolCalls(response.toolCalls, {
        conversationId,
        client,
        agentMode: agentCfg.mode,
        clientMessage: stripMarkdownForInstagram(response.text),
        turnStartedAt,
        turnDebug: debug,
      })
    ) {
      return 'completed';
    }

    const handoff = response.toolCalls.find((tc) => tc.name === 'request_handoff');
    const collectOrder = response.toolCalls.find((tc) => tc.name === 'collect_order');
    const createLocalOrder = response.toolCalls.find((tc) => tc.name === 'create_local_order');
    const bookAppointment = response.toolCalls.find((tc) => tc.name === 'book_appointment');
    const submitBrief = response.toolCalls.find((tc) => tc.name === 'submit_brief');

    // submit_brief — leadgen-mode terminal tool. After persisting the
    // brief and firing notifications, we still let the bot's text reply
    // fall through so the client sees the closing message (with SLA /
    // out-of-hours copy from the prompt-builder).
    if (submitBrief && agentCfg.mode === 'leadgen') {
      await handleSubmitBrief(
        conversationId,
        client.id,
        client.igUserId!,
        submitBrief.args,
      );
    }

    // search_catalog — live CRM/catalog lookup, then re-invoke Claude
    const searchCatalogCall = response.toolCalls.find((tc) => tc.name === 'search_catalog');
    const deliveryCostCall = response.toolCalls.find((tc) => tc.name === 'get_delivery_cost');

    if (
      searchCatalogCall &&
      !handoff &&
      !collectOrder &&
      !createLocalOrder &&
      !deliveryCostCall
    ) {
      const query =
        typeof searchCatalogCall.args.query === 'string'
          ? searchCatalogCall.args.query.trim()
          : '';

      let toolResultContent: string;
      if (!query) {
        toolResultContent = '[search_catalog] ПОМИЛКА: порожній запит';
      } else {
        try {
          const { contextBlock, matchCount } = await searchActiveProductsForContext(query);
          catalogDebug = {
            query,
            matchCount,
            contextBlock,
            source: 'search_catalog',
          };
          toolResultContent =
            matchCount > 0
              ? `[search_catalog] РЕЗУЛЬТАТ:\n${contextBlock}`
              : `[search_catalog] Нічого не знайдено за «${query}». Уточни у клієнта назву/модель або запропонуй схожі з каталогу.`;
        } catch (err) {
          log.error({ err, query }, 'search_catalog failed');
          toolResultContent =
            '[search_catalog] ПОМИЛКА: каталог тимчасово недоступний. Відповідай за знімком каталогу в промпті.';
        }
      }
      recordTurnTool(debug, 'search_catalog', searchCatalogCall.args, toolResultContent);

      const historyWithResult = [
        ...history,
        { role: 'user' as const, content: enrichedMessageText },
        {
          role: 'assistant' as const,
          content: response.text || `[Шукаю в каталозі: ${query}]`,
        },
      ];

      const response2 = await askTurnClaudeFollowUp(
        {
          conversationHistory: historyWithResult,
          userMessage: toolResultContent,
          tools,
        },
        {
          channel: conversation.channel,
          conversationId,
          clientId: client.id,
          model: agentCfg.claudeModel,
        },
      );

      responseText = response2.text;
      agentFallback = response2.fallback ?? agentFallback;
      if (response2.errorDetail) agentErrorDetail = response2.errorDetail;
      if (response2.toolCalls?.length) {
        await runSideEffectToolCalls(response2.toolCalls, client.id, conversationId, mediaAttachments, debug);
        if (
          await tryTerminalToolCalls(response2.toolCalls, {
            conversationId,
            client,
            agentMode: agentCfg.mode,
            clientMessage: stripMarkdownForInstagram(response2.text),
            turnStartedAt,
            turnDebug: debug,
          })
        ) {
          return 'completed';
        }
      }
      log.info({ conversationId, query }, 'Catalog search completed and Claude re-invoked');
    }

    // get_delivery_cost - query tool: fetch NP price, then re-invoke Claude with the result
    if (deliveryCostCall && !handoff && !collectOrder && !createLocalOrder && !searchCatalogCall) {
      const city = typeof deliveryCostCall.args.city === 'string' ? deliveryCostCall.args.city : '';
      const weightKg = typeof deliveryCostCall.args.weight_kg === 'number'
        ? deliveryCostCall.args.weight_kg
        : 0.5;
      const declaredValue = typeof deliveryCostCall.args.declared_value === 'number'
        ? deliveryCostCall.args.declared_value
        : 500;

      let toolResultContent: string;
      if (!city) {
        toolResultContent = '[get_delivery_cost] ПОМИЛКА: місто не вказано';
      } else {
        try {
          const npResult = await getDeliveryCost(city, weightKg, declaredValue);
          if ('error' in npResult) {
            toolResultContent = `[get_delivery_cost] ПОМИЛКА: ${npResult.error}`;
          } else {
            toolResultContent = `[get_delivery_cost] РЕЗУЛЬТАТ: Місто "${npResult.recipientCityName}", доставка НП (${npResult.serviceType}): ${npResult.cost} грн`;
          }
        } catch (npErr) {
          log.error({ err: npErr, city }, 'Nova Poshta getDeliveryCost failed');
          toolResultContent = '[get_delivery_cost] ПОМИЛКА: сервіс тимчасово недоступний';
        }
      }
      recordTurnTool(debug, 'get_delivery_cost', deliveryCostCall.args, toolResultContent);

      // Second Claude call: inject tool result so Claude can reply to the client
      const historyWithResult = [
        ...history,
        { role: 'user' as const, content: enrichedMessageText },
        { role: 'assistant' as const, content: response.text || `[Перевіряю вартість доставки до ${city}]` },
      ];

      const response2 = await askTurnClaudeFollowUp(
        {
          conversationHistory: historyWithResult,
          userMessage: toolResultContent,
          tools,
        },
        {
          channel: conversation.channel,
          conversationId,
          clientId: client.id,
          model: agentCfg.claudeModel,
        },
      );

      responseText = response2.text;
      agentFallback = response2.fallback ?? agentFallback;
      if (response2.errorDetail) agentErrorDetail = response2.errorDetail;
      if (response2.toolCalls?.length) {
        await runSideEffectToolCalls(response2.toolCalls, client.id, conversationId, mediaAttachments, debug);
        if (
          await tryTerminalToolCalls(response2.toolCalls, {
            conversationId,
            client,
            agentMode: agentCfg.mode,
            clientMessage: stripMarkdownForInstagram(response2.text),
            turnStartedAt,
            turnDebug: debug,
          })
        ) {
          return 'completed';
        }
      }
      log.info({ conversationId, city, toolResultContent }, 'Delivery cost fetched and Claude re-invoked');
    }

    const searchServicesCall = response.toolCalls.find((tc) => tc.name === 'search_services');
    const slotsCall = response.toolCalls.find((tc) => tc.name === 'get_available_slots');
    const crmHistoryCall = response.toolCalls.find((tc) => tc.name === 'get_client_crm_history');

    if (crmHistoryCall && !handoff && !collectOrder && !createLocalOrder && !bookAppointment && !searchServicesCall) {
      let toolResultContent: string;
      try {
        const history = await fetchClientCrmHistory(client.id, { limit: 10 });
        toolResultContent = `[get_client_crm_history] РЕЗУЛЬТАТ:\n${history.text}`;
      } catch (err) {
        log.error({ err, clientId: client.id }, 'get_client_crm_history failed');
        toolResultContent = '[get_client_crm_history] ПОМИЛКА: не вдалося отримати історію CRM';
      }
      recordTurnTool(debug, 'get_client_crm_history', crmHistoryCall.args, toolResultContent);

      const response2 = await askTurnClaudeFollowUp(
        {
          conversationHistory: [
            ...history,
            { role: 'user' as const, content: enrichedMessageText },
            {
              role: 'assistant' as const,
              content: response.text || '[Дивлюсь історію візитів клієнта в CRM]',
            },
          ],
          userMessage: toolResultContent,
          tools,
        },
        { channel: conversation.channel, conversationId, clientId: client.id, model: agentCfg.claudeModel },
      );
      responseText = response2.text;
      agentFallback = response2.fallback ?? agentFallback;
      if (response2.errorDetail) agentErrorDetail = response2.errorDetail;
      recordTurnRound(debug, {
        label: 'after_crm_history',
        toolCalls: (response2.toolCalls ?? []).map((tc) => tc.name),
        textPreview: response2.text,
        fallback: response2.fallback ?? null,
      });
      if (response2.toolCalls?.length) {
        await runSideEffectToolCalls(response2.toolCalls, client.id, conversationId, mediaAttachments, debug);
        if (
          await tryTerminalToolCalls(response2.toolCalls, {
            conversationId,
            client,
            agentMode: agentCfg.mode,
            clientMessage: stripMarkdownForInstagram(response2.text),
            turnStartedAt,
            turnDebug: debug,
          })
        ) {
          return 'completed';
        }
      }
    }

    if (searchServicesCall && !handoff && !collectOrder && !createLocalOrder && !bookAppointment) {
      const query =
        typeof searchServicesCall.args.query === 'string'
          ? searchServicesCall.args.query.trim()
          : '';
      let toolResultContent: string;
      if (!query) {
        toolResultContent = '[search_services] ПОМИЛКА: порожній запит';
      } else {
        try {
          const found = await searchServicesWithFallback(
            query,
            parseSearchServicesLimit(searchServicesCall.args),
            { clientMessage: messageText },
          );
          toolResultContent = formatSearchServicesToolResult({
            query,
            matchCount: found.matchCount,
            contextBlock: found.contextBlock,
            usedQuery: found.usedQuery,
            broadenedFrom: found.broadenedFrom,
            intentNote: found.intentNote,
          });
        } catch (err) {
          log.error({ err, query }, 'search_services failed');
          toolResultContent = '[search_services] ПОМИЛКА: CRM тимчасово недоступна.';
        }
      }
      recordTurnTool(debug, 'search_services', searchServicesCall.args, toolResultContent);

      const response2 = await askTurnClaudeFollowUp(
        {
          conversationHistory: [
            ...history,
            { role: 'user' as const, content: enrichedMessageText },
            { role: 'assistant' as const, content: response.text || `[Шукаю послуги: ${query}]` },
          ],
          userMessage: toolResultContent,
          tools,
        },
        { channel: conversation.channel, conversationId, clientId: client.id, model: agentCfg.claudeModel },
      );
      responseText = response2.text;
      agentFallback = response2.fallback ?? agentFallback;
      if (response2.errorDetail) agentErrorDetail = response2.errorDetail;
      recordTurnRound(debug, {
        label: 'after_search_services',
        toolCalls: (response2.toolCalls ?? []).map((tc) => tc.name),
        textPreview: response2.text,
        fallback: response2.fallback ?? null,
      });

      // Continue booking chain: after search results Claude often calls get_available_slots.
      let followUps = response2.toolCalls ?? [];
      let followAssistant = response2.text || `[Шукаю послуги: ${query}]`;
      for (let chain = 0; chain < 3 && followUps.length > 0; chain++) {
        await runSideEffectToolCalls(followUps, client.id, conversationId, mediaAttachments, debug);
        if (
          await tryTerminalToolCalls(followUps, {
            conversationId,
            client,
            agentMode: agentCfg.mode,
            clientMessage: stripMarkdownForInstagram(followAssistant),
            turnStartedAt,
            turnDebug: debug,
          })
        ) {
          return 'completed';
        }

        const nextSlots = followUps.find((tc) => tc.name === 'get_available_slots');
        const nextSearch = followUps.find((tc) => tc.name === 'search_services');

        if (nextSlots) {
          const slotsResult = await executeGetAvailableSlotsTool({
            args: nextSlots.args,
            branchCrmExternalId: conversation.branch?.crmExternalId,
          });
          recordTurnTool(debug, 'get_available_slots', nextSlots.args, slotsResult);
          const afterSlots = await askTurnClaudeFollowUp(
            {
              conversationHistory: [
                ...history,
                { role: 'user' as const, content: enrichedMessageText },
                { role: 'assistant' as const, content: followAssistant },
              ],
              userMessage: slotsResult,
              tools,
            },
            {
              channel: conversation.channel,
              conversationId,
              clientId: client.id,
              model: agentCfg.claudeModel,
            },
          );
          responseText = afterSlots.text;
          agentFallback = afterSlots.fallback ?? agentFallback;
          if (afterSlots.errorDetail) agentErrorDetail = afterSlots.errorDetail;
          recordTurnRound(debug, {
            label: 'after_slots',
            toolCalls: (afterSlots.toolCalls ?? []).map((tc) => tc.name),
            textPreview: afterSlots.text,
            fallback: afterSlots.fallback ?? null,
          });
          followUps = afterSlots.toolCalls ?? [];
          followAssistant = afterSlots.text || followAssistant;
          continue;
        }

        if (nextSearch) {
          const q2 =
            typeof nextSearch.args.query === 'string' ? nextSearch.args.query.trim() : '';
          let searchResult: string;
          if (!q2) {
            searchResult = '[search_services] ПОМИЛКА: порожній запит';
          } else {
            try {
              const found = await searchServicesWithFallback(
                q2,
                parseSearchServicesLimit(nextSearch.args),
                { clientMessage: messageText },
              );
              searchResult = formatSearchServicesToolResult({
                query: q2,
                matchCount: found.matchCount,
                contextBlock: found.contextBlock,
                usedQuery: found.usedQuery,
                broadenedFrom: found.broadenedFrom,
                intentNote: found.intentNote,
              });
            } catch (err) {
              log.error({ err, query: q2 }, 'search_services follow-up failed');
              searchResult = '[search_services] ПОМИЛКА: CRM тимчасово недоступна.';
            }
          }
          recordTurnTool(debug, 'search_services', nextSearch.args, searchResult);
          const afterSearch = await askTurnClaudeFollowUp(
            {
              conversationHistory: [
                ...history,
                { role: 'user' as const, content: enrichedMessageText },
                { role: 'assistant' as const, content: followAssistant },
              ],
              userMessage: searchResult,
              tools,
            },
            {
              channel: conversation.channel,
              conversationId,
              clientId: client.id,
              model: agentCfg.claudeModel,
            },
          );
          responseText = afterSearch.text;
          agentFallback = afterSearch.fallback ?? agentFallback;
          if (afterSearch.errorDetail) agentErrorDetail = afterSearch.errorDetail;
          recordTurnRound(debug, {
            label: 'after_search_services_retry',
            toolCalls: (afterSearch.toolCalls ?? []).map((tc) => tc.name),
            textPreview: afterSearch.text,
            fallback: afterSearch.fallback ?? null,
          });
          followUps = afterSearch.toolCalls ?? [];
          followAssistant = afterSearch.text || followAssistant;
          continue;
        }

        break;
      }
    }

    if (
      slotsCall &&
      !handoff &&
      !collectOrder &&
      !createLocalOrder &&
      !bookAppointment &&
      !searchServicesCall &&
      !crmHistoryCall
    ) {
      const toolResultContent = await executeGetAvailableSlotsTool({
        args: slotsCall.args,
        branchCrmExternalId: conversation.branch?.crmExternalId,
      });
      recordTurnTool(debug, 'get_available_slots', slotsCall.args, toolResultContent);
      const date =
        typeof slotsCall.args.date === 'string' ? slotsCall.args.date.trim() : '';

      const response2 = await askTurnClaudeFollowUp(
        {
          conversationHistory: [
            ...history,
            { role: 'user' as const, content: enrichedMessageText },
            { role: 'assistant' as const, content: response.text || `[Перевіряю слоти на ${date}]` },
          ],
          userMessage: toolResultContent,
          tools,
        },
        { channel: conversation.channel, conversationId, clientId: client.id, model: agentCfg.claudeModel },
      );
      responseText = response2.text;
      agentFallback = response2.fallback ?? agentFallback;
      if (response2.errorDetail) agentErrorDetail = response2.errorDetail;
      recordTurnRound(debug, {
        label: 'after_slots',
        toolCalls: (response2.toolCalls ?? []).map((tc) => tc.name),
        textPreview: response2.text,
        fallback: response2.fallback ?? null,
      });
      if (response2.toolCalls?.length) {
        await runSideEffectToolCalls(response2.toolCalls, client.id, conversationId, mediaAttachments, debug);
        if (
          await tryTerminalToolCalls(response2.toolCalls, {
            conversationId,
            client,
            agentMode: agentCfg.mode,
            clientMessage: stripMarkdownForInstagram(response2.text),
            turnStartedAt,
            turnDebug: debug,
          })
        ) {
          return 'completed';
        }
      }
    }
  }

  const slotsExecuted = debug.tools.some((t) => t.name === 'get_available_slots');
  const canGetSlots = tools.some((t) => t.name === 'get_available_slots');
  const canSearchServices = tools.some((t) => t.name === 'search_services');
  const canSearchCatalog = tools.some((t) => t.name === 'search_catalog');

  // Recover when the model promised free slots but never ran get_available_slots.
  if (
    !agentFallback &&
    canGetSlots &&
    !slotsExecuted &&
    looksLikeDeferredSlotsPromise(responseText)
  ) {
    const nudge = buildDeferredLookupNudge('get_available_slots');
    log.warn(
      { conversationId, stallPreview: responseText.slice(0, 200) },
      'Deferred slots promise without get_available_slots — forcing recovery',
    );
    debug.stallRecovery = true;

    const recovery = await askTurnClaudeFollowUp(
      {
        conversationHistory: [
          ...history,
          { role: 'user' as const, content: enrichedMessageText },
          { role: 'assistant' as const, content: responseText },
        ],
        userMessage: nudge,
        tools,
      },
      {
        channel: conversation.channel,
        conversationId,
        clientId: client.id,
        model: agentCfg.claudeModel,
      },
    );

    responseText = recovery.text;
    agentFallback = recovery.fallback ?? agentFallback;
    if (recovery.errorDetail) agentErrorDetail = recovery.errorDetail;
    recordTurnRound(debug, {
      label: 'slots_stall_recovery',
      toolCalls: (recovery.toolCalls ?? []).map((tc) => tc.name),
      textPreview: recovery.text,
      fallback: recovery.fallback ?? null,
    });

    if (recovery.toolCalls?.length) {
      await runSideEffectToolCalls(recovery.toolCalls, client.id, conversationId, mediaAttachments, debug);
      if (
        await tryTerminalToolCalls(recovery.toolCalls, {
          conversationId,
          client,
          agentMode: agentCfg.mode,
          clientMessage: stripMarkdownForInstagram(recovery.text),
          turnStartedAt,
          turnDebug: debug,
        })
      ) {
        return 'completed';
      }

      const recoverySlots = recovery.toolCalls.find((tc) => tc.name === 'get_available_slots');
      const recoverySearch = recovery.toolCalls.find((tc) => tc.name === 'search_services');

      if (recoverySlots) {
        const slotsResult = await executeGetAvailableSlotsTool({
          args: recoverySlots.args,
          branchCrmExternalId: conversation.branch?.crmExternalId,
        });
        recordTurnTool(debug, 'get_available_slots', recoverySlots.args, slotsResult);
        const afterSlots = await askTurnClaudeFollowUp(
          {
            conversationHistory: [
              ...history,
              { role: 'user' as const, content: enrichedMessageText },
              { role: 'assistant' as const, content: recovery.text || '[Перевіряю слоти]' },
            ],
            userMessage: slotsResult,
            tools,
          },
          {
            channel: conversation.channel,
            conversationId,
            clientId: client.id,
            model: agentCfg.claudeModel,
          },
        );
        responseText = afterSlots.text;
        agentFallback = afterSlots.fallback ?? agentFallback;
        if (afterSlots.errorDetail) agentErrorDetail = afterSlots.errorDetail;
        recordTurnRound(debug, {
          label: 'after_slots_recovery',
          toolCalls: (afterSlots.toolCalls ?? []).map((tc) => tc.name),
          textPreview: afterSlots.text,
          fallback: afterSlots.fallback ?? null,
        });
      } else if (recoverySearch && canSearchServices) {
        const q =
          typeof recoverySearch.args.query === 'string' ? recoverySearch.args.query.trim() : '';
        let searchResult: string;
        if (!q) {
          searchResult = '[search_services] ПОМИЛКА: порожній запит';
        } else {
          try {
            const found = await searchServicesWithFallback(
              q,
              parseSearchServicesLimit(recoverySearch.args),
              { clientMessage: messageText },
            );
            searchResult = formatSearchServicesToolResult({
              query: q,
              matchCount: found.matchCount,
              contextBlock: found.contextBlock,
              usedQuery: found.usedQuery,
              broadenedFrom: found.broadenedFrom,
              intentNote: found.intentNote,
            });
          } catch (err) {
            log.error({ err, query: q }, 'search_services failed (slots recovery)');
            searchResult = '[search_services] ПОМИЛКА: CRM тимчасово недоступна.';
          }
        }
        recordTurnTool(debug, 'search_services', recoverySearch.args, searchResult);
        const afterSearch = await askTurnClaudeFollowUp(
          {
            conversationHistory: [
              ...history,
              { role: 'user' as const, content: enrichedMessageText },
              { role: 'assistant' as const, content: recovery.text || '[Шукаю послуги]' },
            ],
            userMessage: searchResult,
            tools,
          },
          {
            channel: conversation.channel,
            conversationId,
            clientId: client.id,
            model: agentCfg.claudeModel,
          },
        );
        responseText = afterSearch.text;
        agentFallback = afterSearch.fallback ?? agentFallback;
        if (afterSearch.errorDetail) agentErrorDetail = afterSearch.errorDetail;
        recordTurnRound(debug, {
          label: 'after_search_in_slots_recovery',
          toolCalls: (afterSearch.toolCalls ?? []).map((tc) => tc.name),
          textPreview: afterSearch.text,
          fallback: afterSearch.fallback ?? null,
        });

        const chainedSlots = afterSearch.toolCalls?.find((tc) => tc.name === 'get_available_slots');
        if (chainedSlots) {
          const slotsResult = await executeGetAvailableSlotsTool({
            args: chainedSlots.args,
            branchCrmExternalId: conversation.branch?.crmExternalId,
          });
          recordTurnTool(debug, 'get_available_slots', chainedSlots.args, slotsResult);
          const afterSlots = await askTurnClaudeFollowUp(
            {
              conversationHistory: [
                ...history,
                { role: 'user' as const, content: enrichedMessageText },
                {
                  role: 'assistant' as const,
                  content: afterSearch.text || '[Перевіряю слоти]',
                },
              ],
              userMessage: slotsResult,
              tools,
            },
            {
              channel: conversation.channel,
              conversationId,
              clientId: client.id,
              model: agentCfg.claudeModel,
            },
          );
          responseText = afterSlots.text;
          agentFallback = afterSlots.fallback ?? agentFallback;
          if (afterSlots.errorDetail) agentErrorDetail = afterSlots.errorDetail;
          recordTurnRound(debug, {
            label: 'after_slots_chained',
            toolCalls: (afterSlots.toolCalls ?? []).map((tc) => tc.name),
            textPreview: afterSlots.text,
            fallback: afterSlots.fallback ?? null,
          });
        }
      }
    }
  }

  // Recover once when the model promised a catalog lookup without any lookup tools.
  const hadLookupToolCall =
    response.toolCalls?.some(
      (tc) =>
        tc.name === 'search_services' ||
        tc.name === 'search_catalog' ||
        tc.name === 'get_available_slots',
    ) ?? false;

  if (
    !agentFallback &&
    !hadLookupToolCall &&
    !debug.stallRecovery &&
    looksLikeDeferredLookupPromise(responseText) &&
    (canSearchServices || canSearchCatalog)
  ) {
    const lookupTool = canSearchServices ? 'search_services' : 'search_catalog';
    const nudge = buildDeferredLookupNudge(lookupTool);
    log.warn(
      { conversationId, lookupTool, stallPreview: responseText.slice(0, 200) },
      'Deferred lookup promise without tool call — forcing one recovery turn',
    );
    debug.stallRecovery = true;

    const recovery = await askTurnClaudeFollowUp(
      {
        conversationHistory: [
          ...history,
          { role: 'user' as const, content: enrichedMessageText },
          { role: 'assistant' as const, content: responseText },
        ],
        userMessage: nudge,
        tools,
      },
      {
        channel: conversation.channel,
        conversationId,
        clientId: client.id,
        model: agentCfg.claudeModel,
      },
    );

    responseText = recovery.text;
    agentFallback = recovery.fallback ?? agentFallback;
    if (recovery.errorDetail) agentErrorDetail = recovery.errorDetail;
    recordTurnRound(debug, {
      label: 'stall_recovery',
      toolCalls: (recovery.toolCalls ?? []).map((tc) => tc.name),
      textPreview: recovery.text,
      fallback: recovery.fallback ?? null,
    });

    if (recovery.toolCalls?.length) {
      await runSideEffectToolCalls(recovery.toolCalls, client.id, conversationId, mediaAttachments, debug);
      if (
        await tryTerminalToolCalls(recovery.toolCalls, {
          conversationId,
          client,
          agentMode: agentCfg.mode,
          clientMessage: stripMarkdownForInstagram(recovery.text),
          turnStartedAt,
          turnDebug: debug,
        })
      ) {
        return 'completed';
      }

      const recoverySearchServices = recovery.toolCalls.find((tc) => tc.name === 'search_services');
      const recoverySearchCatalog = recovery.toolCalls.find((tc) => tc.name === 'search_catalog');
      const recoverySlotsCall = recovery.toolCalls.find((tc) => tc.name === 'get_available_slots');

      if (recoverySearchServices && canSearchServices) {
        const query =
          typeof recoverySearchServices.args.query === 'string'
            ? recoverySearchServices.args.query.trim()
            : '';
        let toolResultContent: string;
        if (!query) {
          toolResultContent = '[search_services] ПОМИЛКА: порожній запит';
        } else {
          try {
            const found = await searchServicesWithFallback(
              query,
              parseSearchServicesLimit(recoverySearchServices.args),
              { clientMessage: messageText },
            );
            toolResultContent = formatSearchServicesToolResult({
              query,
              matchCount: found.matchCount,
              contextBlock: found.contextBlock,
              usedQuery: found.usedQuery,
              broadenedFrom: found.broadenedFrom,
              intentNote: found.intentNote,
            });
          } catch (err) {
            log.error({ err, query }, 'search_services failed (stall recovery)');
            toolResultContent = '[search_services] ПОМИЛКА: CRM тимчасово недоступна.';
          }
        }
        recordTurnTool(debug, 'search_services', recoverySearchServices.args, toolResultContent);

        const afterSearch = await askTurnClaudeFollowUp(
          {
            conversationHistory: [
              ...history,
              { role: 'user' as const, content: enrichedMessageText },
              {
                role: 'assistant' as const,
                content: recovery.text || `[Шукаю послуги: ${query}]`,
              },
            ],
            userMessage: toolResultContent,
            tools,
          },
          {
            channel: conversation.channel,
            conversationId,
            clientId: client.id,
            model: agentCfg.claudeModel,
          },
        );
        responseText = afterSearch.text;
        agentFallback = afterSearch.fallback ?? agentFallback;
        if (afterSearch.errorDetail) agentErrorDetail = afterSearch.errorDetail;
        if (afterSearch.toolCalls?.length) {
          await runSideEffectToolCalls(
            afterSearch.toolCalls,
            client.id,
            conversationId,
            mediaAttachments,
            debug,
          );
          if (
            await tryTerminalToolCalls(afterSearch.toolCalls, {
              conversationId,
              client,
              agentMode: agentCfg.mode,
              clientMessage: stripMarkdownForInstagram(afterSearch.text),
              turnStartedAt,
              turnDebug: debug,
            })
          ) {
            return 'completed';
          }

          const chainedSlots = afterSearch.toolCalls.find((tc) => tc.name === 'get_available_slots');
          if (chainedSlots) {
            const slotsResult = await executeGetAvailableSlotsTool({
              args: chainedSlots.args,
              branchCrmExternalId: conversation.branch?.crmExternalId,
            });
            recordTurnTool(debug, 'get_available_slots', chainedSlots.args, slotsResult);
            const afterSlots = await askTurnClaudeFollowUp(
              {
                conversationHistory: [
                  ...history,
                  { role: 'user' as const, content: enrichedMessageText },
                  {
                    role: 'assistant' as const,
                    content: afterSearch.text || '[Перевіряю слоти]',
                  },
                ],
                userMessage: slotsResult,
                tools,
              },
              {
                channel: conversation.channel,
                conversationId,
                clientId: client.id,
                model: agentCfg.claudeModel,
              },
            );
            responseText = afterSlots.text;
            agentFallback = afterSlots.fallback ?? agentFallback;
            if (afterSlots.errorDetail) agentErrorDetail = afterSlots.errorDetail;
          }
        }
      } else if (recoverySearchCatalog && canSearchCatalog) {
        const query =
          typeof recoverySearchCatalog.args.query === 'string'
            ? recoverySearchCatalog.args.query.trim()
            : '';
        let toolResultContent: string;
        if (!query) {
          toolResultContent = '[search_catalog] ПОМИЛКА: порожній запит';
        } else {
          try {
            const { contextBlock, matchCount } = await searchActiveProductsForContext(query);
            catalogDebug = {
              query,
              matchCount,
              contextBlock,
              source: 'search_catalog',
            };
            toolResultContent =
              matchCount > 0
                ? `[search_catalog] РЕЗУЛЬТАТ:\n${contextBlock}`
                : `[search_catalog] Нічого не знайдено за «${query}».`;
          } catch (err) {
            log.error({ err, query }, 'search_catalog failed (stall recovery)');
            toolResultContent =
              '[search_catalog] ПОМИЛКА: каталог тимчасово недоступний.';
          }
        }
        recordTurnTool(debug, 'search_catalog', recoverySearchCatalog.args, toolResultContent);

        const afterSearch = await askTurnClaudeFollowUp(
          {
            conversationHistory: [
              ...history,
              { role: 'user' as const, content: enrichedMessageText },
              {
                role: 'assistant' as const,
                content: recovery.text || `[Шукаю в каталозі: ${query}]`,
              },
            ],
            userMessage: toolResultContent,
            tools,
          },
          {
            channel: conversation.channel,
            conversationId,
            clientId: client.id,
            model: agentCfg.claudeModel,
          },
        );
        responseText = afterSearch.text;
        agentFallback = afterSearch.fallback ?? agentFallback;
        if (afterSearch.errorDetail) agentErrorDetail = afterSearch.errorDetail;
        if (afterSearch.toolCalls?.length) {
          await runSideEffectToolCalls(
            afterSearch.toolCalls,
            client.id,
            conversationId,
            mediaAttachments,
            debug,
          );
          if (
            await tryTerminalToolCalls(afterSearch.toolCalls, {
              conversationId,
              client,
              agentMode: agentCfg.mode,
              clientMessage: stripMarkdownForInstagram(afterSearch.text),
              turnStartedAt,
              turnDebug: debug,
            })
          ) {
            return 'completed';
          }
        }
      } else if (recoverySlotsCall && canGetSlots) {
        const slotsResult = await executeGetAvailableSlotsTool({
          args: recoverySlotsCall.args,
          branchCrmExternalId: conversation.branch?.crmExternalId,
        });
        recordTurnTool(debug, 'get_available_slots', recoverySlotsCall.args, slotsResult);
        const afterSlots = await askTurnClaudeFollowUp(
          {
            conversationHistory: [
              ...history,
              { role: 'user' as const, content: enrichedMessageText },
              { role: 'assistant' as const, content: recovery.text || '[Перевіряю слоти]' },
            ],
            userMessage: slotsResult,
            tools,
          },
          {
            channel: conversation.channel,
            conversationId,
            clientId: client.id,
            model: agentCfg.claudeModel,
          },
        );
        responseText = afterSlots.text;
        agentFallback = afterSlots.fallback ?? agentFallback;
        if (afterSlots.errorDetail) agentErrorDetail = afterSlots.errorDetail;
      }
    }
  }

  // Recover when the client corrects the service and the model insists without re-search.
  const searchExecutedThisTurn = debug.tools.some((t) => t.name === 'search_services');
  if (
    !agentFallback &&
    canSearchServices &&
    !searchExecutedThisTurn &&
    !debug.stallRecovery &&
    looksLikeServiceCorrection(messageText)
  ) {
    const nudge = buildServiceCorrectionNudge(messageText);
    log.warn(
      { conversationId, clientPreview: messageText.slice(0, 160) },
      'Service correction without search_services — forcing recovery',
    );
    debug.stallRecovery = true;

    const recovery = await askTurnClaudeFollowUp(
      {
        conversationHistory: [
          ...history,
          { role: 'user' as const, content: enrichedMessageText },
          { role: 'assistant' as const, content: responseText },
        ],
        userMessage: nudge,
        tools,
      },
      {
        channel: conversation.channel,
        conversationId,
        clientId: client.id,
        model: agentCfg.claudeModel,
      },
    );

    responseText = recovery.text;
    agentFallback = recovery.fallback ?? agentFallback;
    if (recovery.errorDetail) agentErrorDetail = recovery.errorDetail;
    recordTurnRound(debug, {
      label: 'service_correction_recovery',
      toolCalls: (recovery.toolCalls ?? []).map((tc) => tc.name),
      textPreview: recovery.text,
      fallback: recovery.fallback ?? null,
    });

    const recoverySearch = recovery.toolCalls?.find((tc) => tc.name === 'search_services');
    if (recoverySearch) {
      await runSideEffectToolCalls(recovery.toolCalls ?? [], client.id, conversationId, mediaAttachments, debug);
      if (
        await tryTerminalToolCalls(recovery.toolCalls ?? [], {
          conversationId,
          client,
          agentMode: agentCfg.mode,
          clientMessage: stripMarkdownForInstagram(recovery.text),
          turnStartedAt,
          turnDebug: debug,
        })
      ) {
        return 'completed';
      }

      const q =
        typeof recoverySearch.args.query === 'string' ? recoverySearch.args.query.trim() : '';
      let searchResult: string;
      if (!q) {
        searchResult = '[search_services] ПОМИЛКА: порожній запит';
      } else {
        try {
          const found = await searchServicesWithFallback(q, parseSearchServicesLimit(recoverySearch.args), {
            clientMessage: messageText,
          });
          searchResult = formatSearchServicesToolResult({
            query: q,
            matchCount: found.matchCount,
            contextBlock: found.contextBlock,
            usedQuery: found.usedQuery,
            broadenedFrom: found.broadenedFrom,
            intentNote: found.intentNote,
          });
        } catch (err) {
          log.error({ err, query: q }, 'search_services failed (service correction recovery)');
          searchResult = '[search_services] ПОМИЛКА: CRM тимчасово недоступна.';
        }
      }
      recordTurnTool(debug, 'search_services', recoverySearch.args, searchResult);

      const afterSearch = await askTurnClaudeFollowUp(
        {
          conversationHistory: [
            ...history,
            { role: 'user' as const, content: enrichedMessageText },
            { role: 'assistant' as const, content: recovery.text || '[Шукаю послуги]' },
          ],
          userMessage: searchResult,
          tools,
        },
        {
          channel: conversation.channel,
          conversationId,
          clientId: client.id,
          model: agentCfg.claudeModel,
        },
      );
      responseText = afterSearch.text;
      agentFallback = afterSearch.fallback ?? agentFallback;
      if (afterSearch.errorDetail) agentErrorDetail = afterSearch.errorDetail;
      recordTurnRound(debug, {
        label: 'after_service_correction_search',
        toolCalls: (afterSearch.toolCalls ?? []).map((tc) => tc.name),
        textPreview: afterSearch.text,
        fallback: afterSearch.fallback ?? null,
      });
    }
  }

  // Recover once when the model claimed a booking without book_appointment.
  const canBookAppointment = tools.some((t) => t.name === 'book_appointment');
  const bookSucceeded = debug.tools.some(
    (t) => t.name === 'book_appointment' && /\[book_appointment\]\s*ok\b/i.test(t.resultPreview),
  );

  if (
    !agentFallback &&
    agentCfg.mode === 'booking' &&
    canBookAppointment &&
    !bookSucceeded &&
    !debug.falseBookingRecovery &&
    looksLikeBookingConfirmation(responseText)
  ) {
    const nudge = buildFalseBookingConfirmNudge();
    log.warn(
      { conversationId, stallPreview: responseText.slice(0, 200) },
      'False booking confirmation without book_appointment — forcing recovery',
    );
    debug.falseBookingRecovery = true;

    const recovery = await askTurnClaudeFollowUp(
      {
        conversationHistory: [
          ...history,
          { role: 'user' as const, content: enrichedMessageText },
          { role: 'assistant' as const, content: responseText },
        ],
        userMessage: nudge,
        tools,
      },
      {
        channel: conversation.channel,
        conversationId,
        clientId: client.id,
        model: agentCfg.claudeModel,
      },
    );

    responseText = recovery.text;
    agentFallback = recovery.fallback ?? agentFallback;
    if (recovery.errorDetail) agentErrorDetail = recovery.errorDetail;
    recordTurnRound(debug, {
      label: 'false_booking_confirm_recovery',
      toolCalls: (recovery.toolCalls ?? []).map((tc) => tc.name),
      textPreview: recovery.text,
      fallback: recovery.fallback ?? null,
    });

    if (recovery.toolCalls?.length) {
      await runSideEffectToolCalls(recovery.toolCalls, client.id, conversationId, mediaAttachments, debug);
      if (
        await tryTerminalToolCalls(recovery.toolCalls, {
          conversationId,
          client,
          agentMode: agentCfg.mode,
          clientMessage: stripMarkdownForInstagram(recovery.text),
          turnStartedAt,
          turnDebug: debug,
        })
      ) {
        return 'completed';
      }
    }

    const bookedAfterRecovery = debug.tools.some(
      (t) => t.name === 'book_appointment' && /\[book_appointment\]\s*ok\b/i.test(t.resultPreview),
    );
    if (
      !bookedAfterRecovery &&
      looksLikeBookingConfirmation(responseText)
    ) {
      responseText = sanitizeFalseBookingConfirmReply(responseText);
      log.warn(
        { conversationId, sanitizedPreview: responseText.slice(0, 200) },
        'False booking confirmation still present after recovery — sanitized outbound',
      );
    }
  }

  // ── 10. Validate output (customer-facing gate) ─────────────────────

  let outputValidationFailure = false;
  // Single contract: scrub meta/JSON/IDs; replace only when nothing client-facing remains.
  const gated = gateCustomerFacingReply(responseText);
  let clientFacingText = stripMarkdownForInstagram(gated.text);

  // Localize canned busy/timeout for the customer's preferred language.
  if (
    agentFallback &&
    (agentFallback === 'busy' || agentFallback === 'timeout') &&
    CUSTOMER_CHANNELS.has(conversation.channel)
  ) {
    const lang =
      normalizeClientLanguage(client.preferredLanguage) ??
      detectClientLanguage(messageText) ??
      'uk';
    clientFacingText = resolveCustomerFallback(
      agentFallback,
      lang,
      agentCfg.fallbackMessages,
    );
  }

  debug.gateReason = gated.reason;
  debug.redactedInternals = gated.redactedInternals;
  debug.agentFallback = agentFallback ?? null;
  debug.finalReplyPreview = clientFacingText;
  if (gated.redactedInternals && !gated.rejected) {
    log.info(
      {
        conversationId,
        originalChars: responseText.length,
        clientChars: clientFacingText.length,
      },
      'Redacted internal IDs from bot reply — sending scrubbed text',
    );
  }
  if (gated.rejected) {
    outputValidationFailure = true;
    log.warn(
      {
        conversationId,
        gateReason: gated.reason,
        originalChars: responseText.length,
        clientMessage: messageText.slice(0, 200),
        agentTextPreview: responseText.slice(0, 500),
      },
      'Bot reply rejected by customer-facing gate — using safe fallback',
    );
  }

  if (!(await isBotTurnStillValid(conversationId, turnStartedAt))) {
    log.info({ conversationId }, 'Bot outbound aborted — manager took over during turn');
    return 'skipped';
  }

  // After several consecutive agent fallbacks, escalate to a live manager.
  if (
    agentFallback &&
    CUSTOMER_CHANNELS.has(conversation.channel)
  ) {
    const priorFallbacks = await countConsecutiveBotFallbacks(conversationId);
    if (shouldHandoffAfterAgentFallback(priorFallbacks)) {
      const failureDetail = formatBotFailureDetail({
        code: agentFallback,
        errorDetail: agentErrorDetail,
        clientMessage: messageText,
      });
      log.warn(
        {
          event: 'bot_fallback_handoff',
          conversationId,
          clientId: client.id,
          priorFallbacks,
          agentFallback,
          errorDetail: agentErrorDetail ?? null,
          clientMessage: messageText.slice(0, 300),
          failureDetail,
        },
        'Agent fallback limit reached — handing off to manager',
      );
      if (localPaths.length > 0) {
        await persistVisionDebugNote({
          conversationId,
          localPaths,
          firstClaudeText,
          finalBotText: clientFacingText,
          agentFallback,
          catalogDebug,
          agentMode: agentCfg.mode,
          clientMessage: messageText,
        }).catch((err) =>
          log.warn({ err, conversationId }, 'persistVisionDebugNote failed (non-fatal)'),
        );
      }
      notifyAgentFailure({
        conversationId,
        clientIgUserId: client.igUserId,
        failureCode: agentFallback,
        failureDetail,
        clientMessage: messageText,
      }).catch((err) =>
        log.warn({ err, conversationId }, 'notifyAgentFailure failed (non-fatal)'),
      );
      await performManagerHandoff({
        conversationId,
        client,
        reason: `Агент не зміг обробити запит після ${priorFallbacks + 1} спроб. ${failureDetail}`,
        turnStartedAt,
      });
      return 'completed';
    }
  }

  // Safety net: bot wrote a full order summary but omitted collect_order.
  if (agentCfg.mode === 'sales' && client.igUserId) {
    const parsedSummary = parseOrderSummaryFromText(clientFacingText);
    if (parsedSummary) {
      const orderId = await handleCollectOrder(
        conversationId,
        client.id,
        client.igUserId,
        { ...parsedSummary } as Record<string, unknown>,
        { skipClientMessage: true },
      );
      if (orderId) {
        log.info({ conversationId, orderId }, 'Order created from bot confirmation summary (fallback)');
      }
    }
  }

  // ── 11. Send response ─────────────────────────────────────────────
  let botFailureCode: BotFailureCode | null = null;
  let botFailureDetail: string | null = null;
  let suppressCustomerSend = false;

  if (outputValidationFailure) {
    botFailureCode = 'output_validation';
    botFailureDetail = formatBotFailureDetail({
      code: 'output_validation',
      clientMessage: messageText,
      agentText: responseText,
      gateReason: gated.reason,
    });
  } else if (
    agentFallback &&
    isCustomerVisibleFallbackReply(clientFacingText, agentCfg.fallbackMessages)
  ) {
    botFailureCode = agentFallback;
    botFailureDetail = formatBotFailureDetail({
      code: agentFallback,
      errorDetail: agentErrorDetail,
      clientMessage: messageText,
      agentText: responseText,
    });
  }

  // Retries after 429/timeout: keep trying Claude, but do not spam the same
  // canned "manager will reply" line to the customer again for this inbound.
  if (
    CUSTOMER_CHANNELS.has(conversation.channel) &&
    isCustomerVisibleFallbackReply(clientFacingText, agentCfg.fallbackMessages)
  ) {
    const lastInbound = await prisma.message.findFirst({
      where: { conversationId, direction: 'in', sender: 'client' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (lastInbound) {
      const priorBotOuts = await prisma.message.findMany({
        where: {
          conversationId,
          direction: 'out',
          sender: 'bot',
          createdAt: { gt: lastInbound.createdAt },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { text: true },
      });
      if (
        shouldSuppressDuplicateCustomerFallback({
          candidateText: clientFacingText,
          botOutboundsAfterInboundNewestFirst: priorBotOuts.map((m) => m.text ?? ''),
          messages: agentCfg.fallbackMessages,
        })
      ) {
        suppressCustomerSend = true;
        clientFacingText = AGENT_FALLBACK_RETRY_NOTE;
        // Stop typing immediately — no customer message will clear it via sendText.
        await igTyping.end();
        log.warn(
          {
            event: 'bot_fallback_suppressed',
            conversationId,
            clientId: client.id,
            botFailureCode,
            errorDetail: agentErrorDetail ?? null,
            botFailureDetail,
            clientMessage: messageText.slice(0, 300),
          },
          'Suppressed duplicate canned fallback — customer already notified',
        );
      }
    }
  }

  if (!suppressCustomerSend) {
    if (outputValidationFailure) {
      log.warn(
        {
          event: 'bot_fallback_sent',
          conversationId,
          clientId: client.id,
          botFailureCode,
          botFailureDetail,
          clientMessage: messageText.slice(0, 300),
        },
        'Bot sent safe replacement after output validation failure',
      );
    } else if (botFailureCode && botFailureCode !== 'output_validation') {
      log.warn(
        {
          event: 'bot_fallback_sent',
          conversationId,
          clientId: client.id,
          botFailureCode,
          errorDetail: agentErrorDetail ?? null,
          botFailureDetail,
          clientMessage: messageText.slice(0, 300),
          fallbackText: clientFacingText,
        },
        'Bot sent canned fallback reply to client',
      );
    }

    try {
      await sendText(client.igUserId, clientFacingText);
    } catch (err) {
      log.error({ err, conversationId }, 'Failed to send bot response to Instagram');
      // Still persist the message even if delivery failed
    }
  }

  // ── 12. Persist bot message (same text as sent to IG — or admin retry note) ──
  await prisma.message.create({
    data: {
      conversationId,
      direction: 'out',
      sender: 'bot',
      text: clientFacingText,
      botFailureCode,
      botFailureDetail,
    },
  });
  markFirstOutboundAt(conversationId).catch((err) =>
    log.warn({ err, conversationId }, 'markFirstOutboundAt failed (non-fatal)'),
  );

  if (botFailureCode && botFailureDetail && CUSTOMER_CHANNELS.has(conversation.channel)) {
    notifyAgentFailure({
      conversationId,
      clientIgUserId: client.igUserId,
      failureCode: botFailureCode,
      failureDetail: botFailureDetail,
      clientMessage: messageText,
    }).catch((err) =>
      log.warn({ err, conversationId }, 'notifyAgentFailure failed (non-fatal)'),
    );
  } else if (!isAgentFallbackReply(clientFacingText, agentCfg.fallbackMessages)) {
    // Schedule silence remarketing — Claude runs only when runAt is due.
    scheduleFollowUpAfterBotOutboundSafe(conversationId);
  }

  // Admin-only vision/CRM debug note (not sent to Instagram).
  if (localPaths.length > 0) {
    await persistVisionDebugNote({
      conversationId,
      localPaths,
      firstClaudeText,
      finalBotText: clientFacingText,
      agentFallback,
      catalogDebug,
      agentMode: agentCfg.mode,
      clientMessage: messageText,
    }).catch((err) =>
      log.warn({ err, conversationId }, 'persistVisionDebugNote failed (non-fatal)'),
    );
  }

  log.info(
    { conversationId, responseLength: clientFacingText.length },
    'Bot response sent and persisted',
  );
  return 'completed';
  } finally {
    const debugSnapshot = turnDebug;
    if (debugSnapshot && shouldPersistAgentTurnDebug(debugSnapshot)) {
      const note = formatAgentTurnDebugNote(debugSnapshot, {
        durationMs: Date.now() - turnStartedMs,
      });
      await prisma.message
        .create({
          data: {
            conversationId,
            direction: 'system',
            sender: 'system',
            text: note,
          },
        })
        .then(() => {
          log.info(
            {
              conversationId,
              tools: debugSnapshot.tools.length,
              rounds: debugSnapshot.rounds.length,
              stallRecovery: debugSnapshot.stallRecovery,
            },
            'Agent turn debug system note persisted',
          );
        })
        .catch((err) =>
          log.warn({ err, conversationId }, 'persistAgentTurnDebugNote failed (non-fatal)'),
        );
    }
    await igTyping.end();
  }
}

async function persistVisionDebugNote(params: {
  conversationId: string;
  localPaths: string[];
  firstClaudeText: string;
  finalBotText: string;
  agentFallback?: ClaudeResponse['fallback'];
  catalogDebug: CatalogDebugMatch | null;
  agentMode: AgentMode;
  clientMessage: string;
}): Promise<void> {
  const {
    conversationId,
    localPaths,
    firstClaudeText,
    finalBotText,
    agentFallback,
    agentMode,
    clientMessage,
  } = params;
  let { catalogDebug } = params;

  const imagePaths = localPaths.filter(isClaudeVisionImagePath);
  const imageCount = imagePaths.length > 0 ? imagePaths.length : localPaths.length;
  const skippedNonImageCount = localPaths.length - imagePaths.length;

  let interpretation = extractVisionInterpretation(
    agentFallback ? null : firstClaudeText || finalBotText,
  );
  if (agentFallback) {
    interpretation = `Claude не зміг завершити аналіз (${agentFallback})`;
  }

  // If Claude never called search_catalog on a sales vision turn, run a
  // diagnostic lookup for the admin note only (does not change the client reply).
  if (!catalogDebug && agentMode === 'sales' && !agentFallback) {
    const seed =
      extractKeywordsFromCaption(clientMessage) ||
      extractKeywordsFromCaption(firstClaudeText || finalBotText);
    if (seed) {
      try {
        const { contextBlock, matchCount } = await searchActiveProductsForContext(seed);
        catalogDebug = {
          query: seed,
          matchCount,
          contextBlock,
          source: 'diagnostic',
        };
      } catch (err) {
        log.warn({ err, seed, conversationId }, 'Diagnostic catalog search for vision note failed');
      }
    }
  }

  const note = formatVisionDebugNote({
    imageCount,
    interpretation,
    catalog: catalogDebug,
    skippedNonImageCount: skippedNonImageCount > 0 ? skippedNonImageCount : undefined,
  });

  await prisma.message.create({
    data: {
      conversationId,
      direction: 'system',
      sender: 'system',
      text: note,
    },
  });

  log.info(
    {
      conversationId,
      imageCount,
      catalogMatches: catalogDebug?.matchCount ?? 0,
      catalogSource: catalogDebug?.source ?? null,
    },
    'Vision debug system note persisted',
  );
}

// ---------------------------------------------------------------------------
// Tool call dispatch helpers
// ---------------------------------------------------------------------------

type TerminalToolContext = {
  conversationId: string;
  client: {
    id: string;
    igUserId: string | null;
    displayName?: string | null;
    phone?: string | null;
    igUsername?: string | null;
  };
  agentMode: AgentMode;
  /** Bot reply shown to the client — used as the order confirmation when collect_order fires. */
  clientMessage?: string;
  turnStartedAt: Date;
  turnDebug?: AgentTurnDebugCollector | null;
};

/** Fire-and-forget profile / intent writes — never ends the conversation turn. */
async function runSideEffectToolCalls(
  toolCalls: { name: string; args: Record<string, unknown> }[],
  clientId: string,
  conversationId: string,
  mediaAttachments?: StoredMediaAttachment[],
  turnDebug?: AgentTurnDebugCollector | null,
): Promise<void> {
  const updateInfo = toolCalls.find((tc) => tc.name === 'update_client_info');
  if (updateInfo) {
    if (turnDebug) {
      recordTurnTool(turnDebug, 'update_client_info', updateInfo.args, '[update_client_info] queued');
    }
    const extractedCustomFields: Record<string, unknown> =
      typeof updateInfo.args.custom_fields === 'object' &&
      updateInfo.args.custom_fields !== null &&
      !Array.isArray(updateInfo.args.custom_fields)
        ? (updateInfo.args.custom_fields as Record<string, unknown>)
        : {};

    handleUpdateClientInfo(clientId, updateInfo.args)
      .then(() => mirrorClientToCrm(clientId, extractedCustomFields))
      .catch((err) => {
        log.error({ err, conversationId, clientId }, 'Failed to save/mirror client info');
      });
  }

  const tagClient = toolCalls.find((tc) => tc.name === 'tag_client');
  if (tagClient) {
    if (turnDebug) {
      recordTurnTool(turnDebug, 'tag_client', tagClient.args, '[tag_client] queued');
    }
    handleTagClient(clientId, tagClient.args).catch((err) => {
      log.error({ err, conversationId, clientId }, 'Failed to tag client');
    });
  }

  const classifyIntent = toolCalls.find((tc) => tc.name === 'classify_intent');
  if (classifyIntent) {
    if (turnDebug) {
      recordTurnTool(turnDebug, 'classify_intent', classifyIntent.args, '[classify_intent] queued');
    }
    handleClassifyIntent(conversationId, classifyIntent.args).catch((err) => {
      log.error({ err, conversationId }, 'Failed to classify intent');
    });
  }

  const setBranch = toolCalls.find((tc) => tc.name === 'set_conversation_branch');
  if (setBranch) {
    if (turnDebug) {
      recordTurnTool(
        turnDebug,
        'set_conversation_branch',
        setBranch.args,
        '[set_conversation_branch] queued',
      );
    }
    handleSetConversationBranch(conversationId, setBranch.args).catch((err) => {
      log.error({ err, conversationId }, 'Failed to set conversation branch');
    });
  }

  const attachPhoto = toolCalls.find((tc) => tc.name === 'attach_reference_photo');
  if (attachPhoto) {
    if (turnDebug) {
      recordTurnTool(
        turnDebug,
        'attach_reference_photo',
        attachPhoto.args,
        '[attach_reference_photo] queued',
      );
    }
    handleAttachReferencePhoto(clientId, conversationId, attachPhoto.args, mediaAttachments).catch(
      (err) => {
        log.error({ err, conversationId, clientId }, 'Failed to attach reference photo');
      },
    );
  }
}

/** Handoff / collect_order / create_local_order / book_appointment — ends the turn when handled. */
async function tryTerminalToolCalls(
  toolCalls: { name: string; args: Record<string, unknown> }[],
  ctx: TerminalToolContext,
): Promise<boolean> {
  const { conversationId, client, agentMode, turnStartedAt, turnDebug } = ctx;

  if (!(await isBotTurnStillValid(conversationId, turnStartedAt))) {
    log.info({ conversationId }, 'Terminal tool calls skipped — manager took over');
    return true;
  }

  const handoff = toolCalls.find((tc) => tc.name === 'request_handoff');
  if (handoff) {
    if (turnDebug) {
      recordTurnTool(turnDebug, 'request_handoff', handoff.args, '[request_handoff] handled');
    }
    const reason =
      typeof handoff.args.reason === 'string'
        ? handoff.args.reason
        : 'Клієнт потребує менеджера';

    await performManagerHandoff({
      conversationId,
      client,
      reason,
      turnStartedAt,
    });
    return true;
  }

  const createLocal = toolCalls.find((tc) => tc.name === 'create_local_order');
  if (createLocal && client.igUserId) {
    if (turnDebug) {
      recordTurnTool(turnDebug, 'create_local_order', createLocal.args, '[create_local_order] …');
    }
    const orderId = await handleCreateLocalOrder(
      conversationId,
      client.id,
      client.igUserId,
      createLocal.args,
      {
        clientMessage: ctx.clientMessage,
        clientDisplayName: client.displayName,
        clientPhone: client.phone,
        clientIgUsername: client.igUsername,
      },
    );
    if (orderId) {
      if (turnDebug) {
        const last = turnDebug.tools[turnDebug.tools.length - 1];
        if (last?.name === 'create_local_order') {
          last.resultPreview = `[create_local_order] ok id=${orderId}`;
        }
      }
      return true;
    }
  }

  const collectOrder = toolCalls.find((tc) => tc.name === 'collect_order');
  if (collectOrder && agentMode === 'sales' && client.igUserId) {
    if (turnDebug) {
      recordTurnTool(turnDebug, 'collect_order', collectOrder.args, '[collect_order] …');
    }
    const orderId = await handleCollectOrder(
      conversationId,
      client.id,
      client.igUserId,
      collectOrder.args,
      { clientMessage: ctx.clientMessage },
    );
    if (orderId) {
      if (turnDebug) {
        const last = turnDebug.tools[turnDebug.tools.length - 1];
        if (last?.name === 'collect_order') {
          last.resultPreview = `[collect_order] ok id=${orderId}`;
        }
      }
      return true;
    }
  }

  const bookAppointment = toolCalls.find((tc) => tc.name === 'book_appointment');
  if (bookAppointment && agentMode === 'booking' && client.igUserId) {
    if (turnDebug) {
      recordTurnTool(turnDebug, 'book_appointment', bookAppointment.args, '[book_appointment] …');
    }
    const bookResult = await handleBookAppointment(
      conversationId,
      client.id,
      bookAppointment.args,
      {
        clientIgUserId: client.igUserId,
        clientMessage: ctx.clientMessage,
        // Confirmation sent only after CRM sync inside handleBookAppointment.
      },
    );
    if (turnDebug) {
      const last = turnDebug.tools[turnDebug.tools.length - 1];
      if (last?.name === 'book_appointment') {
        last.resultPreview = bookResult?.toolResult
          ?? '[book_appointment] failed (no CRM location or missing fields)';
      }
    }
    if (bookResult?.crmSynced) {
      return true;
    }
    if (bookResult && !bookResult.crmSynced) {
      // CRM rejected (e.g. TIME_CONFLICT) — do not leave the agent's false «Записали» as the reply.
      // handleBookAppointment skipped IG confirm; send alternatives instead.
      const reply = bookResult.toolResult.includes('TIME_CONFLICT')
        ? buildClientFacingTimeConflictReply(bookResult.toolResult)
        : sanitizeFalseBookingConfirmReply(ctx.clientMessage ?? '') ||
          'На жаль, зараз не вдалося закріпити цей час у розкладі. Підкажіть інший зручний слот — перевіримо наявність.';
      try {
        await sendText(client.igUserId, reply);
        await prisma.message.create({
          data: {
            conversationId,
            direction: 'out',
            sender: 'bot',
            text: reply,
          },
        });
        markFirstOutboundAt(conversationId).catch(() => undefined);
      } catch (err) {
        log.error({ err, conversationId }, 'Failed to send TIME_CONFLICT client reply');
      }
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

/**
 * Persists customer contact / delivery data extracted by Claude.
 *
 * Called when Claude fires the `update_client_info` tool.
 * Only updates fields that are present in `args` - partial updates are safe.
 *
 * Claude calls this mid-conversation as soon as the client mentions any
 * personal data (name, phone, city, NP branch) - not just at order time.
 * This way we build the profile incrementally and never ask again next session.
 */
async function handleUpdateClientInfo(
  clientId: string,
  args: Record<string, unknown>,
): Promise<void> {
  // Build a partial update - only set fields that Claude actually provided
  const update: Record<string, string> = {};

  if (typeof args.full_name === 'string' && args.full_name.trim()) {
    update.displayName = args.full_name.trim();
  }
  if (typeof args.phone === 'string' && args.phone.trim()) {
    // Normalise: strip all non-digit chars except leading +
    update.phone = args.phone.trim().replace(/(?!^\+)\D/g, '');
  }
  if (typeof args.city === 'string' && args.city.trim()) {
    update.deliveryCity = args.city.trim();
  }
  if (typeof args.np_branch === 'string' && args.np_branch.trim()) {
    update.deliveryNpBranch = args.np_branch.trim();
  }
  if (typeof args.np_type === 'string' && ['warehouse', 'postamat'].includes(args.np_type)) {
    update.deliveryNpType = args.np_type;
  }
  if (typeof args.email === 'string' && args.email.trim()) {
    update.email = args.email.trim().toLowerCase();
  }

  if (Object.keys(update).length === 0) {
    log.debug({ clientId }, 'update_client_info called with no usable fields - skipping DB write');
    return;
  }

  await prisma.client.update({
    where: { id: clientId },
    data: update,
  });

  log.info({ clientId, fields: Object.keys(update) }, 'Client profile updated from conversation');
}

/**
 * Appends tags and optional notes to a client profile.
 * Called when Claude fires the `tag_client` tool.
 * Tags are merged (deduplicated) with existing ones - never overwritten.
 */
async function handleTagClient(
  clientId: string,
  args: Record<string, unknown>,
): Promise<void> {
  const newTags = Array.isArray(args.tags)
    ? args.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim().toLowerCase())
    : [];

  const notes = typeof args.notes === 'string' && args.notes.trim()
    ? args.notes.trim()
    : null;

  if (newTags.length === 0 && !notes) {
    log.debug({ clientId }, 'tag_client called with no usable data - skipping');
    return;
  }

  // Fetch current tags to merge (dedup)
  const current = await prisma.client.findUnique({
    where: { id: clientId },
    select: { tags: true },
  });

  const existingTags = current?.tags ?? [];
  const mergedTags = Array.from(new Set([...existingTags, ...newTags]));

  const update: Record<string, unknown> = { tags: mergedTags };
  if (notes) update.notes = notes;

  await prisma.client.update({
    where: { id: clientId },
    data: update,
  });

  log.info({ clientId, tags: mergedTags, hasNotes: !!notes }, 'Client tagged from conversation');
}

async function handleSetConversationBranch(
  conversationId: string,
  args: Record<string, unknown>,
): Promise<void> {
  const slug =
    typeof args.branch_slug === 'string' ? args.branch_slug.trim().toLowerCase() : '';
  if (!slug) return;

  const branch = await resolveBranchSlug(slug);
  if (!branch) {
    log.warn({ conversationId, slug }, 'set_conversation_branch: unknown or inactive slug');
    return;
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { branchId: branch.id },
  });

  log.info({ conversationId, branchId: branch.id, slug }, 'Conversation branch set');
}

async function handleAttachReferencePhoto(
  clientId: string,
  conversationId: string,
  args: Record<string, unknown>,
  mediaAttachments?: StoredMediaAttachment[],
): Promise<void> {
  let storageKey =
    typeof args.storage_key === 'string' && args.storage_key.trim()
      ? args.storage_key.trim()
      : undefined;

  if (!storageKey && mediaAttachments?.length) {
    const visual = mediaAttachments.find(
      (a) => a.status === 'ready' && a.storageKey && (a.kind === 'image' || a.kind === 'video'),
    );
    storageKey = visual?.storageKey;
  }

  if (!storageKey) {
    log.debug({ conversationId }, 'attach_reference_photo: no storage key available');
    return;
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { branchId: true },
  });

  await saveClientReferencePhoto({
    clientId,
    conversationId,
    branchId: conversation?.branchId ?? undefined,
    sourceStorageKey: storageKey,
    note: typeof args.note === 'string' ? args.note : undefined,
  });
}

// ---------------------------------------------------------------------------
// Returning-lead recap (B.3)
// ---------------------------------------------------------------------------

/**
 * Loads the most recent finalized brief for this client (from an earlier
 * session) and renders it as a short human-readable recap for the prompt.
 *
 * Returns undefined when there is no usable prior brief — either because
 * there are none, or the freshest one fails the quality / age gates.
 *
 * Gates (FEATURE_AGENT_MODE_PLAN R6):
 *   - Must belong to a *different* conversation (this is the returning-
 *     lead case, not the same-session echo).
 *   - Status in (submitted, synced) — drafts / failed don't count.
 *   - Quality gate: prefer `Conversation.briefQuality ≥ 3` (B.2 — manager
 *     rating). If unrated yet, fall back to `completenessPct ≥ 60` as a
 *     crude proxy so the feature still works before every lead is rated.
 *   - Age ≤ sessionFreshnessDays × 3 — beyond that, the prior context
 *     is stale enough that the agent should re-qualify from scratch.
 */
async function loadPreviousBriefSummary(
  clientId: string,
  currentConversationId: string,
  sessionFreshnessDays: number,
): Promise<string | undefined> {
  const maxAgeMs = sessionFreshnessDays * 3 * 86400000;
  const cutoff = new Date(Date.now() - maxAgeMs);

  const brief = await prisma.presaleBrief.findFirst({
    where: {
      clientId,
      conversationId: { not: currentConversationId },
      status: { in: ['submitted', 'synced'] },
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      businessName: true,
      niche: true,
      services: true,
      budgetRange: true,
      desiredStart: true,
      preferredChannel: true,
      priority: true,
      completenessPct: true,
      createdAt: true,
      conversation: { select: { briefQuality: true } },
    },
  });

  if (!brief) return undefined;

  const rated = brief.conversation?.briefQuality ?? null;
  if (rated !== null) {
    if (rated < 3) return undefined;
  } else if ((brief.completenessPct ?? 0) < 60) {
    return undefined;
  }

  const parts: string[] = [];
  if (brief.businessName) parts.push(`Бізнес: ${brief.businessName}`);
  if (brief.niche) parts.push(`Ніша: ${brief.niche}`);
  if (brief.services && brief.services.length > 0) {
    parts.push(`Послуги: ${brief.services.slice(0, 4).join(', ')}`);
  }
  if (brief.budgetRange) parts.push(`Бюджет: ${brief.budgetRange}`);
  if (brief.desiredStart) parts.push(`Старт: ${brief.desiredStart}`);
  if (brief.preferredChannel) parts.push(`Зручний канал: ${brief.preferredChannel}`);
  if (brief.priority) parts.push(`Пріоритет: ${brief.priority}`);

  if (parts.length === 0) return undefined;

  const ageDays = Math.round((Date.now() - brief.createdAt.getTime()) / 86400000);
  parts.unshift(`Попередній бриф (~${ageDays} дн. тому):`);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Shared post helpers
// ---------------------------------------------------------------------------

/**
 * Builds a Ukrainian-language header describing the shared post.
 * Injected at the top of the enriched user message so Claude understands
 * the context before seeing availability data and the attached image.
 */
function buildSharedPostHeader(post: SharedPostData): string {
  const parts: string[] = ['[Клієнт поділився публікацією з Instagram]'];

  if (post.caption) {
    // Truncate very long captions - we only need the descriptive part
    const truncated = post.caption.length > 200
      ? post.caption.slice(0, 200) + '...'
      : post.caption;
    parts.push(`Пiдпис публiкацiї: "${truncated}"`);
  }

  if (post.postUrl) {
    parts.push(`Посилання: ${post.postUrl}`);
  }

  // Explicit identification task for Claude (vision + catalog matching)
  parts.push(
    'Завдання:\n' +
    '1) Визнач ТИП ВИРОБУ з зображення/пiдпису (худi / футболка / лонгслiв / свiтшот / сорочка / кепка).\n' +
    '2) Визнач КОЛIР виробу.\n' +
    '3) Визнач ПРИНТ або НАПИС на виробi (це окрема позицiя в CRM).\n' +
    '4) Знайди в каталозi нижче базовий виріб та принт окремо, порахуй загальну цiну.\n' +
    '5) Повiдом клiєнту: назва + цiна виробу + орiєнтовна цiна нанесення = загалом.\n' +
    '6) Запитай розмiр i надай розмiрну сiтку для цього типу виробу (є в системному промптi).',
  );

  return parts.join('\n');
}
