import { createHash } from 'node:crypto';
import sharp from 'sharp';

/** V8: exact duplicate, checked before OCR so a resent photo costs nothing (LLD §5). */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const N = 32; // working size
const K = 8; // low-frequency block → 64 bits

/** cos((2x+1)uπ / 2N) for u < K, x < N */
const COS: number[][] = Array.from({ length: K }, (_, u) =>
  Array.from({ length: N }, (__, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N))));

/**
 * V9: 64-bit perceptual hash as 16 hex chars (the classic DCT pHash, same construction as the
 * Python `imagehash.phash`): EXIF-rotate, grayscale, 32×32, 2-D DCT-II, keep the 8×8 lowest
 * frequencies, bit = coefficient > median. Re-encoding, resizing or mild compression of the same
 * photo moves only a few bits, so hamming ≤ 6 marks a near-duplicate (domain/hamming.ts).
 * Throws on bytes that are not a decodable image.
 */
export async function perceptualHash(image: Buffer): Promise<string> {
  const px = await sharp(image, { failOn: 'error' }).rotate().greyscale().resize(N, N, { fit: 'fill' }).raw().toBuffer();
  if (px.length !== N * N) throw new Error(`pHash: ${px.length} bytes, expected ${N * N} grayscale pixels`);

  const coeffs: number[] = [];
  for (let v = 0; v < K; v++) {
    for (let u = 0; u < K; u++) {
      let s = 0;
      for (let y = 0; y < N; y++) {
        const cy = COS[v]![y]!;
        const row = y * N;
        for (let x = 0; x < N; x++) s += px[row + x]! * COS[u]![x]! * cy;
      }
      coeffs.push(s);
    }
  }
  const sorted = [...coeffs].sort((a, b) => a - b);
  const median = (sorted[31]! + sorted[32]!) / 2;

  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    let nibble = 0;
    for (let b = 0; b < 4; b++) nibble = (nibble << 1) | (coeffs[i + b]! > median ? 1 : 0);
    hex += nibble.toString(16);
  }
  return hex;
}
