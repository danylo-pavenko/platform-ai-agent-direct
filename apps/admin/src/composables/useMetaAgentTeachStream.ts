/**
 * SSE client for POST /meta-agent/teach/chat/stream (JWT via fetch).
 */

import {
  resolveTeachStreamClose,
  type TeachStreamCloseKind,
} from '@/lib/teach-stream-close';
import { consumeSse } from '@/lib/teach-stream-sse';

export type { TeachStreamCloseKind };
export { resolveTeachStreamClose, consumeSse };

export type TeachStreamStage = {
  stage: string;
  label: string;
};

export type TeachStreamDone = {
  session: unknown;
  reply: string;
  suggestedDiffs?: Array<{ before: string; after: string; summary: string }>;
  suggestedDiff?: { before: string; after: string; summary: string } | null;
  parseFormat?: string;
  fallback?: string | null;
};

export type TeachStreamError = {
  error: string;
  fallback?: string;
  errorDetail?: string | null;
  /** Client aborted the request (Cancel / navigation). */
  aborted?: boolean;
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
          handlers.onDelta?.(String(payload.text ?? ''));
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
  });

  if (closeKind === 'silent_end') {
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
