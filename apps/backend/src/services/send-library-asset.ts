/**
 * Host execution for send_library_asset — IG image or text link from a knowledge card.
 */
import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import {
  parseLibraryAttachments,
  pickLibraryAttachment,
} from '../lib/library-attachments.js';
import { sendImage, sendText } from './instagram.js';
import { persistIgOutboundMessage } from './ig-outbound-persist.js';
import { resolveAttachmentDeliveryUrl } from './library-assets.js';

const log = pino({ name: 'send-library-asset' });

export type SendLibraryAssetResult = {
  ok: boolean;
  message: string;
};

export async function executeSendLibraryAsset(opts: {
  conversationId: string;
  igUserId: string | null;
  channel: string;
  args: Record<string, unknown>;
}): Promise<SendLibraryAssetResult> {
  const slug =
    typeof opts.args.slug === 'string' ? opts.args.slug.trim().toLowerCase() : '';
  const attachmentId =
    typeof opts.args.attachment_id === 'string'
      ? opts.args.attachment_id.trim()
      : typeof opts.args.attachmentId === 'string'
        ? opts.args.attachmentId.trim()
        : '';

  if (!slug) {
    return { ok: false, message: '[send_library_asset] ПОМИЛКА: потрібен slug картки.' };
  }

  const article = await prisma.knowledgeArticle.findFirst({
    where: { slug, status: 'active' },
    select: { id: true, slug: true, title: true, attachments: true },
  });
  if (!article) {
    return {
      ok: false,
      message: `[send_library_asset] Немає активної картки «${slug}».`,
    };
  }

  const attachments = parseLibraryAttachments(article.attachments);
  const asset = pickLibraryAttachment(attachments, attachmentId || null);
  if (!asset) {
    return {
      ok: false,
      message: `[send_library_asset] У картці «${slug}» немає вкладення${attachmentId ? ` ${attachmentId}` : ''}.`,
    };
  }

  const deliveryUrl = resolveAttachmentDeliveryUrl(article.id, asset);
  if (!deliveryUrl) {
    return {
      ok: false,
      message: `[send_library_asset] Немає URL для «${asset.title}».`,
    };
  }

  if (opts.channel !== 'ig' || !opts.igUserId) {
    return {
      ok: false,
      message: '[send_library_asset] Надсилання медіа зараз лише для Instagram DM.',
    };
  }

  try {
    if (asset.type === 'image') {
      await sendImage(opts.igUserId, deliveryUrl);
      await persistIgOutboundMessage({
        conversationId: opts.conversationId,
        sender: 'bot',
        text: asset.title ? `📎 ${asset.title}` : '[фото з бібліотеки]',
        mediaAttachments: [
          {
            kind: 'image',
            igType: 'library_image',
            status: 'ready',
            storageKey: asset.storageKey || deliveryUrl,
          },
        ],
        mediaUrls: asset.storageKey ? [asset.storageKey] : [deliveryUrl],
      });
      log.info(
        { conversationId: opts.conversationId, slug, attachmentId: asset.id },
        'Library image sent via Graph',
      );
      return {
        ok: true,
        message: `[send_library_asset] Надіслано фото «${asset.title}» клієнту в Instagram.`,
      };
    }

    // file / link → short text with https URL (MVP)
    const label = asset.title || 'Файл';
    const text = `${label}\n${deliveryUrl}`;
    const igMessageIds = await sendText(opts.igUserId, text);
    await persistIgOutboundMessage({
      conversationId: opts.conversationId,
      sender: 'bot',
      text,
      igMessageIds,
    });
    return {
      ok: true,
      message: `[send_library_asset] Надіслано посилання «${label}» клієнту.`,
    };
  } catch (err) {
    log.error({ err, slug, attachmentId: asset.id }, 'send_library_asset failed');
    return {
      ok: false,
      message: `[send_library_asset] Не вдалося надіслати: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Collect all send_library_asset calls from a turn and execute in order. */
export async function flushSendLibraryAssetCalls(opts: {
  conversationId: string;
  igUserId: string | null;
  channel: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}): Promise<SendLibraryAssetResult[]> {
  const calls = opts.toolCalls.filter((tc) => tc.name === 'send_library_asset');
  const results: SendLibraryAssetResult[] = [];
  for (const call of calls) {
    results.push(
      await executeSendLibraryAsset({
        conversationId: opts.conversationId,
        igUserId: opts.igUserId,
        channel: opts.channel,
        args: call.args,
      }),
    );
  }
  return results;
}
