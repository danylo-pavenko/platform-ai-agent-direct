import './config.js'; // load dotenv first

import pino from 'pino';
import { config } from './config.js';
import { getIntegrationConfig } from './lib/integration-config.js';
import {
  getTelegramBotWakeAt,
  resolveTelegramBotIdlePollMs,
  TELEGRAM_BOT_CONFIG_WATCH_MS,
} from './lib/telegram-bot-wake.js';
import {
  isGroupChatType,
  registerTelegramGroup,
  unregisterTelegramGroup,
} from './lib/telegram-groups.js';
import { Bot } from 'grammy';
import { prisma } from './lib/prisma.js';
import { sendText } from './services/instagram.js';
import {
  findActiveManagerByTgId,
  managerLabelFromUser,
  redeemTelegramLinkCode,
  unlinkTelegramFromManager,
} from './lib/telegram-link.js';
import { formatAdminLabel } from './lib/admin-user.js';
import { cancelPendingFollowUpsSafe } from './lib/follow-up-schedule.js';

const log = pino({
  name: `${config.INSTANCE_ID.toUpperCase()}-bot`,
  level: config.LOG_LEVEL,
});

// ── Helpers ──

function timeAgo(date: Date | null): string {
  if (!date) return 'невідомо';

  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return `${diffSec} сек тому`;
  if (diffMin < 60) return `${diffMin} хв тому`;
  if (diffHour < 24) return `${diffHour} год тому`;
  return `${diffDay} дн тому`;
}

function shortId(uuid: string): string {
  return uuid.substring(0, 8);
}

function stateEmoji(state: string): string {
  switch (state) {
    case 'bot':
      return '\u{1F916}';
    case 'handoff':
      return '\u{1F464}';
    case 'paused':
      return '\u{23F8}\u{FE0F}';
    case 'closed':
      return '\u{274C}';
    default:
      return '\u{2753}';
  }
}

async function findConversationByPrefix(prefix: string) {
  const conversations = await prisma.$queryRaw<
    Array<{ id: string; state: string; handed_off_to: string | null }>
  >`SELECT id, state, handed_off_to FROM conversations WHERE CAST(id AS TEXT) LIKE ${prefix + '%'} LIMIT 1`;

  if (conversations.length === 0) return null;

  return prisma.conversation.findUnique({
    where: { id: conversations[0].id },
  });
}

function stateLabel(state: string): string {
  switch (state) {
    case 'bot':
      return 'бот';
    case 'handoff':
      return 'менеджер';
    case 'paused':
      return 'пауза';
    case 'closed':
      return 'закрито';
    default:
      return state;
  }
}

// ── Process lifecycle ──

