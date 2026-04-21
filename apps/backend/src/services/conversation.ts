import pino from 'pino';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { askClaude } from './claude.js';
import { sendText } from './instagram.js';
import {
  buildRuntimePrompt,
  getActivePrompt,
  getWorkingHours,
  isWithinWorkingHours,
  loadCatalogSnippet,
  type ClientProfile,
} from './prompt-builder.js';
import { downloadAllMedia } from './media.js';
import { notifyHandoff } from './telegram-notify.js';
import { buildAgentTools } from '../lib/tool-definitions.js';
import { getActiveCrmFieldMappings } from '../lib/crm-field-mappings.js';
import { getAgentConfig } from '../lib/agent-config.js';
import { handleCollectOrder } from './order.js';
import { handleClassifyIntent, handleSubmitBrief } from './brief.js';
import { mirrorClientToCrm } from './crm-sync.js';
import { markFirstOutboundAt } from '../lib/conversation-metrics.js';
import {
  searchActiveProductsForContext,
  extractKeywordsFromCaption,
} from './product-search.js';
import { getDeliveryCost } from './nova-poshta.js';
import type { SharedPostData } from '../routes/webhooks.js';

const log = pino({ name: 'conversation' });

/** Regex to detect leaked internal IDs / prices in bot output */
const LEAKED_INTERNALS_RE = /product_id|offer_id|purchased_price/i;

/** Max messages to include in Claude conversation history */
const MAX_HISTORY_MESSAGES = 30;

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
 * @param mediaUrls       Local paths to downloaded media files (images, videos).
 * @param sharedPost      Parsed metadata if the user forwarded an IG post.
 */
