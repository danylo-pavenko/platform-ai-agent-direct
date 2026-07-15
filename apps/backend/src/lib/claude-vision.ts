import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

/** Anthropic Messages API image media types accepted by Claude vision. */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Leave headroom under Claude Code CLI stdin cap (~10MB as of v2.1.128). */
export const MAX_VISION_STDIN_BYTES = 8 * 1024 * 1024;

export function imageMimeFromPath(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? null;
}

export function isClaudeVisionImagePath(filePath: string): boolean {
  return imageMimeFromPath(filePath) !== null;
}

export type ClaudeVisionContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    };

export interface ClaudeVisionStdin {
  /** CLI needs `--input-format stream-json` when true. */
  useStreamJsonInput: boolean;
  stdin: string;
  /** Absolute paths successfully embedded as vision blocks. */
  attachedImages: string[];
  /** Absolute paths skipped (video, unknown type, size, read error). */
  skippedPaths: string[];
}

/**
 * Build stdin for Claude Code headless mode.
 *
 * Claude Code CLI has no `--image` flag. Vision goes through
 * `--input-format stream-json` with Anthropic image content blocks.
 */
export async function buildClaudeVisionStdin(
  promptText: string,
  imagePaths: string[] | undefined,
  options?: {
    readFileFn?: (path: string) => Promise<Buffer>;
    maxStdinBytes?: number;
  },
): Promise<ClaudeVisionStdin> {
  const read = options?.readFileFn ?? ((p: string) => readFile(p));
  const maxBytes = options?.maxStdinBytes ?? MAX_VISION_STDIN_BYTES;
  const paths = imagePaths ?? [];

  if (paths.length === 0) {
    return {
      useStreamJsonInput: false,
      stdin: promptText,
      attachedImages: [],
      skippedPaths: [],
    };
  }

  const content: ClaudeVisionContentBlock[] = [{ type: 'text', text: promptText }];
  const attachedImages: string[] = [];
  const skippedPaths: string[] = [];
  let approxBytes = Buffer.byteLength(promptText, 'utf8') + 256;

  for (const filePath of paths) {
    const mediaType = imageMimeFromPath(filePath);
    if (!mediaType) {
      skippedPaths.push(filePath);
      continue;
    }

    try {
      const buf = await read(filePath);
      // base64 expands ~4/3; count encoded size for the stdin budget
      const encodedBytes = Math.ceil(buf.length * 1.37) + 128;
      if (approxBytes + encodedBytes > maxBytes) {
        skippedPaths.push(filePath);
        continue;
      }
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: buf.toString('base64'),
        },
      });
      attachedImages.push(filePath);
      approxBytes += encodedBytes;
    } catch {
      skippedPaths.push(filePath);
    }
  }

  if (attachedImages.length === 0) {
    const note =
      skippedPaths.length > 0
        ? '\n\n[Клієнт надіслав медіафайл, але його не вдалося вкласти в vision (відео / зайвий розмір / помилка читання). Попросити чітке фото товару або назву з сайту.]'
        : '';
    return {
      useStreamJsonInput: false,
      stdin: `${promptText}${note}`,
      attachedImages: [],
      skippedPaths,
    };
  }

  let text = promptText;
  if (skippedPaths.length > 0) {
    text +=
      '\n\n[Частину вкладень пропущено (відео або завеликий файл). Аналізуй зображення нижче.]';
    content[0] = { type: 'text', text };
  }

  const line = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  });

  return {
    useStreamJsonInput: true,
    stdin: `${line}\n`,
    attachedImages,
    skippedPaths,
  };
}