let shutdownRequested = false;
let currentBot: Bot | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setupProcessShutdown(): void {
  const onSignal = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    log.info('Shutting down Telegram bot process...');
    currentBot?.stop();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

// ── Bot setup ──

async function runBotSession(token: string): Promise<void> {
  const bot = new Bot(token);
  currentBot = bot;

  // Auto-register any group/supergroup the bot is added to (or already in).
  bot.use(async (ctx, next) => {
    const chat = ctx.chat;
    if (chat && isGroupChatType(chat.type)) {
      await registerTelegramGroup(chat.id, 'title' in chat ? chat.title : undefined);
    }
    await next();
  });

  bot.on('my_chat_member', async (ctx) => {
    const chat = ctx.myChatMember.chat;
    if (!isGroupChatType(chat.type)) return;

    const newStatus = ctx.myChatMember.new_chat_member.status;
    const oldStatus = ctx.myChatMember.old_chat_member.status;

    const memberStatuses = new Set(['member', 'administrator', 'restricted']);
    const leftStatuses = new Set(['left', 'kicked', 'banned']);

    if (leftStatuses.has(oldStatus) && memberStatuses.has(newStatus)) {
      await registerTelegramGroup(chat.id, 'title' in chat ? chat.title : undefined);
      log.info({ chatId: chat.id, title: 'title' in chat ? chat.title : null }, 'Bot added to group');
    } else if (memberStatuses.has(oldStatus) && leftStatuses.has(newStatus)) {
      await unregisterTelegramGroup(chat.id);
      log.info({ chatId: chat.id }, 'Bot removed from group');
    }
  });

// Set bot commands menu (visible in Telegram UI)
bot.api.setMyCommands([
  { command: 'start', description: 'Привітання та інформація' },
  { command: 'link', description: 'Привʼязати Telegram (код з адмінки)' },
  { command: 'unlink', description: 'Відвʼязати Telegram' },
  { command: 'whoami', description: 'Хто я в системі' },
  { command: 'conversations', description: 'Активні розмови' },
  { command: 'takeover', description: 'Взяти розмову (ID)' },
  { command: 'return', description: 'Повернути розмову боту (ID)' },
  { command: 'close', description: 'Закрити розмову (ID)' },
  { command: 'help', description: 'Список команд' },
]).catch((err) => log.warn({ err }, 'Failed to set bot commands'));

// ── Helpers ──

async function isManagerAuthorized(tgUserId: number): Promise<boolean> {
  const user = await findActiveManagerByTgId(tgUserId);
  return !!user;
}

async function getAuthorizedManager(tgUserId: number) {
  return findActiveManagerByTgId(tgUserId);
}

async function ensureManagerAuth(ctx: {
  from?: { id: number };
  reply: (text: string) => Promise<unknown>;
}): Promise<boolean> {
  if (!ctx.from) return false;
  if (await isManagerAuthorized(ctx.from.id)) return true;
  await ctx.reply(
    'Спочатку привʼяжіть Telegram у особистих повідомленнях з ботом:\n/link <код з адмінки>',
  );
  return false;
}

function buildMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '💬 Активні розмови', callback_data: 'menu:conversations' },
        ],
        [
          { text: '📊 Синхронізація', callback_data: 'menu:sync' },
          { text: '❓ Допомога', callback_data: 'menu:help' },
        ],
      ],
    },
  };
}

const HELP_TEXT = `Доступні команди:

/start - Привітання
/link <код> - Привʼязати Telegram (код видає адмін у розділі «Користувачі»)
/unlink - Відвʼязати Telegram
/whoami - Хто я в системі
/conversations - Список активних розмов
/takeover <ID> - Взяти розмову собі
/return <ID> - Повернути розмову боту
/close <ID> - Закрити розмову
/help - Ця довідка

Після привʼязки ви будете отримувати:
• Сповіщення про ескалації та замовлення (у цей чат або в групу менеджерів)
• Картки замовлень з кнопками Підтвердити / Відхилити
• Повідомлення від клієнтів у режимі хендофу`;

// /start - Welcome message
bot.command('start', async (ctx) => {
  try {
    const manager = await getAuthorizedManager(ctx.from!.id);

    if (manager) {
      const label = managerLabelFromUser(manager);
      await ctx.reply(
        `Вітаю! 👋\n\nВи авторизовані як ${label} (${config.BRAND_NAME}).\nОберіть дію:`,
        buildMenuKeyboard(),
      );
    } else {
      await ctx.reply(
        `Вітаю! 👋\n\nЦе бот менеджера магазину ${config.BRAND_NAME}.\n\nДля початку роботи попросіть адміна створити вам доступ у панелі («Користувачі») і надішліть сюди:\n/link <код>\n\nПісля привʼязки ви зможете:\n• Отримувати сповіщення в особисті повідомлення (група не обовʼязкова)\n• Керувати розмовами з клієнтами\n• Підтверджувати замовлення`,
      );
    }
  } catch (err) {
    log.error(err, 'Error in /start command');
    await ctx.reply('Сталася помилка. Спробуйте пізніше.');
  }
});

// /help - Commands list
bot.command('help', async (ctx) => {
  try {
    await ctx.reply(HELP_TEXT);
  } catch (err) {
    log.error(err, 'Error in /help command');
  }
});

