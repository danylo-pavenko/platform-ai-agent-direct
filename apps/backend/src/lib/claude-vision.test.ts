import { describe, expect, it } from 'vitest';
import {
  buildClaudeVisionStdin,
  imageMimeFromPath,
  isClaudeVisionImagePath,
} from './claude-vision.js';

describe('imageMimeFromPath', () => {
  it('maps common image extensions', () => {
    expect(imageMimeFromPath('/tmp/a.jpg')).toBe('image/jpeg');
    expect(imageMimeFromPath('/tmp/a.JPEG')).toBe('image/jpeg');
    expect(imageMimeFromPath('/tmp/a.png')).toBe('image/png');
    expect(imageMimeFromPath('/tmp/a.webp')).toBe('image/webp');
  });

  it('rejects video and unknown types', () => {
    expect(imageMimeFromPath('/tmp/a.mp4')).toBeNull();
    expect(imageMimeFromPath('/tmp/a.bin')).toBeNull();
    expect(isClaudeVisionImagePath('/tmp/a.mp4')).toBe(false);
  });
});

describe('buildClaudeVisionStdin', () => {
  it('returns plain text stdin when there are no images', async () => {
    const result = await buildClaudeVisionStdin('Hello', undefined);
    expect(result.useStreamJsonInput).toBe(false);
    expect(result.stdin).toBe('Hello');
    expect(result.attachedImages).toEqual([]);
  });

  it('embeds jpeg as stream-json image content block', async () => {
    const bytes = Buffer.from('fake-image-bytes');
    const result = await buildClaudeVisionStdin('Look at this', ['/uploads/shirt.jpg'], {
      readFileFn: async () => bytes,
    });

    expect(result.useStreamJsonInput).toBe(true);
    expect(result.attachedImages).toEqual(['/uploads/shirt.jpg']);
    expect(result.skippedPaths).toEqual([]);

    const msg = JSON.parse(result.stdin.trim()) as {
      type: string;
      message: { role: string; content: Array<Record<string, unknown>> };
    };
    expect(msg.type).toBe('user');
    expect(msg.message.role).toBe('user');
    expect(msg.message.content[0]).toEqual({ type: 'text', text: 'Look at this' });
    expect(msg.message.content[1]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: bytes.toString('base64'),
      },
    });
  });

  it('skips video with a text note and does not enable stream-json', async () => {
    const result = await buildClaudeVisionStdin('Ping', ['/uploads/clip.mp4'], {
      readFileFn: async () => Buffer.from('x'),
    });

    expect(result.useStreamJsonInput).toBe(false);
    expect(result.attachedImages).toEqual([]);
    expect(result.skippedPaths).toEqual(['/uploads/clip.mp4']);
    expect(result.stdin).toContain('не вдалося вкласти в vision');
  });

  it('skips oversized images that would exceed stdin budget', async () => {
    const huge = Buffer.alloc(2000, 1);
    const result = await buildClaudeVisionStdin('Ping', ['/uploads/big.png'], {
      readFileFn: async () => huge,
      maxStdinBytes: 500,
    });

    expect(result.useStreamJsonInput).toBe(false);
    expect(result.attachedImages).toEqual([]);
    expect(result.skippedPaths).toEqual(['/uploads/big.png']);
  });
});
