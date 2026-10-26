/** Hamming distance between two equal-length hex strings (pHash: 16 hex = 64 bit). */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length || !/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) {
    throw new RangeError('pHash harus hex dengan panjang sama.');
  }
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

export const NEAR_DUPLICATE_MAX_DISTANCE = 6;

export function isNearDuplicate(a: string, b: string, max = NEAR_DUPLICATE_MAX_DISTANCE): boolean {
  return hammingDistance(a, b) <= max;
}
