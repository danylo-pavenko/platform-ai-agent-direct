/**
 * Collapses duplicate / noisy message rows for admin display and for Claude
 * conversation history, without mutating the database.
 *
 * Rules (in order, on messages sorted ascending by createdAt):
 * 1. Same non-null igMessageId → keep first only (import + webhook ID drift).
 * 2. Consecutive rows with same direction + sender + normalised text → keep
 *    first only (double bot send, client tap-spam, echo-like duplicates).
 * 3. System rows are never merged with neighbours.
 */

export interface MessageDedupeRow {
  id?: string;
  igMessageId?: string | null;
  direction: string;
  sender: string;
  text: string | null;
  createdAt: Date | string;
}

function normaliseText(text: string | null): string {
  return (text ?? '').trim().replace(/\s+/g, ' ');
}

function byCreatedAtThenId<T extends MessageDedupeRow>(a: T, b: T): number {
  const ta = new Date(a.createdAt).getTime();
  const tb = new Date(b.createdAt).getTime();
  if (ta !== tb) return ta - tb;
  const ida = a.id ?? '';
  const idb = b.id ?? '';
  return ida.localeCompare(idb);
}

export function dedupeConversationMessages<T extends MessageDedupeRow>(messages: T[]): T[] {
  if (messages.length <= 1) return [...messages];

  const sorted = [...messages].sort(byCreatedAtThenId);
  const seenIg = new Set<string>();
  const out: T[] = [];

  for (const m of sorted) {
    if (m.igMessageId) {
      if (seenIg.has(m.igMessageId)) continue;
      seenIg.add(m.igMessageId);
    }

    const prev = out[out.length - 1];
    if (prev) {
      const sys = prev.sender === 'system' || m.sender === 'system';
      if (
        !sys &&
        prev.direction === m.direction &&
        prev.sender === m.sender &&
        normaliseText(prev.text) === normaliseText(m.text) &&
        normaliseText(m.text).length > 0
      ) {
        continue;
      }
    }

    out.push(m);
  }

  return out;
}
