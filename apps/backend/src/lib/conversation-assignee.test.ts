import { describe, expect, it, vi, beforeEach } from 'vitest';

const { findUnique, findMany } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock('./prisma.js', () => ({
  prisma: {
    adminUser: {
      findUnique,
      findMany,
    },
  },
}));

import {
  resolveConversationAssignee,
  resolveConversationAssignees,
} from './conversation-assignee.js';

describe('resolveConversationAssignee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for non-uuid handedOffTo', async () => {
    expect(await resolveConversationAssignee('123456789')).toBeNull();
    expect(await resolveConversationAssignee(null)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('loads assignee by AdminUser id', async () => {
    findUnique.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      username: 'manager_a',
      displayName: 'Анна',
      tgUsername: 'anna',
    });
    const assignee = await resolveConversationAssignee(
      '11111111-1111-1111-1111-111111111111',
    );
    expect(assignee).toEqual({
      id: '11111111-1111-1111-1111-111111111111',
      username: 'manager_a',
      displayName: 'Анна',
      tgUsername: 'anna',
    });
  });
});

describe('resolveConversationAssignees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('batches unique uuids', async () => {
    findMany.mockResolvedValue([
      {
        id: '11111111-1111-1111-1111-111111111111',
        username: 'm1',
        displayName: null,
        tgUsername: null,
      },
    ]);
    const map = await resolveConversationAssignees([
      '11111111-1111-1111-1111-111111111111',
      'not-a-uuid',
      '11111111-1111-1111-1111-111111111111',
      null,
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ['11111111-1111-1111-1111-111111111111'] } },
      select: {
        id: true,
        username: true,
        displayName: true,
        tgUsername: true,
      },
    });
    expect(map.size).toBe(1);
  });
});
