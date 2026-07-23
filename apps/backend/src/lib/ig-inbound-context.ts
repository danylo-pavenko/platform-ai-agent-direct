/**
 * Instagram inbound context: story replies, story mentions, emoji reactions.
 * Stored on Message.igContext (JSONB) and injected into the Claude user turn.
 */

export type IgInboundKind =
  | 'story_reply'
  | 'story_mention'
  | 'inline_reply'
  | 'reaction';

export interface IgStoryRef {
  id?: string;
  url?: string;
  /** Local storage key after CDN download (story replies only). */
  storageKey?: string;
}

export interface IgReactionData {
  targetMid: string;
  action: 'react' | 'unreact';
  reaction?: string;
  emoji?: string;
  /** Short snippet of the message that was reacted to (bot/manager/client). */
  targetSnippet?: string;
  targetSender?: string;
}

export interface IgInboundContext {
  kind: IgInboundKind;
  story?: IgStoryRef;
  /** Mid of the DM being replied to (inline reply, not story). */
  replyToMid?: string;
  reaction?: IgReactionData;
  [key: string]: unknown;
}

const REACTION_EMOJI: Record<string, string> = {
  love: '❤️',
  like: '👍',
  laugh: '😆',
  wow: '😮',
  sad: '😢',
  angry: '😠',
  other: '✨',
};

export function reactionDisplay(reaction?: string, emoji?: string): string {
  if (emoji?.trim()) return emoji.trim();
  if (reaction && REACTION_EMOJI[reaction]) return REACTION_EMOJI[reaction];
  if (reaction) return reaction;
  return '👍';
}

export function parseIgInboundContext(value: unknown): IgInboundContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const kind = v.kind;
  if (
    kind !== 'story_reply' &&
    kind !== 'story_mention' &&
    kind !== 'inline_reply' &&
    kind !== 'reaction'
  ) {
    return undefined;
  }
  return value as IgInboundContext;
}

/** Ukrainian prompt header so the sales/booking agent responds appropriately. */
export function buildIgInboundContextHeader(ctx: IgInboundContext): string {
  if (ctx.kind === 'story_reply') {
    const parts = [
      '[Клієнт відповів на вашу Instagram Stories]',
      'Це реакція/відповідь саме на Stories, а не звичайний холодний DM.',
      'Відповідай тепло й коротко: подякуй, підхопи тему Stories, запропонуй допомогу (товар / запис / питання).',
      'Не починай з довгого скрипта продажів — спочатку визнай Stories.',
    ];
    if (ctx.story?.id) parts.push(`Story id: ${ctx.story.id}`);
    if (ctx.story?.url && !ctx.story.storageKey) {
      parts.push('Кадр Stories може бути доступний у вкладенні (vision) — використай його для контексту.');
    }
    return parts.join('\n');
  }

  if (ctx.kind === 'story_mention') {
    return [
      '[Клієнт згадав вас у своїй Instagram Stories (story mention)]',
      'Медіа Stories ефемерне — не вигадуй деталі кадру, якщо не бачиш зображення.',
      'Подякуй за згадку коротко й по-людськи, запропонуй написати сюди в Direct, якщо потрібна допомога.',
    ].join('\n');
  }

  if (ctx.kind === 'inline_reply') {
    return [
      '[Клієнт відповів цитатою на попереднє повідомлення в Direct]',
      'Врахуй контекст цитати; відповідай по суті того повідомлення.',
    ].join('\n');
  }

  // reaction
  const emoji = reactionDisplay(ctx.reaction?.reaction, ctx.reaction?.emoji);
  const parts = [
    `[Клієнт поставив реакцію ${emoji} на ваше повідомлення в Direct]`,
  ];
  if (ctx.reaction?.targetSnippet) {
    const snip =
      ctx.reaction.targetSnippet.length > 160
        ? `${ctx.reaction.targetSnippet.slice(0, 160)}…`
        : ctx.reaction.targetSnippet;
    parts.push(`Повідомлення, на яке зреагували: «${snip}»`);
  }
  parts.push(
    'Відповідай коротко й тепло (1–2 речення): визнай реакцію, за потреби м’яко продовж діалог.',
    'Не повторюй весь попередній скрипт і не ігноруй реакцію як «порожній» вхід.',
  );
  return parts.join('\n');
}

export function enrichUserMessageWithIgContext(
  messageText: string,
  ctx: IgInboundContext | undefined,
): string | null {
  if (!ctx) return null;
  const header = buildIgInboundContextHeader(ctx);
  const trimmed = messageText.trim();
  if (!trimmed) {
    if (ctx.kind === 'reaction') return header;
    if (ctx.kind === 'story_mention') {
      return `${header}\n\n(Клієнт надіслав згадку без додаткового тексту.)`;
    }
    if (ctx.kind === 'story_reply') {
      return `${header}\n\n(Клієнт відповів на Stories без тексту — можливо стікер/лайк. Відреагуй коротко.)`;
    }
    return header;
  }
  return `${header}\n\nПовідомлення клієнта: "${trimmed}"`;
}
