import './config.js'; // load dotenv first

import pino from 'pino';
import { config } from './config.js';
import { getIntegrationConfig } from './lib/integration-config.js';
import { Bot } from 'grammy';
import { prisma } from './lib/prisma.js';
import { sendText } from './services/instagram.js';

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

// ── Bot setup ──

async function main() {
  const cfg = await getIntegrationConfig();
  if (!cfg.telegram.botToken) {
    log.warn('TELEGRAM_BOT_TOKEN not configured - Telegram bot will not start');
    return;
  }

  const bot = new Bot(cfg.telegram.botToken);

// Set bot commands menu (visible in Telegram UI)
bot.api.setMyCommands([
  { command: 'start', description: 'Привітання та інформація' },
  { command: 'login', description: 'Авторизація менеджера' },
  { command: 'conversations', description: 'Активні розмови' },
  { command: 'takeover', description: 'Взяти розмову (ID)' },
  { command: 'return', description: 'Повернути розмову боту (ID)' },
  { command: 'close', description: 'Закрити розмову (ID)' },
  { command: 'help', description: 'Список команд' },
]).catch((err) => log.warn({ err }, 'Failed to set bot commands'));

// ── Helpers ──

function isManagerAuthorized(tgUserId: number): Promise<boolean> {
  return prisma.adminUser.findFirst({
    where: { tgUserId: String(tgUserId) },
  }).then((u) => !!u);
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
/login <пароль> - Авторизація менеджера
/conversations - Список активних розмов
/takeover <ID> - Взяти розмову собі
/return <ID> - Повернути розмову боту
/close <ID> - Закрити розмову
/help - Ця довідка

Після авторизації ви будете отримувати:
• Сповіщення про ескалації (клієнт просить менеджера)
• Картки замовлень з кнопками Підтвердити / Відхилити
• Повідомлення від клієнтів у режимі хендофу`;

// /start - Welcome message
bot.command('start', async (ctx) => {
  try {
    const authorized = await isManagerAuthorized(ctx.from!.id);

    if (authorized) {
      await ctx.reply(
        `Вітаю! 👋\n\nВи авторизовані як менеджер ${config.BRAND_NAME}.\nОберіть дію:`,
        buildMenuKeyboard(),
      );
    } else {
      await ctx.reply(
        `Вітаю! 👋\n\nЦе бот менеджера магазину ${config.BRAND_NAME}.\n\nДля початку роботи авторизуйтесь:\n/login <ваш пароль>\n\nПісля авторизації ви зможете:\n• Отримувати сповіщення про ескалації\n• Керувати розмовами з клієнтами\n• Підтверджувати замовлення`,
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
      const lastRun = await prisma.keycrmSyncRun.findFirst({
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

// /login PASSWORD - Manager authentication
bot.command('login', async (ctx) => {
  try {
    // Try to delete the message containing the password
    ctx.deleteMessage().catch(() => {});

    const password = ctx.match?.trim();

    if (!password) {
      await ctx.reply('Використання: /login <пароль>');
      return;
    }

    const { telegram: tgCfg } = await getIntegrationConfig();
    if (password !== tgCfg.adminPassword) {
      await ctx.reply('Невірний пароль.');
      return;
    }

    const tgUserId = String(ctx.from!.id);

    // Find first admin user (prefer owner, then any) and link tgUserId
    const adminUser = await prisma.adminUser.findFirst({
      where: { role: 'owner' },
    });

    const targetUser = adminUser ?? await prisma.adminUser.findFirst();

    if (!targetUser) {
      await ctx.reply('Не знайдено адмін-користувача в базі.');
      return;
    }

    await prisma.adminUser.update({
      where: { id: targetUser.id },
      data: { tgUserId },
    });

    log.info({ tgUserId, adminUserId: targetUser.id }, 'Manager authenticated via Telegram');
    await ctx.reply(
      `Авторизовано! ✅\n\nВи тепер отримуватимете сповіщення про ескалації та замовлення.\n\nОберіть дію:`,
      buildMenuKeyboard(),
    );
  } catch (err) {
    log.error(err, 'Error in /login command');
    await ctx.reply('Сталася помилка. Спробуйте пізніше.');
  }
});

// /conversations - List active conversations
bot.command('conversations', async (ctx) => {
  try {
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

    if (conversation.state === 'handoff') {
      await ctx.reply('Розмова вже в режимі менеджера.');
      return;
    }

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        state: 'handoff',
        handedOffTo: String(ctx.from!.id),
        handoffReason: 'Менеджер взяв вручну',
      },
    });

    const id = shortId(conversation.id);
    log.info({ conversationId: conversation.id, tgUserId: ctx.from!.id }, 'Conversation taken over');
    await ctx.reply(`Розмову #${id} взято. Нові повідомлення клієнта будуть пересилатися сюди.`);
  } catch (err) {
    log.error(err, 'Error in /takeover command');
    await ctx.reply('Сталася помилка. Спробуйте пізніше.');
  }
});

// /return CONV_ID - Return conversation to bot
bot.command('return', async (ctx) => {
  try {
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
      const conversationId = data.substring('takeover:'.length);

      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
      });

      if (!conversation) {
        await ctx.answerCallbackQuery({ text: 'Розмову не знайдено.' });
        return;
      }

      if (conversation.state === 'handoff') {
        await ctx.answerCallbackQuery({ text: 'Розмова вже в режимі менеджера.' });
        return;
      }

      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          state: 'handoff',
          handedOffTo: String(ctx.from.id),
          handoffReason: 'Менеджер взяв вручну',
        },
      });

      const username = ctx.from.username || ctx.from.first_name || String(ctx.from.id);
      log.info({ conversationId, tgUserId: ctx.from.id }, 'Conversation taken over via callback');

      await ctx.answerCallbackQuery({ text: 'Взято!' });
      await ctx.editMessageText(`\u{2705} Взято менеджером @${username}`);
    } else if (data.startsWith('return:')) {
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
        },
      });

      log.info({ conversationId, tgUserId: ctx.from.id }, 'Conversation returned to bot via callback');

      await ctx.answerCallbackQuery({ text: 'Повернуто боту!' });
      await ctx.editMessageText('\u{2705} Повернуто боту');
    } else if (data.startsWith('approve:')) {
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
        data: { status: 'cancelled' },
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

  bot.start({
    onStart: () => log.info('Telegram bot started'),
  });

  // ── Graceful shutdown ──

  const shutdown = () => {
    log.info('Shutting down Telegram bot...');
    bot.stop();
    prisma.$disconnect();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.error(err, 'Fatal error in Telegram bot');
  process.exit(1);
});