// Menu inline button callbacks
bot.on('callback_query:data', async (ctx, next) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith('menu:')) return next();

  try {
    if (!(await ensureManagerAuth(ctx))) return;

    if (data === 'menu:conversations') {
      // Reuse conversations logic
      const conversations = await prisma.conversation.findMany({
        where: { state: { in: ['bot', 'handoff'] } },
        include: { client: true },
        orderBy: { lastMessageAt: 'desc' },
        take: 10,
      });

      if (conversations.length === 0) {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText('Немає активних розмов.', buildMenuKeyboard());
        return;
      }

      const lines = conversations.map((conv, i) => {
        const clientName = conv.client.displayName || conv.client.igUserId || 'невідомий';
        const emoji = stateEmoji(conv.state);
        const label = stateLabel(conv.state);
        const ago = timeAgo(conv.lastMessageAt);
        const id = shortId(conv.id);
        return `${i + 1}. [${id}] ${clientName} - ${emoji} ${label} - ${ago}`;
      });

      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        `Активні розмови:\n\n${lines.join('\n')}`,
        buildMenuKeyboard(),
      );
    } else if (data === 'menu:sync') {
      const lastRun = await prisma.crmSyncRun.findFirst({
        orderBy: { startedAt: 'desc' },
      });
      const status = lastRun
        ? `Остання синхронізація: ${lastRun.status === 'ok' ? '✅' : '❌'} ${new Date(lastRun.startedAt).toLocaleString('uk-UA')}`
        : 'Синхронізацій ще не було.';

      await ctx.answerCallbackQuery();
      await ctx.editMessageText(status, buildMenuKeyboard());
    } else if (data === 'menu:help') {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(HELP_TEXT, buildMenuKeyboard());
    } else {
      await ctx.answerCallbackQuery();
    }
  } catch (err) {
    log.error(err, 'Error in menu callback');
    await ctx.answerCallbackQuery({ text: 'Помилка' }).catch(() => {});
  }
});

// /link CODE - Bind Telegram to AdminUser via one-time code from admin panel
bot.command('link', async (ctx) => {
  try {
    ctx.deleteMessage().catch(() => {});

    const code = ctx.match?.trim();
    if (!code) {
      await ctx.reply('Використання: /link <код з адмінки>');
      return;
    }

    const result = await redeemTelegramLinkCode({
      code,
      tgUserId: String(ctx.from!.id),
      tgUsername: ctx.from?.username ?? null,
    });

    if (!result.ok) {
      await ctx.reply(result.error);
      return;
    }

    const label = formatAdminLabel(result.user);
    log.info(
      { tgUserId: ctx.from!.id, adminUserId: result.user.id },
      'Manager linked Telegram via /link',
    );
    await ctx.reply(
      `Привʼязано! ✅\n\nВи: ${label}\nСповіщення надходитимуть у цей чат.\n\nОберіть дію:`,
      buildMenuKeyboard(),
    );
  } catch (err) {
    log.error(err, 'Error in /link command');
    await ctx.reply('Сталася помилка. Спробуйте пізніше.');
  }
});

// Deprecated alias — point users to /link
bot.command('login', async (ctx) => {
  try {
    ctx.deleteMessage().catch(() => {});
    await ctx.reply(
      'Команда /login більше не використовується.\n\nПопросіть адміна згенерувати код у розділі «Користувачі» і надішліть:\n/link <код>',
    );
  } catch (err) {
    log.error(err, 'Error in /login command');
  }
});

bot.command('unlink', async (ctx) => {
  try {
    const updated = await unlinkTelegramFromManager(ctx.from!.id);
    if (!updated) {
      await ctx.reply('Цей Telegram не привʼязаний до жодного користувача.');
      return;
    }
    await ctx.reply('Telegram відвʼязано. Щоб знову підключитись — /link <новий код>.');
  } catch (err) {
    log.error(err, 'Error in /unlink command');
    await ctx.reply('Сталася помилка. Спробуйте пізніше.');
  }
});

