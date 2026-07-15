import pino from 'pino';
import { config } from '../config.js';
import { isCrmWriteEnabled } from '../lib/crm-write.js';
import { prisma } from '../lib/prisma.js';
import { askClaude } from './claude.js';
import { sendText } from './instagram.js';
import { beginIgTypingIndicator } from './ig-typing-indicator.js';
import {
  buildRuntimePrompt,
  getActivePrompt,
  getWorkingHours,
  isWithinWorkingHours,
  loadCatalogSnippet,
  type ClientProfile,
} from './prompt-builder.js';
import { resolveVisualMediaPathsForClaude } from './media.js';
import type { StoredMediaAttachment } from '../lib/media-attachments.js';
import { visualStorageKeys } from '../lib/media-attachments.js';
import { buildClaudeHistoryTurns } from '../lib/conversation-history.js';
import { formatHandoffMessageLine } from '../lib/handoff-format.js';
import { notifyHandoff } from './telegram-notify.js';
import { buildAgentTools, type AgentMode } from '../lib/tool-definitions.js';
import { getActiveCrmFieldMappings } from '../lib/crm-field-mappings.js';
import { getAgentConfig } from '../lib/agent-config.js';
import { formatBranchesForPrompt, resolveBranchSlug } from './branches.js';
import { handleBookAppointment } from './appointment.js';
import { saveClientReferencePhoto } from './reference-photos.js';
import {
  getAvailableSlotsForContext,
  searchServicesForContext,
} from './service-search.js';
import { handleCollectOrder } from './order.js';
import { parseOrderSummaryFromText } from '../lib/order-summary-detect.js';
import { isBotTurnStillValid } from '../lib/conversation-bot-guard.js';
import { autoReturnHandoffToBotIfExpired } from '../lib/handoff-auto-return.js';
import { getRuntimeConfig, isUsernameBotIgnored } from '../lib/runtime-config.js';
import { handleClassifyIntent, handleSubmitBrief } from './brief.js';
import { mirrorClientToCrm } from './crm-sync.js';
import { markFirstOutboundAt } from '../lib/conversation-metrics.js';
import {
  searchActiveProductsForContext,
  extractKeywordsFromCaption,
} from './product-search.js';
import { getDeliveryCost } from './nova-poshta.js';
import type { SharedPostData } from '../routes/webhooks.js';
import { stripMarkdownForInstagram } from '../lib/instagram-text.js';
import { dedupeConversationMessages } from '../lib/message-dedupe.js';
import { runConversationTurnSerialized } from '../lib/conversation-turn-queue.js';
import {
  countConsecutiveBotFallbacks,
  formatBotFailureDetail,
  isAgentFallbackReply,
  shouldHandoffAfterAgentFallback,
  type BotFailureCode,
} from '../lib/agent-fallback.js';
import type { ClaudeResponse } from './claude.js';

const log = pino({ name: 'conversation' });

/** Regex to detect leaked internal IDs / prices in bot output */
const LEAKED_INTERNALS_RE = /product_id|offer_id|purchased_price/i;

/** Max messages to include in Claude conversation history */
const MAX_HISTORY_MESSAGES = 30;

const CUSTOMER_CHANNELS = new Set(['ig', 'tg']);

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
 * Handles an incoming Instagram message for a conversation.
 *
 * Orchestrates the full flow: state check, working-hours gate,
 * prompt building, Claude invocation, tool-call handling, output
 * validation, and response delivery.
 *
 * @param conversationId  The DB conversation UUID.
 * @param messageText     Sanitized message text (may be empty for image-only messages).
 * @param mediaUrls         Storage keys for successfully downloaded media.
 * @param sharedPost        Parsed metadata if the user forwarded an IG post.
 * @param mediaAttachments  Structured attachment metadata (kind, playback status).
 * @param sourceIgMessageId Meta message id — excludes duplicate from Claude history.
 */
