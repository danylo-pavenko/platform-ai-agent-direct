/**
 * SSE client for POST /meta-agent/teach/chat/stream (JWT via fetch).
 */

import {
  resolveTeachStreamClose,
  type TeachStreamCloseKind,
} from '@/lib/teach-stream-close';
import { consumeSse } from '@/lib/teach-stream-sse';
import { visibleMetaAgentStreamText } from '@/lib/meta-agent-stream-display';

export type { TeachStreamCloseKind };
export { resolveTeachStreamClose, consumeSse, visibleMetaAgentStreamText };

export type TeachStreamStage = {
  stage: string;
  label: string;
};

export type TeachStreamDone = {
  session: unknown;
  reply: string;
  suggestedDiffs?: Array<{ before: string; after: string; summary: string }>;
  suggestedDiff?: { before: string; after: string; summary: string } | null;
  savedLibraryDrafts?: Array<{ id: string; slug: string; title?: string }>;
  parseFormat?: string;
  fallback?: string | null;
};

export type TeachStreamError = {
  error: string;
  fallback?: string;
  errorDetail?: string | null;
  /** Client aborted the request (Cancel / navigation). */
  aborted?: boolean;
  /**
   * Stream ended without done/error, but some reply text arrived —
   * UI should reload the session instead of treating as hard failure.
   */
  recoverable?: boolean;
};

export type TeachStreamHandlers = {
  onStage?: (stage: TeachStreamStage) => void;
  onDelta?: (text: string) => void;
  onDone?: (payload: TeachStreamDone) => void;
  onError?: (payload: TeachStreamError) => void;
};

function apiBase(): string {
  const base = import.meta.env.VITE_API_URL || '/api';
  return base.replace(/\/$/, '');
}

export async function streamTeachChat(
  body: {
    message: string;
    conversationId?: string;
    conversationContext?: Array<{ role: 'user' | 'assistant'; content: string }>;
    useFullPrompt?: boolean;
  },
  handlers: TeachStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const token = localStorage.getItem('token');
  const res = await fetch(`${apiBase()}/meta-agent/teach/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let error = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) error = j.error;
    } catch {
      /* ignore */
    }
    handlers.onError?.({ error });
    return;
  }

  if (!res.body) {
    handlers.onError?.({ error: 'Порожня відповідь стріму' });
    return;
  }

  let gotDone = false;
  let gotError = false;
  let accumulatedRaw = '';
  let lastVisible = '';

  await consumeSse(
    res.body,
    {
      onEvent: (event, data) => {
        const payload = data as Record<string, unknown>;
        if (event === 'stage') {
          handlers.onStage?.({
            stage: String(payload.stage ?? ''),
            label: String(payload.label ?? ''),
          });
        } else if (event === 'delta') {
          const chunk = String(payload.text ?? '');
          // Backend may already send display-only deltas; keep client-side strip as defense.
          accumulatedRaw += chunk;
          const visible = visibleMetaAgentStreamText(accumulatedRaw);
          const next = visible.slice(lastVisible.length);
          lastVisible = visible;
          if (next) handlers.onDelta?.(next);
        } else if (event === 'done') {
          gotDone = true;
          handlers.onDone?.(payload as unknown as TeachStreamDone);
        } else if (event === 'error') {
          gotError = true;
          handlers.onError?.({
            error: String(payload.error ?? 'Помилка мета-агента'),
            fallback: typeof payload.fallback === 'string' ? payload.fallback : undefined,
            errorDetail:
              payload.errorDetail === null || typeof payload.errorDetail === 'string'
                ? (payload.errorDetail as string | null)
                : null,
          });
        }
      },
    },
    signal,
  );

  const closeKind = resolveTeachStreamClose({
    gotDone,
    gotError,
    aborted: signal?.aborted === true,
    gotPartialText: lastVisible.trim().length > 0,
  });

  if (closeKind === 'partial_ok') {
    handlers.onError?.({
      error: 'Стрім обірвався — перевіряю збережену відповідь…',
      recoverable: true,
    });
  } else if (closeKind === 'silent_end') {
    handlers.onError?.({
      error: 'Стрім обірвався без відповіді. Спробуйте ще раз.',
    });
  } else if (closeKind === 'aborted') {
    handlers.onError?.({
      error: 'Запит скасовано',
      aborted: true,
    });
  }
}
