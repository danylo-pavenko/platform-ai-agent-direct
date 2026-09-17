import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareVisionMediaForClaude, VISION_MEDIA_HINT } from './vision-prepare.js';

describe('prepareVisionMediaForClaude', () => {
  it('passes PDFs through and resizes images via injected fn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vision-prep-'));
    const jpg = join(dir, 'shot.jpg');
    await writeFile(jpg, Buffer.from('fake-jpeg'));
    const resized: string[] = [];
    const out = await prepareVisionMediaForClaude(
      [jpg, join(dir, 'receipt.pdf'), join(dir, 'clip.mp4')],
      {
        resizeImage: async (input, output) => {
          resized.push(`${input}->${output}`);
          await writeFile(output, Buffer.from('jpeg'));
        },
      },
    );
    expect(resized).toHaveLength(1);
    expect(resized[0]).toContain('shot.jpg');
    expect(resized[0]).toContain('.vision.jpg');
    expect(out[0]).toBe(join(dir, 'shot.vision.jpg'));
    expect(out[1]).toContain('receipt.pdf');
    expect(out[2]).toContain('clip.mp4');
  });

  it('keeps original image when resize throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vision-prep-'));
    const png = join(dir, 'a.png');
    await writeFile(png, Buffer.from('x'));
    const out = await prepareVisionMediaForClaude([png], {
      resizeImage: async () => {
        throw new Error('sharp missing');
      },
    });
    expect(out).toEqual([png]);
  });
});

describe('VISION_MEDIA_HINT', () => {
  it('asks to read receipts', () => {
    expect(VISION_MEDIA_HINT).toMatch(/платіжк/i);
  });
});