export function handleIncomingMessage(
  conversationId: string,
  messageText: string,
  mediaUrls?: string[],
  sharedPost?: SharedPostData,
  mediaAttachments?: StoredMediaAttachment[],
  sourceIgMessageId?: string,
): Promise<void> {
  return runConversationTurnSerialized(conversationId, () =>
    handleIncomingMessageImpl(
      conversationId,
      messageText,
      mediaUrls,
      sharedPost,
      mediaAttachments,
      sourceIgMessageId,
    ),
  );
}

async function handleIncomingMessageImpl(
  conversationId: string,
  messageText: string,
  mediaUrls?: string[],
  sharedPost?: SharedPostData,
  mediaAttachments?: StoredMediaAttachment[],
  sourceIgMessageId?: string,
): Promise<void> {
  // ── 1. Fetch conversation with client ─────────────────────────────
  let conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { client: true, branch: true },
  });

  if (!conversation) {
    log.error({ conversationId }, 'Conversation not found');
    return;
  }

  const { client } = conversation;

  if (!client.igUserId) {
    log.error({ conversationId, clientId: client.id }, 'Client has no igUserId');
    return;
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
  };

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
        return;
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
      return;
    }
  }

  // ── 3. Closed / paused - ignore ──────────────────────────────────
  if (conversation.state === 'closed' || conversation.state === 'paused') {
    log.debug(
      { conversationId, state: conversation.state },
      'Conversation closed or paused, ignoring',
    );
    return;
  }

  // ── 3.5 Tenant-wide bot ignore list ───────────────────────────────
  const runtime = await getRuntimeConfig();
  if (isUsernameBotIgnored(runtime, client.igUsername)) {
    log.info(
      { conversationId, igUsername: client.igUsername },
      'Username on bot ignore list — skipping bot response',
    );
    return;
  }

  const igTyping = await beginIgTypingIndicator({
    channel: conversation.channel,
    recipientId: client.igUserId,
  });

  try {
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
  const activePrompt = await getActivePrompt();
  const catalog = await loadCatalogSnippet();

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

  const agentCfg = await getAgentConfig();

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

  const prompt = buildRuntimePrompt({
    activePromptContent: activePrompt,
    catalogSnippet: catalog,
    currentTime: now,
    workingHours: hours,
    conversationState: conversation.state as 'bot' | 'handoff',
    clientIgUserId: client.igUserId,
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
    selectedBranch: conversation.branch
      ? {
          slug: conversation.branch.slug,
          displayName: conversation.branch.displayName,
          address: conversation.branch.address,
          crmExternalId: conversation.branch.crmExternalId,
        }
      : undefined,
  });

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
    excludeIgMessageId: sourceIgMessageId,
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
        const { contextBlock } = await searchActiveProductsForContext(keywords);
        availabilityBlock = contextBlock;
      } catch (err) {
        // Non-critical - Claude can still use the image to identify the product
        log.warn({ err, keywords }, 'Product availability search failed (non-fatal)');
      }
    }

    // Build the enriched user message that Claude will receive.
    // Structure: [shared post header] + [availability data if found] + [original text if any]
    const parts: string[] = [sharedPostHeader];
    if (availabilityBlock) {
      parts.push(availabilityBlock);
    }
    if (messageText.trim()) {
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
  } else if (!messageText.trim() && localPaths.length > 0) {
    // Image/video without caption — guide Claude to read product screenshots.
    enrichedMessageText =
      '[Клієнт надіслав зображення без тексту. Якщо це скрін/фото товару — прочитай назву, ціну, розмір/колір і допоможи оформити замовлення. Якщо відео не вклалось у vision — попроси фото або посилання.]';
  } else if (!messageText.trim() && localPaths.length === 0) {
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

  const response = await askClaude(
    {
      systemPrompt: prompt,
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

  if (response.toolCalls && response.toolCalls.length > 0) {
    await runSideEffectToolCalls(response.toolCalls, client.id, conversationId, mediaAttachments);

    if (
      await tryTerminalToolCalls(response.toolCalls, {
        conversationId,
        client,
        agentMode: agentCfg.mode,
        clientMessage: stripMarkdownForInstagram(response.text),
        turnStartedAt,
      })
    ) {
      return;
    }

    const handoff = response.toolCalls.find((tc) => tc.name === 'request_handoff');
    const collectOrder = response.toolCalls.find((tc) => tc.name === 'collect_order');
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

    if (searchCatalogCall && !handoff && !collectOrder && !deliveryCostCall) {
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

      const historyWithResult = [
        ...history,
        { role: 'user' as const, content: enrichedMessageText },
        {
          role: 'assistant' as const,
          content: response.text || `[Шукаю в каталозі: ${query}]`,
        },
      ];

      const response2 = await askClaude(
        {
          systemPrompt: prompt,
          conversationHistory: historyWithResult,
          userMessage: toolResultContent,
          tools,
        },
        {
          channel: conversation.channel,
          conversationId,
          clientId: client.id,
        },
      );

      responseText = response2.text;
      agentFallback = response2.fallback ?? agentFallback;
      if (response2.errorDetail) agentErrorDetail = response2.errorDetail;
      if (response2.toolCalls?.length) {
        await runSideEffectToolCalls(response2.toolCalls, client.id, conversationId, mediaAttachments);
        if (
          await tryTerminalToolCalls(response2.toolCalls, {
            conversationId,
            client,
            agentMode: agentCfg.mode,
            clientMessage: stripMarkdownForInstagram(response2.text),
            turnStartedAt,
          })
        ) {
          return;
        }
      }
      log.info({ conversationId, query }, 'Catalog search completed and Claude re-invoked');
    }

    // get_delivery_cost - query tool: fetch NP price, then re-invoke Claude with the result
    if (deliveryCostCall && !handoff && !collectOrder && !searchCatalogCall) {
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

      // Second Claude call: inject tool result so Claude can reply to the client
      const historyWithResult = [
        ...history,
        { role: 'user' as const, content: enrichedMessageText },
        { role: 'assistant' as const, content: response.text || `[Перевіряю вартість доставки до ${city}]` },
      ];

      const response2 = await askClaude(
        {
          systemPrompt: prompt,
          conversationHistory: historyWithResult,
          userMessage: toolResultContent,
          tools,
        },
        {
          channel: conversation.channel,
          conversationId,
          clientId: client.id,
        },
      );

      responseText = response2.text;
      agentFallback = response2.fallback ?? agentFallback;
      if (response2.errorDetail) agentErrorDetail = response2.errorDetail;
      if (response2.toolCalls?.length) {
        await runSideEffectToolCalls(response2.toolCalls, client.id, conversationId, mediaAttachments);
        if (
          await tryTerminalToolCalls(response2.toolCalls, {
            conversationId,
            client,
            agentMode: agentCfg.mode,
            clientMessage: stripMarkdownForInstagram(response2.text),
            turnStartedAt,
          })
        ) {
          return;
        }
      }
      log.info({ conversationId, city, toolResultContent }, 'Delivery cost fetched and Claude re-invoked');
    }

    const searchServicesCall = response.toolCalls.find((tc) => tc.name === 'search_services');
    const slotsCall = response.toolCalls.find((tc) => tc.name === 'get_available_slots');

    if (searchServicesCall && !handoff && !collectOrder && !bookAppointment) {
      const query =
        typeof searchServicesCall.args.query === 'string'
          ? searchServicesCall.args.query.trim()
          : '';
      let toolResultContent: string;
      if (!query) {
        toolResultContent = '[search_services] ПОМИЛКА: порожній запит';
      } else {
        try {
          const { contextBlock, matchCount } = await searchServicesForContext(query);
          toolResultContent =
            matchCount > 0
              ? `[search_services] РЕЗУЛЬТАТ:\n${contextBlock}`
              : `[search_services] Нічого не знайдено за «${query}».`;
        } catch (err) {
          log.error({ err, query }, 'search_services failed');
          toolResultContent = '[search_services] ПОМИЛКА: CRM тимчасово недоступна.';
        }
      }

      const response2 = await askClaude(
        {
          systemPrompt: prompt,
          conversationHistory: [
            ...history,
            { role: 'user' as const, content: enrichedMessageText },
            { role: 'assistant' as const, content: response.text || `[Шукаю послуги: ${query}]` },
          ],
          userMessage: toolResultContent,
          tools,
        },
        { channel: conversation.channel, conversationId, clientId: client.id },
      );
      responseText = response2.text;
      agentFallback = response2.fallback ?? agentFallback;
      if (response2.errorDetail) agentErrorDetail = response2.errorDetail;
      if (response2.toolCalls?.length) {
        await runSideEffectToolCalls(response2.toolCalls, client.id, conversationId, mediaAttachments);
        if (
          await tryTerminalToolCalls(response2.toolCalls, {
            conversationId,
            client,
            agentMode: agentCfg.mode,
            clientMessage: stripMarkdownForInstagram(response2.text),
            turnStartedAt,
          })
        ) {
          return;
        }
      }
    }

    if (slotsCall && !handoff && !collectOrder && !bookAppointment && !searchServicesCall) {
      const date = typeof slotsCall.args.date === 'string' ? slotsCall.args.date.trim() : '';
      const rawServices = Array.isArray(slotsCall.args.services) ? slotsCall.args.services : [];
      const services = rawServices.flatMap((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const o = raw as Record<string, unknown>;
        const id = typeof o.id === 'number' ? o.id : Number(o.id);
        const durationMin =
          typeof o.duration_min === 'number' ? o.duration_min : Number(o.duration_min) || 60;
        if (!Number.isFinite(id)) return [];
        return [{ id, durationMin }];
      });

      let toolResultContent: string;
      if (!date || services.length === 0) {
        toolResultContent = '[get_available_slots] ПОМИЛКА: потрібні date та services';
      } else if (!conversation.branch?.crmExternalId) {
        toolResultContent =
          '[get_available_slots] ПОМИЛКА: спочатку обери філію через set_conversation_branch';
      } else {
        try {
          const slotsText = await getAvailableSlotsForContext({
            date,
            branchCrmId: conversation.branch.crmExternalId,
            services,
            fullMonth: slotsCall.args.full_month === true,
          });
          toolResultContent = `[get_available_slots] РЕЗУЛЬТАТ:\n${slotsText}`;
        } catch (err) {
          log.error({ err, date }, 'get_available_slots failed');
          toolResultContent = '[get_available_slots] ПОМИЛКА: не вдалося отримати слоти';
        }
      }

      const response2 = await askClaude(
        {
          systemPrompt: prompt,
          conversationHistory: [
            ...history,
            { role: 'user' as const, content: enrichedMessageText },
            { role: 'assistant' as const, content: response.text || `[Перевіряю слоти на ${date}]` },
          ],
          userMessage: toolResultContent,
          tools,
        },
        { channel: conversation.channel, conversationId, clientId: client.id },
      );
      responseText = response2.text;
      agentFallback = response2.fallback ?? agentFallback;
      if (response2.errorDetail) agentErrorDetail = response2.errorDetail;
      if (response2.toolCalls?.length) {
        await runSideEffectToolCalls(response2.toolCalls, client.id, conversationId, mediaAttachments);
        if (
          await tryTerminalToolCalls(response2.toolCalls, {
            conversationId,
            client,
            agentMode: agentCfg.mode,
            clientMessage: stripMarkdownForInstagram(response2.text),
            turnStartedAt,
          })
        ) {
          return;
        }
      }
    }
  }

  // ── 10. Validate output ───────────────────────────────────────────

  let outputValidationFailure = false;
  if (LEAKED_INTERNALS_RE.test(responseText)) {
    log.warn(
      { conversationId, originalResponse: responseText, clientMessage: messageText.slice(0, 200) },
      'Bot response contained internal IDs - replacing with safe fallback',
    );
    responseText = 'Дякую за запитання! Зверніться до менеджера для деталей.';
    outputValidationFailure = true;
  }

  const clientFacingText = stripMarkdownForInstagram(responseText);

  if (!(await isBotTurnStillValid(conversationId, turnStartedAt))) {
    log.info({ conversationId }, 'Bot outbound aborted — manager took over during turn');
    return;
  }

  // After two consecutive agent fallbacks, escalate to a live manager.
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
      await performManagerHandoff({
        conversationId,
        client,
        reason: `Агент не зміг обробити запит після ${priorFallbacks + 1} спроб. ${failureDetail}`,
        turnStartedAt,
      });
      return;
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

  if (outputValidationFailure) {
    botFailureCode = 'output_validation';
    botFailureDetail = formatBotFailureDetail({
      code: 'output_validation',
      clientMessage: messageText,
    });
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
  } else if (agentFallback && isAgentFallbackReply(clientFacingText)) {
    botFailureCode = agentFallback;
    botFailureDetail = formatBotFailureDetail({
      code: agentFallback,
      errorDetail: agentErrorDetail,
      clientMessage: messageText,
    });
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

  // ── 12. Persist bot message (same text as sent to IG — no literal Markdown) ──
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

  log.info(
    { conversationId, responseLength: clientFacingText.length },
    'Bot response sent and persisted',
  );
  } finally {
    await igTyping.end();
  }
}

// ---------------------------------------------------------------------------
// Tool call dispatch helpers
// ---------------------------------------------------------------------------

type TerminalToolContext = {
  conversationId: string;
  client: { id: string; igUserId: string | null };
  agentMode: AgentMode;
  /** Bot reply shown to the client — used as the order confirmation when collect_order fires. */
  clientMessage?: string;
  turnStartedAt: Date;
};

/** Fire-and-forget profile / intent writes — never ends the conversation turn. */
async function runSideEffectToolCalls(
  toolCalls: { name: string; args: Record<string, unknown> }[],
  clientId: string,
  conversationId: string,
  mediaAttachments?: StoredMediaAttachment[],
): Promise<void> {
  const updateInfo = toolCalls.find((tc) => tc.name === 'update_client_info');
  if (updateInfo) {
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
    handleTagClient(clientId, tagClient.args).catch((err) => {
      log.error({ err, conversationId, clientId }, 'Failed to tag client');
    });
  }

  const classifyIntent = toolCalls.find((tc) => tc.name === 'classify_intent');
  if (classifyIntent) {
    handleClassifyIntent(conversationId, classifyIntent.args).catch((err) => {
      log.error({ err, conversationId }, 'Failed to classify intent');
    });
  }

  const setBranch = toolCalls.find((tc) => tc.name === 'set_conversation_branch');
  if (setBranch) {
    handleSetConversationBranch(conversationId, setBranch.args).catch((err) => {
      log.error({ err, conversationId }, 'Failed to set conversation branch');
    });
  }

  const attachPhoto = toolCalls.find((tc) => tc.name === 'attach_reference_photo');
  if (attachPhoto) {
    handleAttachReferencePhoto(clientId, conversationId, attachPhoto.args, mediaAttachments).catch(
      (err) => {
        log.error({ err, conversationId, clientId }, 'Failed to attach reference photo');
      },
    );
  }
}

/** Handoff / collect_order — ends the turn when handled. */
async function tryTerminalToolCalls(
  toolCalls: { name: string; args: Record<string, unknown> }[],
  ctx: TerminalToolContext,
): Promise<boolean> {
  const { conversationId, client, agentMode, turnStartedAt } = ctx;

  if (!(await isBotTurnStillValid(conversationId, turnStartedAt))) {
    log.info({ conversationId }, 'Terminal tool calls skipped — manager took over');
    return true;
  }

  const handoff = toolCalls.find((tc) => tc.name === 'request_handoff');
  if (handoff) {
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

  const collectOrder = toolCalls.find((tc) => tc.name === 'collect_order');
  if (collectOrder && agentMode === 'sales' && client.igUserId) {
    const orderId = await handleCollectOrder(
      conversationId,
      client.id,
      client.igUserId,
      collectOrder.args,
      { clientMessage: ctx.clientMessage },
    );
    if (orderId) return true;
  }

  const bookAppointment = toolCalls.find((tc) => tc.name === 'book_appointment');
  if (bookAppointment && agentMode === 'booking' && client.igUserId) {
    const appointmentId = await handleBookAppointment(
      conversationId,
      client.id,
      bookAppointment.args,
    );
    if (appointmentId) return true;
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