export async function handleIncomingMessage(
  conversationId: string,
  messageText: string,
  mediaUrls?: string[],
  sharedPost?: SharedPostData,
): Promise<void> {
  // ── 1. Fetch conversation with client ─────────────────────────────
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { client: true },
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
    const counts = itemNames.reduce<Record<string, number>>((acc, name) => {
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

  // ── 2. Handoff state - skip bot response ──────────────────────────
  if (conversation.state === 'handoff') {
    log.info(
      { conversationId },
      'Message in handoff mode, skipping bot response',
    );
    // Forward message to Telegram manager group for handoff conversations
    notifyHandoff({
      conversationId,
      clientIgUserId: client.igUserId!,
      reason: conversation.handoffReason || 'Клієнт написав під час хендофу',
      lastMessages: [{ sender: 'client', text: messageText }],
    }).catch((err) => log.error({ err }, 'Failed to forward to Telegram'));
    return;
  }

  // ── 3. Closed / paused - ignore ──────────────────────────────────
  if (conversation.state === 'closed' || conversation.state === 'paused') {
    log.debug(
      { conversationId, state: conversation.state },
      'Conversation closed or paused, ignoring',
    );
    return;
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
  const activePrompt = await getActivePrompt();
  const catalog = await loadCatalogSnippet();

  // Per-tenant CRM field mappings — shapes both the prompt (extra-fields
  // hints) and the tool schema (update_client_info.custom_fields). Cache
  // TTL inside the module keeps this at ~0 cost on hot paths.
  //
  // Gated on CRM_WRITE_ENABLED so the extended surface only appears when
  // we can actually persist what Claude extracts. Keeping hints off when
  // writes are off avoids teasing the bot with fields whose values would
  // be silently discarded.
  const crmMappings = config.CRM_WRITE_ENABLED
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
  });

  const tools = buildAgentTools(agentCfg.mode, {
    buyerScopeMappings: crmMappings?.buyer ?? [],
    leadScopeMappings: crmMappings?.lead ?? [],
  });

  // ── 6. Build conversation history (last 30 messages) ──────────────
  const rawMessages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: MAX_HISTORY_MESSAGES,
    select: { direction: true, text: true },
  });

  // Reverse to chronological order & filter out system / empty
  const history = rawMessages
    .reverse()
    .filter((m) => m.direction !== 'system' && m.text)
    .map((m) => ({
      role: (m.direction === 'in' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.text!,
    }));

  // ── 7. Download media if present ──────────────────────────────────
  const localPaths =
    mediaUrls && mediaUrls.length > 0
      ? await downloadAllMedia(mediaUrls)
      : [];

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
  }

  // ── 8. Call Claude ────────────────────────────────────────────────
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
    },
  );

  // ── 9. Handle tool calls ──────────────────────────────────────────
  let responseText = response.text;

  if (response.toolCalls && response.toolCalls.length > 0) {
    // update_client_info - save extracted customer data to their profile.
    // This is a background write - we do NOT exit early so Claude's text
    // response (if any) is still delivered to the client.
    const updateInfo = response.toolCalls.find((tc) => tc.name === 'update_client_info');
    if (updateInfo) {
      // Extract the dynamic custom_fields payload (if any) so we can push
      // it to the CRM alongside the mirror of the core contact fields.
      // Local DB stays simple: we don't persist custom field values yet,
      // only core ones (phone/email/city/NP). CRM owns the custom-field
      // snapshot.
      const extractedCustomFields: Record<string, unknown> =
        typeof updateInfo.args.custom_fields === 'object' &&
        updateInfo.args.custom_fields !== null &&
        !Array.isArray(updateInfo.args.custom_fields)
          ? (updateInfo.args.custom_fields as Record<string, unknown>)
          : {};

      handleUpdateClientInfo(client.id, updateInfo.args)
        .then(() => mirrorClientToCrm(client.id, extractedCustomFields))
        .catch((err) => {
          log.error(
            { err, conversationId, clientId: client.id },
            'Failed to save/mirror client info',
          );
        });
    }

    const tagClient = response.toolCalls.find((tc) => tc.name === 'tag_client');
    if (tagClient) {
      handleTagClient(client.id, tagClient.args).catch((err) => {
        log.error({ err, conversationId, clientId: client.id }, 'Failed to tag client');
      });
    }

    // classify_intent — fires on the first message of a conversation;
    // fire-and-forget so the bot reply is never delayed by a DB write
    // to the conversation row.
    const classifyIntent = response.toolCalls.find((tc) => tc.name === 'classify_intent');
    if (classifyIntent) {
      handleClassifyIntent(conversationId, classifyIntent.args).catch((err) => {
        log.error({ err, conversationId }, 'Failed to classify intent');
      });
    }

    const handoff = response.toolCalls.find((tc) => tc.name === 'request_handoff');
    if (handoff) {
      const reason =
        typeof handoff.args.reason === 'string'
          ? handoff.args.reason
          : 'Клієнт потребує менеджера';

      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          state: 'handoff',
          handoffReason: reason,
        },
      });

      const handoffMessage = 'Зачекайте, будь ласка, зʼєдную Вас з менеджером.';

      try {
        await sendText(client.igUserId, handoffMessage);
      } catch (err) {
        log.error({ err, conversationId }, 'Failed to send handoff message');
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

      // Notify Telegram manager group about the handoff
      const recentMsgs = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { sender: true, text: true },
      });
      notifyHandoff({
        conversationId,
        clientIgUserId: client.igUserId!,
        reason,
        lastMessages: recentMsgs
          .reverse()
          .filter((m) => m.text)
          .map((m) => ({ sender: m.sender, text: m.text! })),
      }).catch((err) => log.error({ err }, 'Failed to send handoff notification'));
      return;
    }

    const collectOrder = response.toolCalls.find((tc) => tc.name === 'collect_order');
    if (collectOrder && agentCfg.mode === 'sales') {
      await handleCollectOrder(
        conversationId,
        client.id,
        client.igUserId!,
        collectOrder.args,
      );
      return;
    }

    // submit_brief — leadgen-mode terminal tool. After persisting the
    // brief and firing notifications, we still let the bot's text reply
    // fall through so the client sees the closing message (with SLA /
    // out-of-hours copy from the prompt-builder).
    const submitBrief = response.toolCalls.find((tc) => tc.name === 'submit_brief');
    if (submitBrief && agentCfg.mode === 'leadgen') {
      await handleSubmitBrief(
        conversationId,
        client.id,
        client.igUserId!,
        submitBrief.args,
      );
    }

    // get_delivery_cost - query tool: fetch NP price, then re-invoke Claude with the result
    const deliveryCostCall = response.toolCalls.find((tc) => tc.name === 'get_delivery_cost');
    if (deliveryCostCall && !handoff && !collectOrder) {
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
      log.info({ conversationId, city, toolResultContent }, 'Delivery cost fetched and Claude re-invoked');
    }
  }

  // ── 10. Validate output ───────────────────────────────────────────

  if (LEAKED_INTERNALS_RE.test(responseText)) {
    log.warn(
      { conversationId, originalResponse: responseText },
      'Bot response contained internal IDs - replacing with safe fallback',
    );
    responseText = 'Дякую за запитання! Зверніться до менеджера для деталей.';
  }

  // ── 11. Send response ─────────────────────────────────────────────
  try {
    await sendText(client.igUserId, responseText);
  } catch (err) {
    log.error({ err, conversationId }, 'Failed to send bot response to Instagram');
    // Still persist the message even if delivery failed
  }

  // ── 12. Persist bot message ───────────────────────────────────────
  await prisma.message.create({
    data: {
      conversationId,
      direction: 'out',
      sender: 'bot',
      text: responseText,
    },
  });
  markFirstOutboundAt(conversationId).catch((err) =>
    log.warn({ err, conversationId }, 'markFirstOutboundAt failed (non-fatal)'),
  );

  log.info(
    { conversationId, responseLength: responseText.length },
    'Bot response sent and persisted',
  );
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
