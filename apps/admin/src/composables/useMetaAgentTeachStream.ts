/**
 * SSE client for POST /meta-agent/teach/chat/stream (JWT via fetch).
 */

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

export type TeachStreamHandlers = {
  onStage?: (stage: TeachStreamStage) => void;
  onDelta?: (text: string) => void;
  onDone?: (payload: TeachStreamDone) => void;
  onError?: (payload: { error: string; fallback?: string; errorDetail?: string | null }) => void;
};

function apiBase(): string {
  const base = import.meta.env.VITE_API_URL || '/api';
  return base.replace(/\/$/, '');
}

/**
 * Parse SSE chunks from a ReadableStream (event: / data: lines).
 */
async function consumeSse(
  body: ReadableStream<Uint8Array>,
  handlers: {
    onEvent: (event: string, data: unknown) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length === 0) {
      eventName = 'message';
      return;
    }
    const raw = dataLines.join('\n');
    dataLines = [];
    const ev = eventName;
    eventName = 'message';
    try {
      handlers.onEvent(ev, JSON.parse(raw));
    } catch {
      handlers.onEvent(ev, raw);
    }
  };

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          flush();
          continue;
        }
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }
    flush();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
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
          handlers.onDone?.(payload as unknown as TeachStreamDone);
        } else if (event === 'error') {
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
}
