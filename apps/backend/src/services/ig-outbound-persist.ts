import { prisma, toInputJsonValue } from '../lib/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import { isIgNativeEchoContext } from '../lib/ig-native-echo.js';

function isUniqueIgMessageIdError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'P2002'
  );
}

export type PersistIgOutboundInput = {
  conversationId: string;
  sender: 'bot' | 'manager';
  text: string;
  igMessageIds?: string[] | null;
  createdAt?: Date;
  botFailureCode?: string | null;
  botFailureDetail?: string | null;
};

function graphMids(ids: string[] | null | undefined): string[] {
  return (ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
}

function platformSendContext(mids: string[]): Record<string, unknown> | undefined {
  if (mids.length <= 1) return undefined;
  return { platformSendMids: mids };
}

async function adoptEchoAsPlatformSend(
  existingId: string,
  input: PersistIgOutboundInput,
  platformCtx: Record<string, unknown> | undefined,
) {
  return prisma.message.update({
    where: { id: existingId },
    data: {
      sender: input.sender,
      text: input.text,
      igContext: toInputJsonValue(platformCtx) ?? Prisma.DbNull,
      botFailureCode: input.botFailureCode ?? null,
      botFailureDetail: input.botFailureDetail ?? null,
    },
  });
}

/**
 * Persist an IG message we just sent via Graph.
 * If the echo webhook won the race, reclassify that native-echo row instead of duplicating.
 */
export async function persistIgOutboundMessage(input: PersistIgOutboundInput) {
  const mids = graphMids(input.igMessageIds);
  const igMessageId = mids[0];
  const platformCtx = platformSendContext(mids);

  if (igMessageId) {
    const existing = await prisma.message.findUnique({ where: { igMessageId } });
    if (existing) {
      if (
        existing.conversationId === input.conversationId &&
        isIgNativeEchoContext(existing.igContext)
      ) {
        return adoptEchoAsPlatformSend(existing.id, input, platformCtx);
      }
      return existing;
    }
  }

  try {
    return await prisma.message.create({
      data: {
        conversationId: input.conversationId,
        direction: 'out',
        sender: input.sender,
        text: input.text,
        igMessageId,
        igContext: toInputJsonValue(platformCtx),
        createdAt: input.createdAt,
        botFailureCode: input.botFailureCode ?? undefined,
        botFailureDetail: input.botFailureDetail ?? undefined,
      },
    });
  } catch (err) {
    if (isUniqueIgMessageIdError(err) && igMessageId) {
      const existing = await prisma.message.findUnique({ where: { igMessageId } });
      if (existing) {
        if (
          existing.conversationId === input.conversationId &&
          isIgNativeEchoContext(existing.igContext)
        ) {
          return adoptEchoAsPlatformSend(existing.id, input, platformCtx);
        }
        return existing;
      }
    }
    throw err;
  }
}