bot.command('whoami', async (ctx) => {
  try {
    const manager = await getAuthorizedManager(ctx.from!.id);
    if (!manager) {
      await ctx.reply('Ви не привʼязані. Використайте /link <код>.');
      return;
    }
    const label = managerLabelFromUser(manager);
    const tg = manager.tgUsername ? `@${manager.tgUsername}` : '—';
    await ctx.reply(
      `Ви: ${label}\nЛогін: ${manager.username}\nРоль: ${manager.role}\nTelegram: ${tg}\nTG id: ${manager.tgUserId}`,
    );
  } catch (err) {
    log.error(err, 'Error in /whoami command');
    await ctx.reply('Сталася помилка. Спробуйте пізніше.');
  }
});

// /conversations - List active conversations
bot.command('conversations', async (ctx) => {
  try {
    if (!(await ensureManagerAuth(ctx))) return;

    const conversations = await prisma.conversation.findMany({
      where: { state: { in: ['bot', 'handoff'] } },
      include: { client: true },
      orderBy: { lastMessageAt: 'desc' },
      take: 20,
    });

    if (conversations.length === 0) {
      await ctx.reply('Немає активних розмов.');
      return;
    }

    const lines = conversations.map((conv, i) => {
      const clientName = conv.client.displayName || conv.client.igUserId || 'невідомий';
      const channel = conv.channel === 'ig' ? 'IG' : 'TG';
      const emoji = stateEmoji(conv.state);
      const label = stateLabel(conv.state);
      const ago = timeAgo(conv.lastMessageAt);
      const id = shortId(conv.id);

      return `${i + 1}. [${id}] ${channel} ${clientName} - ${emoji} ${label} - ${ago}`;
    });

    await ctx.reply(`Активні розмови:\n${lines.join('\n')}`);
  } catch (err) {
    log.error(err, 'Error in /conversations command');
    await ctx.reply('Сталася помилка. Спробуйте пізніше.');
  }
});

// /takeover CONV_ID - Take over conversation
bot.command('takeover', async (ctx) => {
  try {
    if (!(await ensureManagerAuth(ctx))) return;

    const prefix = ctx.match?.trim();

    if (!prefix) {
      await ctx.reply('Використання: /takeover <ID розмови (8 символів)>');
      return;
    }

    const conversation = await findConversationByPrefix(prefix);

    if (!conversation) {
      await ctx.reply('Розмову не знайдено.');
      return;
    }

    const manager = await getAuthorizedManager(ctx.from!.id);
    if (!manager) {
      await ctx.reply('Спочатку /link <код>.');
      return;
    }

    const now = new Date();
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        state: 'handoff',
        handedOffTo: manager.id,
        handoffReason: 'Менеджер взяв вручну',
        handedOffAt: conversation.handedOffAt ?? now,
      },
    });
    cancelPendingFollowUpsSafe(conversation.id, 'telegram_takeover');

    // Refresh username from Telegram when available
    if (ctx.from?.username && ctx.from.username !== manager.tgUsername) {
      await prisma.adminUser.update({
        where: { id: manager.id },
        data: { tgUsername: ctx.from.username },
      });
    }

    const id = shortId(conversation.id);
    const label = managerLabelFromUser(manager);
    log.info(
      { conversationId: conversation.id, adminUserId: manager.id, tgUserId: ctx.from!.id },
      'Conversation taken over',
    );
    await ctx.reply(
      `Розмову #${id} взято (${label}). Нові повідомлення клієнта будуть пересилатися сюди.`,
    );
  } catch (err) {
    log.error(err, 'Error in /takeover command');
    await ctx.reply('Сталася помилка. Спробуйте пізніше.');
  }
});

