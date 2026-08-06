/**
 * Parse SSE chunks from a ReadableStream (event: / data: lines).
 */
export async function consumeSse(
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
