/**
 * Optional first-frame extract for Instagram Stories that arrive as video.
 * Uses system `ffmpeg` when present (tenant VPS usually has it); otherwise null.
 */

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

const log = pino({ name: 'media-video-frame' });

const FFMPEG_TIMEOUT_MS = 12_000;

function looksLikeVideoPath(filePath: string): boolean {
  return /\.(mp4|mov|webm|m4v)(?:$|\?)/i.test(filePath);
}

export function isVideoContentType(contentType: string | undefined | null): boolean {
  const ct = (contentType ?? '').toLowerCase();
  return ct.startsWith('video/');
}

/**
 * Extract a JPEG still near t=0.5s (or 0s fallback) for Claude vision.
 * @returns absolute path to .jpg, or null if ffmpeg missing / failed.
 */
export async function extractVideoFrameJpeg(
  videoAbsPath: string,
  options?: { timeoutMs?: number },
): Promise<string | null> {
  if (!looksLikeVideoPath(videoAbsPath)) return null;

  try {
    await access(videoAbsPath, constants.R_OK);
  } catch {
    return null;
  }

  const outPath = join(dirname(videoAbsPath), `${randomUUID()}.story-frame.jpg`);
  const timeoutMs = options?.timeoutMs ?? FFMPEG_TIMEOUT_MS;

  const run = (ss: string) =>
    new Promise<boolean>((resolve) => {
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        ss,
        '-i',
        videoAbsPath,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        outPath,
      ];
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(false);
      }, timeoutMs);
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8').slice(0, 400);
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(true);
        else {
          if (stderr.trim()) {
            log.debug({ stderr: stderr.trim(), ss }, 'ffmpeg frame extract failed');
          }
          resolve(false);
        }
      });
    });

  // Mid-first-second often has title text; fall back to t=0.
  for (const ss of ['0.4', '0']) {
    const ok = await run(ss);
    if (!ok) continue;
    try {
      await access(outPath, constants.R_OK);
      log.info({ videoAbsPath, outPath, ss }, 'Extracted Stories video frame for vision');
      return outPath;
    } catch {
      /* try next */
    }
  }

  log.warn({ videoAbsPath }, 'Could not extract Stories video frame (ffmpeg missing or failed)');
  return null;
}