// /return CONV_ID - Return conversation to bot
bot.command('return', async (ctx) => {
  try {
    if (!(await ensureManagerAuth(ctx))) return;

    const prefix = ctx.match?.trim();

    if (!prefix) {
      await ctx.reply('Використання: /return <ID розмови (8 символів)>');
      return;
    }

    const conversation = await findConversationByPrefix(prefix);

    if (!conversation) {
      await ctx.reply('Розмову не знайдено.');
      return;
    }

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          state: 'bot',
          handedOffTo: null,
          handedOffAt: null,
        },
      });

    const id = shortId(conversation.id);
    log.info({ conversationId: conversation.id, tgUserId: ctx.from!.id }, 'Conversation returned to bot');
    await ctx.reply(`Розмову #${id} повернуто боту.`);
  } catch (err) {
    log.error(err, 'Error in /return command');
    await ctx.reply('Сталася помилка. Спробуйте пізніше.');
  }
});

// /close CONV_ID - Close conversation
bot.command('close', async (ctx) => {
  try {
    if (!(await ensureManagerAuth(ctx))) return;

    const prefix = ctx.match?.trim();

    if (!prefix) {
      await ctx.reply('Використання: /close <ID розмови (8 символів)>');
      return;
    }

    const conversation = await findConversationByPrefix(prefix);

    if (!conversation) {
      await ctx.reply('Розмову не знайдено.');
      return;
    }

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { state: 'closed' },
    });

    const id = shortId(conversation.id);
    log.info({ conversationId: conversation.id, tgUserId: ctx.from!.id }, 'Conversation closed');
    await ctx.reply(`Розмову #${id} закрито.`);
  } catch (err) {
    log.error(err, 'Error in /close command');
    await ctx.reply('Сталася помилка. Спробуйте пізніше.');
  }
});

// ── Inline callback handlers ──

