import pino from 'pino';
import { getIntegrationConfig } from '../lib/integration-config.js';

const log = pino({ name: 'instagram' });

const IG_API_URL = 'https://graph.instagram.com/v25.0/me/messages';
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const SPLIT_DELAY_MS = 200;

// ── Internal helper ─────────────────────────────────────────────────────

async function callIgApi(body: object): Promise<unknown> {
  const { meta } = await getIntegrationConfig();
  // Auth via Authorization: Bearer header per Meta's official Postman
  // collection — the same format that works for sending messages with curl.
  const url = IG_API_URL;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = INITIAL_BACKOFF_MS * 2 ** (attempt - 1); // 1s, 2s, 4s
      await sleep(delayMs);
      log.warn({ attempt, delayMs }, 'Retrying IG API call');
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${meta.igAccessToken}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log.error({ err: lastError, attempt }, 'IG API network error');
      continue;
    }

    if (res.ok) {
      const data: unknown = await res.json();
      return data;
    }

    // Retry on 429 (rate limit) or 5xx (server error)
    if (res.status === 429 || res.status >= 500) {
      const errorBody = await res.text().catch(() => '');
      lastError = new Error(
        `IG API returned ${res.status}: ${errorBody}`,
      );
      log.warn(
        { status: res.status, attempt, errorBody },
        'IG API retryable error',
      );
      continue;
    }

    // Non-retryable error - fail immediately
    const errorBody = await res.text().catch(() => '');
    throw new Error(
      `IG API returned ${res.status}: ${errorBody}`,
    );
  }

  throw lastError ?? new Error('IG API call failed after retries');
}

// ── Text splitting ──────────────────────────────────────────────────────

/**
 * Splits text into chunks that respect `maxLength`.
 * Strategy:
 *   1. Try to split at sentence boundaries (`. `, `! `, `? `).
 *   2. If a single sentence exceeds maxLength, split at word boundaries.
 *   3. Never returns empty strings.
 */
export function splitText(text: string, maxLength: number = 1000): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  // Split into sentences, keeping delimiters attached to the sentence.
  const sentences = splitIntoSentences(text);
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    // If adding this sentence would exceed the limit
    if (current.length + sentence.length > maxLength) {
      // Flush what we have so far
      if (current) {
        chunks.push(current);
        current = '';
      }

      // If the sentence itself is too long, split at word boundaries
      if (sentence.length > maxLength) {
        const wordChunks = splitAtWordBoundaries(sentence, maxLength);
        // All but last go directly to chunks
        for (let i = 0; i < wordChunks.length - 1; i++) {
          chunks.push(wordChunks[i]);
        }
        // Last partial sentence becomes current (may merge with next)
        current = wordChunks[wordChunks.length - 1];
      } else {
        current = sentence;
      }
    } else {
      current += sentence;
    }
  }

  if (current) {
    chunks.push(current);
  }

  // Filter out any accidental empty strings and trim edges
  return chunks
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Splits text into sentences, keeping the delimiter (e.g. ". ") attached
 * to the end of each sentence.
 */
function splitIntoSentences(text: string): string[] {
  const result: string[] = [];
  // Match sentence-ending patterns: ". ", "! ", "? " (delimiter stays with the sentence)
  const regex = /.*?(?:[.!?]\s|$)/gs;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match[0].length > 0) {
      result.push(match[0]);
    }
    // Prevent infinite loop on zero-length match
    if (match[0].length === 0) break;
  }

  // If regex left a remainder (text doesn't end with sentence delimiter)
  const joined = result.join('');
  if (joined.length < text.length) {
    result.push(text.slice(joined.length));
  }

  return result;
}

/**
 * Splits a long string at word boundaries so each chunk ≤ maxLength.
 */
function splitAtWordBoundaries(text: string, maxLength: number): string[] {
  const words = text.split(/(\s+)/); // keep whitespace tokens
  const chunks: string[] = [];
  let current = '';

  for (const word of words) {
    if (current.length + word.length > maxLength) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      // If a single word exceeds maxLength, force-break it
      if (word.length > maxLength) {
        for (let i = 0; i < word.length; i += maxLength) {
          chunks.push(word.slice(i, i + maxLength));
        }
        continue;
      }
    }
    current += word;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.filter((c) => c.length > 0);
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Sends a text message to an Instagram user via the Graph API.
 * If text exceeds 1000 chars, it is split into multiple messages
 * sent sequentially with a short delay between them.
 */
export async function sendText(
  recipientId: string,
  text: string,
): Promise<void> {
  const parts = splitText(text);

  for (let i = 0; i < parts.length; i++) {
    const body = {
      recipient: { id: recipientId },
      message: { text: parts[i] },
    };

    log.info(
      {
        recipientId,
        type: 'text',
        length: parts[i].length,
        part: parts.length > 1 ? `${i + 1}/${parts.length}` : undefined,
        status: 'sending',
      },
      'Sending IG text message',
    );

    await callIgApi(body);

    log.info(
      { recipientId, type: 'text', status: 'sent' },
      'IG text message sent',
    );

    // Delay between splits (skip after last message)
    if (parts.length > 1 && i < parts.length - 1) {
      await sleep(SPLIT_DELAY_MS);
    }
  }
}

/**
 * Sends an image attachment to an Instagram user via the Graph API.
 */
export async function sendImage(
  recipientId: string,
  imageUrl: string,
): Promise<void> {
  const body = {
    recipient: { id: recipientId },
    message: {
      attachment: {
        type: 'image',
        payload: {
          url: imageUrl,
          is_reusable: true,
        },
      },
    },
  };

  log.info(
    { recipientId, type: 'image', status: 'sending' },
    'Sending IG image message',
  );

  await callIgApi(body);

  log.info(
    { recipientId, type: 'image', status: 'sent' },
    'IG image message sent',
  );
}

// ── Utility ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
