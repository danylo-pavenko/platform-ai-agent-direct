import { prisma } from './prisma.js';
import { toAssignee, type ConversationAssignee } from './admin-user.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveConversationAssignee(
  handedOffTo: string | null | undefined,
): Promise<ConversationAssignee | null> {
  if (!handedOffTo || !UUID_RE.test(handedOffTo)) return null;
  const user = await prisma.adminUser.findUnique({
    where: { id: handedOffTo },
    select: {
      id: true,
      username: true,
      displayName: true,
      tgUsername: true,
    },
  });
  return user ? toAssignee(user) : null;
}

export async function resolveConversationAssignees(
  handedOffToIds: Array<string | null | undefined>,
): Promise<Map<string, ConversationAssignee>> {
  const ids = [
    ...new Set(
      handedOffToIds.filter(
        (id): id is string => typeof id === 'string' && UUID_RE.test(id),
      ),
    ),
  ];
  if (ids.length === 0) return new Map();

  const users = await prisma.adminUser.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      username: true,
      displayName: true,
      tgUsername: true,
    },
  });

  const map = new Map<string, ConversationAssignee>();
  for (const user of users) {
    map.set(user.id, toAssignee(user));
  }
  return map;
}
