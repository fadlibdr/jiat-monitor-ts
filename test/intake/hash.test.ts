import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { hammingDistance, isNearDuplicate } from '../../src/domain/hamming.js';
import { perceptualHash, sha256Hex } from '../../src/intake/hash.js';

/** A synthetic "receipt": dark text-like bars on white, deterministic from a seed. */
async function receipt(seed: number, opts: { width?: number; quality?: number; format?: 'jpeg' | 'png' } = {}): Promise<Buffer> {
  const w = 400; const h = 600;
  const raw = Buffer.alloc(w * h, 255);
  let s = seed;
  for (let line = 0; line < 20; line++) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const len = 80 + (s % 280);
    const y0 = 40 + line * 26;
    for (let y = y0; y < y0 + 10; y++) for (let x = 30; x < 30 + len; x++) raw[y * w + x] = 30;
  }
  let img = sharp(raw, { raw: { width: w, height: h, channels: 1 } });
  if (opts.width) img = img.resize(opts.width);
  return opts.format === 'png' ? img.png().toBuffer() : img.jpeg({ quality: opts.quality ?? 85 }).toBuffer();
}

describe('sha256Hex', () => {
  it('is the 64-hex SHA-256 of the exact bytes, including an empty file', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(Buffer.alloc(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('perceptualHash (V9)', () => {
  it('returns 16 hex chars and is deterministic', async () => {
    const img = await receipt(1);
    const a = await perceptualHash(img);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await perceptualHash(img)).toBe(a);
  });

  it('the same photo re-encoded, resized or converted stays a near-duplicate (≤ 6 bits)', async () => {
    const base = await perceptualHash(await receipt(7));
    for (const variant of [await receipt(7, { quality: 40 }), await receipt(7, { width: 250 }), await receipt(7, { format: 'png' })]) {
      const d = hammingDistance(base, await perceptualHash(variant));
      expect(d).toBeLessThanOrEqual(6);
      expect(isNearDuplicate(base, await perceptualHash(variant))).toBe(true);
    }
  });

  it('a different receipt is far away', async () => {
    const d = hammingDistance(await perceptualHash(await receipt(7)), await perceptualHash(await receipt(99)));
    expect(d).toBeGreaterThan(6);
  });

  it('bytes that are not an image, or no bytes at all, are refused (the job then answers "tidak terbaca")', async () => {
    await expect(perceptualHash(Buffer.from('not an image'))).rejects.toThrow();
    await expect(perceptualHash(Buffer.alloc(0))).rejects.toThrow();
  });
});
