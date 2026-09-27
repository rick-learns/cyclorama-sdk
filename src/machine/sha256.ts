// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// SHA-256 (FIPS 180-4), synchronous and dependency-free, so the emulator core can name the ROM a
// save state belongs to without node:crypto or WebCrypto (which is async in browsers). Its output
// equals roms/manifest.json `sha256` and replays' `romSha256` for the same bytes
// (tests/savestate.test.ts checks it against node:crypto).

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The 32-byte SHA-256 digest of `data`. */
export function sha256(data: Uint8Array): Uint8Array {
  const len = data.length;
  const tail = new Uint8Array(128);                       // the last one or two blocks, padded
  const fullBlocks = Math.floor(len / 64);                // blocks read straight from `data`
  const rest = len - fullBlocks * 64;
  tail.set(data.subarray(fullBlocks * 64));
  tail[rest] = 0x80;
  const tailBlocks = rest + 9 > 64 ? 2 : 1;
  const bits = len * 8;
  const end = tailBlocks * 64;
  tail[end - 1] = bits & 0xff; tail[end - 2] = (bits >>> 8) & 0xff; tail[end - 3] = (bits >>> 16) & 0xff; tail[end - 4] = (bits >>> 24) & 0xff;
  const hi = Math.floor(bits / 2 ** 32);
  tail[end - 5] = hi & 0xff; tail[end - 6] = (hi >>> 8) & 0xff; tail[end - 7] = (hi >>> 16) & 0xff; tail[end - 8] = (hi >>> 24) & 0xff;

  const H = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
  const W = new Uint32Array(64);
  const block = (src: Uint8Array, o: number) => {
    for (let i = 0; i < 16; i++, o += 4) W[i] = (src[o] << 24) | (src[o + 1] << 16) | (src[o + 2] << 8) | src[o + 3];
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  };
  for (let i = 0; i < fullBlocks; i++) block(data, i * 64);
  for (let i = 0; i < tailBlocks; i++) block(tail, i * 64);

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) { out[4 * i] = H[i] >>> 24; out[4 * i + 1] = (H[i] >>> 16) & 0xff; out[4 * i + 2] = (H[i] >>> 8) & 0xff; out[4 * i + 3] = H[i] & 0xff; }
  return out;
}

/** Lower-case hex of a byte string (a SHA-256 digest prints as 64 digits). */
export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
  return s;
}
