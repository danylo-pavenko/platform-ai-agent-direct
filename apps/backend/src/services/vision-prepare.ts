import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import pino from 'pino';
import {
  isClaudeVisionImagePath,
  isClaudeVisionPdfPath,
} from '../lib/claude-vision.js';

const log = pino({ name: 'vision-prepare' });

/** Anthropic long-edge recommendation for document/receipt screenshots. */
export const VISION_MAX_LONG_EDGE = 1568;

export const VISION_JPEG_QUALITY = 82;

export type VisionResizeFn = (inputPath: string, outputPath: string) => Promise<void>;

function visionJpegSibling(absPath: string): string {
  const ext = extname(absPath);
  const base = ext ? absPath.slice(0, -ext.length) : absPath;
  return `${base}.vision.jpg`;
}

async function defaultResizeWithSharp(inputPath: string, outputPath: string): Promise<void> {
  const sharpMod = await import('sharp');
  const sharp = sharpMod.default;
  await sharp(inputPath)
    .rotate()
    .resize({
      width: VISION_MAX_LONG_EDGE,
      height: VISION_MAX_LONG_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: VISION_JPEG_QUALITY, mozjpeg: true })
    .toFile(outputPath);
}

/**
 * Downscale huge IG screenshots (receipts/PDFs photographed on a phone)
 * so CLI vision stdin + Claude tokens fit in the customer timeout.
 * PDFs pass through as document blocks. Failures keep the original path.
 */
export async function prepareVisionMediaForClaude(
  absPaths: string[],
  options?: { resizeImage?: VisionResizeFn },
): Promise<string[]> {
  const resize = options?.resizeImage ?? defaultResizeWithSharp;
  const out: string[] = [];

  for (const absPath of absPaths) {
    if (isClaudeVisionPdfPath(absPath)) {
      out.push(absPath);
      continue;
    }
    if (!isClaudeVisionImagePath(absPath)) {
      out.push(absPath);
      continue;
    }

    const sibling = visionJpegSibling(absPath);
    try {
      const existing = await stat(sibling).catch(() => null);
      if (existing?.isFile() && existing.size > 0) {
        out.push(sibling);
        continue;
      }
      await resize(absPath, sibling);
      const prepared = await stat(sibling);
      if (prepared.size > 0) {
        log.info(
          { src: absPath, dest: sibling, bytes: prepared.size },
          'Vision image downscaled for Claude',
        );
        out.push(sibling);
        continue;
      }
    } catch (err) {
      log.warn({ err, absPath }, 'Vision downscale skipped — using original image');
    }
    out.push(absPath);
  }

  return out;
}

export const VISION_MEDIA_HINT =
  '[Вкладення доступне в vision (фото або PDF). Якщо це платіжка/квитанція — прочитай суму, дату, отримувача, призначення. Якщо товар — назву, колір, розмір, ціну. Не кажи, що не бачиш файл.]';