bot.on('callback_query:data', async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;

    if (data.startsWith('takeover:')) {
      const manager = await getAuthorizedManager(ctx.from.id);
      if (!manager) {
        await ctx.answerCallbackQuery({ text: 'Спочатку /link <код> у боті' });
        return;
      }

      const conversationId = data.substring('takeover:'.length);

      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
      });

      if (!conversation) {
        await ctx.answerCallbackQuery({ text: 'Розмову не знайдено.' });
        return;
      }

      const now = new Date();
      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          state: 'handoff',
          handedOffTo: manager.id,
          handoffReason: 'Менеджер взяв вручну',
          handedOffAt: conversation.handedOffAt ?? now,
        },
      });

      if (ctx.from.username && ctx.from.username !== manager.tgUsername) {
        await prisma.adminUser.update({
          where: { id: manager.id },
          data: { tgUsername: ctx.from.username },
        });
      }

      const label = managerLabelFromUser({
        ...manager,
        tgUsername: ctx.from.username ?? manager.tgUsername,
      });
      log.info(
        { conversationId, adminUserId: manager.id, tgUserId: ctx.from.id },
        'Conversation taken over via callback',
      );

      await ctx.answerCallbackQuery({ text: 'Взято!' });
      await ctx.editMessageText(`\u{2705} Взято менеджером ${label}`);
    } else if (data.startsWith('return:')) {
      if (!(await isManagerAuthorized(ctx.from.id))) {
        await ctx.answerCallbackQuery({ text: 'Спочатку /link <код> у боті' });
        return;
      }

      const conversationId = data.substring('return:'.length);

      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
      });

      if (!conversation) {
        await ctx.answerCallbackQuery({ text: 'Розмову не знайдено.' });
        return;
      }

      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          state: 'bot',
          handedOffTo: null,
          handedOffAt: null,
        },
      });

      log.info({ conversationId, tgUserId: ctx.from.id }, 'Conversation returned to bot via callback');

      await ctx.answerCallbackQuery({ text: 'Повернуто боту!' });
      await ctx.editMessageText('\u{2705} Повернуто боту');
    } else if (data.startsWith('approve:')) {
      if (!(await isManagerAuthorized(ctx.from.id))) {
        await ctx.answerCallbackQuery({ text: 'Спочатку /link <код> у боті' });
        return;
      }

      const orderId = data.substring('approve:'.length);

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { client: true },
      });

      if (!order) {
        await ctx.answerCallbackQuery({ text: 'Замовлення не знайдено.' });
        return;
      }

      if (order.status === 'confirmed' || order.status === 'cancelled') {
        await ctx.answerCallbackQuery({ text: 'Замовлення вже оброблено.' });
        return;
      }

      await prisma.order.update({
        where: { id: orderId },
        data: { status: 'confirmed' },
      });

      if (order.client.igUserId) {
        await sendText(
          order.client.igUserId,
          'Ваше замовлення підтверджено! Менеджер зв\'яжеться з Вами для уточнення деталей доставки.',
        );
      }

      const username = ctx.from.username || ctx.from.first_name || String(ctx.from.id);
      log.info({ orderId, tgUserId: ctx.from.id }, 'Order approved via callback');

      await ctx.answerCallbackQuery({ text: 'Підтверджено!' });
      await ctx.editMessageText(`\u{2705} Замовлення підтверджено менеджером @${username}`);
    } else if (data.startsWith('decline:')) {
      if (!(await isManagerAuthorized(ctx.from.id))) {
        await ctx.answerCallbackQuery({ text: 'Спочатку /link <код> у боті' });
        return;
      }

      const orderId = data.substring('decline:'.length);

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { client: true },
      });

      if (!order) {
        await ctx.answerCallbackQuery({ text: 'Замовлення не знайдено.' });
        return;
      }

      if (order.status === 'confirmed' || order.status === 'cancelled') {
        await ctx.answerCallbackQuery({ text: 'Замовлення вже оброблено.' });
        return;
      }

      await prisma.order.update({
        where: { id: orderId },
        data: {
          status: 'cancelled',
          isArchived: true,
          archivedAt: new Date(),
        },
      });

      if (order.client.igUserId) {
        await sendText(
          order.client.igUserId,
          'На жаль, Ваше замовлення не може бути оброблене. Менеджер зв\'яжеться з Вами.',
        );
      }

      const username = ctx.from.username || ctx.from.first_name || String(ctx.from.id);
      log.info({ orderId, tgUserId: ctx.from.id }, 'Order declined via callback');

      await ctx.answerCallbackQuery({ text: 'Відхилено.' });
      await ctx.editMessageText(`\u{274C} Замовлення відхилено менеджером @${username}`);
    } else {
      await ctx.answerCallbackQuery();
    }
  } catch (err) {
    log.error(err, 'Error in callback_query handler');
    await ctx.answerCallbackQuery({ text: 'Сталася помилка.' }).catch(() => {});
  }
});

  // ── Start long polling ──

  const configWatcher = setInterval(async () => {
    if (shutdownRequested) return;
    const fresh = await getIntegrationConfig({ fresh: true });
    if (!fresh.telegram.botToken || fresh.telegram.botToken !== token) {
      log.info('Telegram bot token changed or removed — stopping session');
      bot.stop();
    }
  }, TELEGRAM_BOT_CONFIG_WATCH_MS);

  try {
    await bot.start({
      onStart: () => log.info('Telegram bot polling active'),
    });
  } finally {
    clearInterval(configWatcher);
    currentBot = null;
  }
}

async function main(): Promise<void> {
  setupProcessShutdown();

  let idleLogged = false;
  let lastWakeSeen = 0;

  while (!shutdownRequested) {
    const token = (await getIntegrationConfig({ fresh: true })).telegram.botToken;

    if (!token) {
      if (!idleLogged) {
        log.info('Telegram bot idle — waiting for token in admin Settings → Telegram');
        idleLogged = true;
      }
      const wakeAt = await getTelegramBotWakeAt();
      const delayMs = resolveTelegramBotIdlePollMs(wakeAt, lastWakeSeen);
      lastWakeSeen = Math.max(lastWakeSeen, wakeAt);
      await sleep(delayMs);
      continue;
    }

    idleLogged = false;

    try {
      await runBotSession(token);
    } catch (err) {
      log.error({ err }, 'Telegram bot session crashed — retrying in 10s');
      await sleep(10_000);
      continue;
    }

    if (!shutdownRequested) {
      log.info('Telegram bot session ended — re-checking configuration');
    }
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  log.error(err, 'Fatal error in Telegram bot');
  process.exit(1);
});
