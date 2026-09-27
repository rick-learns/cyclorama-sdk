// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Cue (AV-3105) audio chip — docs/spec-notes.md §4, §8.10-14, §9.39-40, §10.48-50; manual chapter 6.
// Expected values below are hand-computed from the spec formulas (see comments), not from the
// implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Cue } from "../src/machine/audio.ts";
import { reg } from "../src/hw/registers.ts";
import { MASTER_PER_SAMPLE } from "../src/machine/types.ts";

const A = (name: string) => reg(name).addr;
const S = MASTER_PER_SAMPLE; // 448

function fresh(): Cue { const c = new Cue(); c.reset(); return c; }
/** Produce the next n samples and return them. */
function run(c: Cue, n: number): Int16Array {
  c.advanceTo(S * (c.sampleCount + n));
  return c.takeSamples();
}
const w = (c: Cue, name: string, v: number) => c.write(A(name), v);
/** Set up voice i and key it on. env = start volume | dir<<4 | period<<5. */
function voice(c: Cue, i: number, freq: number, wave: number, env: number) {
  w(c, `V${i}FREQ`, freq); w(c, `V${i}WAVE`, wave); w(c, `V${i}ENV`, env); w(c, `V${i}CTRL`, 1);
}
/** Invert out = (2s-15) * vol * mv * 2 for a single sounding voice. */
const stepsOf = (pcm: Int16Array, vol: number, mv: number) =>
  Array.from(pcm, x => { const u = x / (2 * vol * mv); assert.ok(Number.isInteger(u), `pcm ${x}`); return (u + 15) / 2; });
function fnv(a: Int16Array): number {
  let h = 0x811c9dc5;
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193) >>> 0;
  return h;
}

// ---------------------------------------------------------------- registers

const AUDIO_REGS = [0, 1, 2, 3].flatMap(i => [`V${i}FREQ`, `V${i}WAVE`, `V${i}ENV`, `V${i}CTRL`])
  .concat([0, 1, 2, 3, 4, 5, 6, 7].map(i => `WAVE${i}`), ["MASTERVOL"]);

test("reset: every audio register reads 0", () => {
  const c = fresh();
  for (const n of AUDIO_REGS) assert.equal(c.read(A(n)), 0, n);
  assert.equal(c.sampleCount, 0);
});

test("reset() after activity restores the reset state", () => {
  const c = fresh();
  for (const n of AUDIO_REGS) w(c, n, 0xffff);
  run(c, 2000);
  c.reset();
  for (const n of AUDIO_REGS) assert.equal(c.read(A(n)), 0, n);
  assert.equal(c.sampleCount, 0);
  assert.equal(c.takeSamples().length, 0);
  // Behaves exactly like a fresh chip afterwards.
  const d = fresh();
  for (const x of [c, d]) { w(x, "MASTERVOL", 15); voice(x, 3, 0x1234, 0, 15); voice(x, 0, 601, 4, 0x2f); }
  assert.equal(fnv(run(c, 3000)), fnv(run(d, 3000)));
});

test("register widths: undefined bits read 0", () => {
  const c = fresh();
  for (const n of AUDIO_REGS) w(c, n, 0xffff);
  for (let i = 0; i < 4; i++) {
    assert.equal(c.read(A(`V${i}FREQ`)), 0xffff);
    assert.equal(c.read(A(`V${i}WAVE`)), i < 3 ? 7 : 1);
    assert.equal(c.read(A(`V${i}ENV`)), 0xff);
    assert.equal(c.read(A(`V${i}CTRL`)), 0x0f01); // keyed on (bit 0), volume 15 from ENV (bits 11-8)
  }
  for (let i = 0; i < 8; i++) assert.equal(c.read(A(`WAVE${i}`)), 0xffff);
  assert.equal(c.read(A("MASTERVOL")), 0x000f);
  // Unassigned addresses in the Cue range read 0 and ignore writes.
  for (let a = 0xf0b2; a <= 0xf0be; a += 2) { c.write(a, 0xffff); assert.equal(c.read(a), 0); }
});

test("CTRL read value: bit 0 keyed, bits 11-8 current volume", () => {
  const c = fresh();
  w(c, "V1ENV", 0x09);            // volume 9, hold
  assert.equal(c.read(A("V1CTRL")), 0);  // ENV alone does nothing
  w(c, "V1CTRL", 1);
  assert.equal(c.read(A("V1CTRL")), 0x0901);
  w(c, "V1CTRL", 0);
  assert.equal(c.read(A("V1CTRL")), 0);
  w(c, "V1CTRL", 0xfffe);         // bit 0 clear: key-off, other bits ignored
  assert.equal(c.read(A("V1CTRL")), 0);
});

test("byte writes: storage registers write only the addressed half", () => {
  const c = fresh();
  c.write(A("V0FREQ"), 0x34, 0);
  assert.equal(c.read(A("V0FREQ")), 0x0034);
  c.write(A("V0FREQ"), 0x12, 1);
  assert.equal(c.read(A("V0FREQ")), 0x1234);
  c.write(A("V0FREQ"), 0xab, 0);
  assert.equal(c.read(A("V0FREQ")), 0x12ab);
  c.write(A("WAVE3"), 0xcd, 1);
  assert.equal(c.read(A("WAVE3")), 0xcd00);
  c.write(A("WAVE3"), 0xef, 0);
  assert.equal(c.read(A("WAVE3")), 0xcdef);
  // High halves of narrow registers are undefined bits: ignored, read 0, low half untouched.
  w(c, "MASTERVOL", 9);
  c.write(A("MASTERVOL"), 0xff, 1);
  assert.equal(c.read(A("MASTERVOL")), 9);
  w(c, "V2ENV", 0x8c);
  c.write(A("V2ENV"), 0xff, 1);
  assert.equal(c.read(A("V2ENV")), 0x8c);
  c.write(A("V2WAVE"), 0xfe, 0);
  assert.equal(c.read(A("V2WAVE")), 6);
});

test("byte writes: CTRL acts only on a low-byte or word write; high-byte writes are ignored", () => {
  const c = fresh();
  w(c, "V0ENV", 0x0c);
  c.write(A("V0CTRL"), 0x01, 1);            // high byte: ignored
  assert.equal(c.read(A("V0CTRL")), 0);
  c.write(A("V0CTRL"), 0x01, 0);            // low byte: key-on
  assert.equal(c.read(A("V0CTRL")), 0x0c01);
  c.write(A("V0CTRL"), 0x00, 1);            // high byte 0: must NOT key off
  assert.equal(c.read(A("V0CTRL")), 0x0c01);
  c.write(A("V0CTRL"), 0x00, 0);            // low byte 0: key-off
  assert.equal(c.read(A("V0CTRL")), 0);
  // Also for the noise voice.
  w(c, "V3ENV", 5);
  c.write(A("V3CTRL"), 0xff, 1);
  assert.equal(c.read(A("V3CTRL")), 0);
  c.write(A("V3CTRL"), 0xff, 0);
  assert.equal(c.read(A("V3CTRL")), 0x0501);
});

test("high-byte CTRL write does not restart a playing voice", () => {
  const a = fresh(), b = fresh();
  for (const c of [a, b]) { w(c, "MASTERVOL", 1); voice(c, 0, 1000, 4, 15); run(c, 37); }
  a.write(A("V0CTRL"), 0x01, 1);            // ignored on a
  assert.deepEqual(run(a, 100), run(b, 100));
});

// ---------------------------------------------------------------- timing

test("timestamps: sample k is produced at master cycle 448*(k+1)", () => {
  const c = fresh();
  c.advanceTo(447);
  assert.equal(c.takeSamples().length, 0);
  c.advanceTo(448);
  assert.equal(c.takeSamples().length, 1);
  const d = fresh();
  d.advanceTo(448 * 10);
  assert.equal(d.takeSamples().length, 10);
  assert.equal(d.sampleCount, 10);
  d.advanceTo(448 * 10 + 447);
  assert.equal(d.takeSamples().length, 0);
  d.advanceTo(448 * 5);                     // going backwards produces nothing
  assert.equal(d.takeSamples().length, 0);
  d.advanceTo(448 * 11);
  assert.equal(d.takeSamples().length, 1);
});

test("takeSamples returns only the samples since the last call; split advances equal one advance", () => {
  const a = fresh(), b = fresh();
  for (const c of [a, b]) { w(c, "MASTERVOL", 15); voice(c, 0, 601, 2, 0x8c); voice(c, 3, 0x3000, 1, 0x2f); }
  a.advanceTo(S * 3000);
  const whole = a.takeSamples();
  const parts: number[] = [];
  for (let t = 0; t <= S * 3000; t += 1000) { b.advanceTo(t); parts.push(...b.takeSamples()); }
  b.advanceTo(S * 3000); parts.push(...b.takeSamples());
  assert.equal(whole.length, 3000);
  assert.deepEqual(Array.from(whole), parts);
});

test("silence at reset: output is 0 until something is keyed on with MASTERVOL set", () => {
  const c = fresh();
  assert.ok(run(c, 1000).every(x => x === 0));
  voice(c, 0, 601, 2, 15);                  // MASTERVOL still 0
  assert.ok(run(c, 1000).every(x => x === 0));
});

// ---------------------------------------------------------------- waveforms
// FREQ = 2048 (0x0800): the j-th sample after key-on (j = 0,1,...) sees P = 2048*(j+1) mod 65536,
// i.e. P>>11 = m = (j+1) mod 32. MASTERVOL 1, volume 15 -> pcm = (2s-15)*15*2 = 60s - 450.

const M = Array.from({ length: 32 }, (_, j) => (j + 1) % 32);

test("first samples after key-on, each waveform, exact PCM values (FREQ 0x0800, vol 15, MASTERVOL 1)", () => {
  // Hand-computed: P = 2048, 4096, 6144, 8192 for the first four samples.
  const expected: Record<number, number[]> = {
    0: [450, 450, 450, -450],   // pulse 12.5%: 15 while P < 8192
    1: [450, 450, 450, 450],    // pulse 25%: P < 16384
    2: [450, 450, 450, 450],    // pulse 50%
    3: [450, 450, 450, 450],    // pulse 75%
    4: [-390, -330, -270, -210],// triangle: t = 1,2,3,4 -> s = 1..4 -> 60s-450
    5: [-450, -390, -390, -330],// sawtooth: P>>12 = 0,1,1,2
    7: [0, 0, 0, 0],            // silent
  };
  for (const [wave, exp] of Object.entries(expected)) {
    const c = fresh();
    w(c, "MASTERVOL", 1);
    voice(c, 0, 0x0800, +wave, 15);
    assert.deepEqual(Array.from(run(c, 4)), exp, `wave ${wave}`);
  }
  // Wavetable with the manual's sine table (6.4): samples 1..4 are 9, 10, 12, 13.
  const c = fresh();
  w(c, "MASTERVOL", 1);
  w(c, "WAVE0", 0xca98); w(c, "WAVE1", 0xfeed);
  voice(c, 0, 0x0800, 6, 15);
  assert.deepEqual(Array.from(run(c, 4)), [90, 150, 270, 330]);
});

test("pulse duties across a full cycle", () => {
  // s = 15 iff m < {4, 8, 16, 24}[k]
  const thresholds = [4, 8, 16, 24];
  for (let k = 0; k < 4; k++) {
    const c = fresh();
    w(c, "MASTERVOL", 1);
    voice(c, 1, 0x0800, k, 15);
    const s = stepsOf(run(c, 64), 15, 1);
    const exp = M.map(m => (m < thresholds[k] ? 15 : 0));
    assert.deepEqual(s, [...exp, ...exp], `duty ${k}`);
    assert.equal(exp.filter(x => x === 15).length, [4, 8, 16, 24][k]);
  }
});

test("triangle across a full cycle", () => {
  const c = fresh();
  w(c, "MASTERVOL", 1);
  voice(c, 2, 0x0800, 4, 15);
  assert.deepEqual(stepsOf(run(c, 32), 15, 1),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0]);
});

test("sawtooth across a full cycle", () => {
  const c = fresh();
  w(c, "MASTERVOL", 1);
  voice(c, 0, 0x0800, 5, 15);
  assert.deepEqual(stepsOf(run(c, 32), 15, 1),
    [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 0]);
});

test("wavetable: nibble order (sample 4i in bits 3-0 of WAVEi) and the manual's sine table", () => {
  const sine = [8, 9, 10, 12, 13, 14, 14, 15, 15, 15, 14, 14, 13, 12, 10, 9, 8, 6, 5, 3, 2, 1, 1, 0, 0, 0, 1, 1, 2, 3, 5, 6];
  const packed = [0xca98, 0xfeed, 0xeeff, 0x9acd, 0x3568, 0x0112, 0x1100, 0x6532];
  const c = fresh();
  w(c, "MASTERVOL", 1);
  packed.forEach((v, i) => w(c, `WAVE${i}`, v));
  voice(c, 0, 0x0800, 6, 15);
  assert.deepEqual(stepsOf(run(c, 32), 15, 1), M.map(m => sine[m]));

  // Samples 0..31 set to their own index (mod 16) -> sample m reads m & 15.
  const d = fresh();
  w(d, "MASTERVOL", 1);
  for (let i = 0; i < 8; i++) {
    const n = (j: number) => (4 * i + j) & 15;
    w(d, `WAVE${i}`, n(0) | (n(1) << 4) | (n(2) << 8) | (n(3) << 12));
  }
  voice(d, 1, 0x0800, 6, 15);
  assert.deepEqual(stepsOf(run(d, 32), 15, 1), M.map(m => m & 15));
});

test("wavetable: a WAVE write affects a playing voice from the next sample; all voices share it", () => {
  const c = fresh();
  w(c, "MASTERVOL", 1);
  voice(c, 0, 0, 6, 15);                    // FREQ 0: P stays 0 -> always sample 0
  assert.deepEqual(stepsOf(run(c, 2), 15, 1), [0, 0]);
  c.write(A("WAVE0"), 0x0b, 0);             // byte write, sample 0 = B
  assert.deepEqual(stepsOf(run(c, 2), 15, 1), [11, 11]);
  voice(c, 1, 0, 6, 15);                    // second voice reads the same table
  assert.deepEqual(Array.from(run(c, 1)), [2 * (2 * 11 - 15) * 15 * 2]);
});

test("FREQ 0 holds the step value; the voice still sounds at its volume", () => {
  const c = fresh();
  w(c, "MASTERVOL", 2);
  voice(c, 0, 0, 5, 7);                     // saw at P = 0 -> s = 0
  assert.ok(run(c, 100).every(x => x === (0 - 15) * 7 * 2 * 2));
  // Change FREQ mid-note: P advances from where it is.
  w(c, "V0FREQ", 0x1000);
  assert.deepEqual(stepsOf(run(c, 3), 7, 2), [1, 2, 3]);
  w(c, "V0FREQ", 0);
  assert.deepEqual(stepsOf(run(c, 3), 7, 2), [3, 3, 3]);
});

test("silent waveform contributes 0 whatever the volume; key-on still reads as keyed", () => {
  const c = fresh();
  w(c, "MASTERVOL", 15);
  voice(c, 2, 601, 7, 15);
  assert.ok(run(c, 2000).every(x => x === 0));
  assert.equal(c.read(A("V2CTRL")), 0x0f01);
});

test("key-on sets P to 0; FREQ just below/above 65536 wraps", () => {
  const c = fresh();
  w(c, "MASTERVOL", 1);
  voice(c, 0, 0xf000, 5, 15);               // P = F000, E000, D000 -> saw 15, 14, 13
  assert.deepEqual(stepsOf(run(c, 3), 15, 1), [15, 14, 13]);
  w(c, "V0CTRL", 1);                        // restart: P = 0 again
  assert.deepEqual(stepsOf(run(c, 3), 15, 1), [15, 14, 13]);
});

// ---------------------------------------------------------------- noise

// From the spec formula, starting from L = 7FFF (see manual 6.5, #lfsr-long / #lfsr-short):
const LONG20 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15, 15, 15, 15, 15, 15];
const SHORT20 = [0, 0, 0, 0, 0, 0, 15, 15, 15, 15, 15, 15, 0, 15, 15, 15, 15, 15, 0, 0];

/** Noise at V3FREQ FFFF keyed on at reset: Q = FFFF after sample 0 (no carry); each later sample carries. */
function noiseSteps(mode: number, n: number): number[] {
  const c = fresh();
  w(c, "MASTERVOL", 1);
  voice(c, 3, 0xffff, mode, 15);
  const s = stepsOf(run(c, n + 1), 15, 1);
  assert.equal(s[0], 0);                    // seed 7FFF, bit 0 = 1 -> s = 0, no shift yet
  return s.slice(1);                        // s after shift 1, 2, ...
}

test("noise: first 20 outputs after key-on, long mode", () => {
  assert.deepEqual(noiseSteps(0, 20), LONG20);
});

test("noise: first 20 outputs after key-on, short mode", () => {
  assert.deepEqual(noiseSteps(1, 20), SHORT20);
});

test("noise: long sequence has period 32767, short sequence period 127", () => {
  const long = noiseSteps(0, 2 * 32767);
  for (let i = 0; i < 32767; i++) if (long[i] !== long[i + 32767]) assert.fail(`long mismatch at ${i}`);
  // 32767 = 7 * 31 * 151: the sequence must not repeat with any proper maximal divisor.
  for (const d of [32767 / 7, 32767 / 31, 32767 / 151]) {
    let same = true;
    for (let i = 0; i < 32767 && same; i++) same = long[i] === long[i + d];
    assert.equal(same, false, `period divides ${d}`);
  }
  const short = noiseSteps(1, 2 * 127);
  assert.deepEqual(short.slice(0, 127), short.slice(127));
  assert.ok(short.slice(0, 127).includes(0) && short.slice(0, 127).includes(15)); // 127 is prime
});

test("noise: shifts once per accumulator carry (V3FREQ 0x4000 -> one shift every 4 samples)", () => {
  const c = fresh();
  w(c, "MASTERVOL", 1);
  voice(c, 3, 0x4000, 0, 15);
  // Q: 4000, 8000, C000, 0000(carry), ... -> shifts on samples 3, 7, 11, ...
  const s = stepsOf(run(c, 4 * 20), 15, 1);
  for (let j = 0; j < 80; j++) {
    const shifts = (j + 1) >> 2;             // shifts completed by sample j
    assert.equal(s[j], shifts === 0 ? 0 : LONG20[shifts - 1], `sample ${j}`);
  }
});

test("noise: key-on reseeds L but does not reset Q (spec §8.12)", () => {
  const c = fresh();
  w(c, "MASTERVOL", 1);
  voice(c, 3, 0x8000, 0, 15);
  run(c, 1);                                // Q = 8000
  w(c, "V3CTRL", 0);                        // key-off: Q keeps running
  run(c, 2);                                // Q = 0000 (carry), 8000
  w(c, "V3CTRL", 1);                        // L = 7FFF, Q stays 8000
  // Next sample carries at once (shift 1), then every 2 samples: sample j has had floor(j/2)+1 shifts.
  // (Had Q been reset to 0, shifts would land on odd j instead; the 0->15 edge at shift 15 moves.)
  const s = stepsOf(run(c, 40), 15, 1);
  assert.deepEqual(s, Array.from({ length: 40 }, (_, j) => LONG20[j >> 1]));
  assert.equal(s[28], 15);                  // shift 15
  assert.equal(s[27], 0);                   // shift 14
});

// ---------------------------------------------------------------- envelopes
// FREQ 0 pulse: P = 0 -> s = 15 constant; MASTERVOL 1 -> pcm = 15*vol*2 = 30*vol.

const vols = (pcm: Int16Array) => Array.from(pcm, x => x / 30);

test("envelope ticks fall on samples 749, 1499, ... (p = 1, falling from 15)", () => {
  const c = fresh();
  w(c, "MASTERVOL", 1);
  voice(c, 0, 0, 2, 0x2f);                  // period 1, falling, volume 15
  const v = vols(run(c, 2250));
  assert.ok(v.slice(0, 749).every(x => x === 15));
  assert.ok(v.slice(749, 1499).every(x => x === 14));
  assert.ok(v.slice(1499, 2249).every(x => x === 13));
  assert.equal(v[2249], 12);
  assert.equal(c.read(A("V0CTRL")), 0x0c01);
});

test("envelope: first step on the p-th global tick after key-on (p = 3, key-on mid-interval)", () => {
  const c = fresh();
  w(c, "MASTERVOL", 1);
  run(c, 100);
  voice(c, 1, 0, 2, 0x7a);                  // period 3, rising, volume 10
  // global ticks at 749, 1499, 2249 (3rd after key-on), 2999, 3749, 4499 (6th)
  const v = vols(run(c, 4500 - 100));        // samples 100..4499
  const at = (k: number) => v[k - 100];
  assert.equal(at(2248), 10);
  assert.equal(at(2249), 11);
  assert.equal(at(4498), 11);
  assert.equal(at(4499), 12);
});

test("envelope: a key-on just before a tick sample counts that tick as the first", () => {
  const c = fresh();
  w(c, "MASTERVOL", 1);
  run(c, 749);                              // samples 0..748 done
  voice(c, 0, 0, 2, 0x28);                  // p = 1, falling, volume 8
  const v = vols(run(c, 751));               // samples 749..1499
  assert.equal(v[0], 7);                     // tick at 749 is the first after key-on
  assert.equal(v[749], 7);
  assert.equal(v[750], 6);                   // sample 1499
});

test("envelope: key-on restarts the voice's tick count", () => {
  const c = fresh();
  w(c, "MASTERVOL", 1);
  voice(c, 0, 0, 2, 0x4f);                  // p = 2, falling, 15
  run(c, 1000);                             // one tick seen (749)
  w(c, "V0CTRL", 1);                        // restart at count 0
  const v = vols(run(c, 2250 - 1000));       // samples 1000..2249
  assert.equal(v[1499 - 1000], 15);          // 1st tick after restart: no step
  assert.equal(v[2249 - 1000], 14);          // 2nd tick: step
});

test("envelope stops at 0 (falling) and 15 (rising); CTRL bit 0 stays 1", () => {
  const c = fresh();
  w(c, "MASTERVOL", 1);
  voice(c, 0, 0, 2, 0x22);                  // p = 1, falling from 2
  voice(c, 1, 0, 2, 0x3e);                  // p = 1, rising from 14
  run(c, 750 * 5);
  assert.equal(c.read(A("V0CTRL")), 0x0001);
  assert.equal(c.read(A("V1CTRL")), 0x0f01);
  assert.ok(run(c, 750 * 3).every(x => x === 15 * 15 * 2));
});

test("envelope: period 0 holds the volume", () => {
  const c = fresh();
  w(c, "MASTERVOL", 1);
  voice(c, 0, 0, 2, 0x19);                  // p = 0, rising bit set, volume 9
  assert.ok(vols(run(c, 750 * 10)).every(x => x === 9));
  assert.equal(c.read(A("V0CTRL")), 0x0901);
});

test("envelope: ENV written while a note sounds takes effect only at the next key-on", () => {
  const c = fresh();
  w(c, "MASTERVOL", 1);
  voice(c, 0, 0, 2, 0x2f);                  // p = 1 falling from 15
  w(c, "V0ENV", 0x05);                      // hold at 5 — not yet
  const v = vols(run(c, 750));
  assert.equal(v[748], 15);
  assert.equal(v[749], 14);
  w(c, "V0CTRL", 1);
  assert.ok(vols(run(c, 1500)).every(x => x === 5));
});

// ---------------------------------------------------------------- spec §10.48-50 (write timing)

test("§10.48: a write at master cycle t affects exactly the samples with timestamp > t", () => {
  const c = fresh();
  voice(c, 0, 0, 2, 15);                    // constant s 15, vol 15 -> 450 per MASTERVOL unit
  c.advanceTo(448 * 5);                     // sample 4 is due at exactly 448*5: computed first
  w(c, "MASTERVOL", 1);
  c.advanceTo(448 * 7 + 100);               // write between sample timestamps
  w(c, "MASTERVOL", 2);
  c.advanceTo(448 * 9);
  assert.deepEqual(Array.from(c.takeSamples()), [0, 0, 0, 0, 0, 450, 450, 900, 900]);
});

test("§10.49: envelope ticks counted are those of samples after the key-on write", () => {
  // Key-on at t = 448*749: tick sample 749 (timestamp 448*750) comes after the write -> counted.
  const a = fresh();
  w(a, "MASTERVOL", 1);
  a.advanceTo(448 * 749); a.takeSamples();
  voice(a, 0, 0, 2, 0x2a);                  // p 1, falling, volume 10
  assert.deepEqual(vols(run(a, 1)), [9]);   // sample 749
  // Key-on at t = 448*750: sample 749 (and its tick) is already done -> first step on sample 1499.
  const b = fresh();
  w(b, "MASTERVOL", 1);
  b.advanceTo(448 * 750); b.takeSamples();
  voice(b, 0, 0, 2, 0x2a);
  const v = vols(run(b, 750));              // samples 750..1499
  assert.ok(v.slice(0, 749).every(x => x === 10));
  assert.equal(v[749], 9);
});

test("§10.50: CTRL reads reflect key-on/key-off immediately, before any sample", () => {
  const c = fresh();
  voice(c, 2, 601, 2, 0x2f);
  run(c, 1600);                             // two ticks: volume 13
  assert.equal(c.read(A("V2CTRL")), 0x0d01);
  w(c, "V2CTRL", 0);
  assert.equal(c.read(A("V2CTRL")), 0x0000);
  w(c, "V2ENV", 0x07);
  w(c, "V2CTRL", 1);
  assert.equal(c.read(A("V2CTRL")), 0x0701);
  assert.equal(c.sampleCount, 1600);
});

// ---------------------------------------------------------------- key-off

test("key-off: volume 0 at once, voice silent, envelope stopped; key-on starts from ENV again", () => {
  const c = fresh();
  w(c, "MASTERVOL", 1);
  voice(c, 0, 601, 2, 0x2f);
  run(c, 10);
  w(c, "V0CTRL", 0);
  assert.equal(c.read(A("V0CTRL")), 0);
  assert.ok(run(c, 3000).every(x => x === 0));
  assert.equal(c.read(A("V0CTRL")), 0);      // no envelope movement while off
  w(c, "V0CTRL", 1);
  assert.equal(c.read(A("V0CTRL")), 0x0f01);
  // Restart is identical to a fresh key-on at a matching envelope phase? P restarts at 0:
  const first = run(c, 3);
  assert.deepEqual(stepsOf(first, 15, 1), [15, 15, 15]);
});

// ---------------------------------------------------------------- mixing

test("MASTERVOL scales the mix linearly; mix sums the four voices", () => {
  const base: number[] = [];
  for (let mv = 0; mv <= 15; mv++) {
    const c = fresh();
    w(c, "MASTERVOL", mv);
    voice(c, 0, 0, 2, 15);                  // s 15 -> +225
    voice(c, 1, 0, 5, 7);                   // saw P=0 -> s 0 -> -105
    voice(c, 2, 0, 4, 3);                   // triangle P=0 -> s 0 -> -45
    voice(c, 3, 0, 0, 4);                   // L = 7FFF -> s 0 -> -60
    base.push(run(c, 1)[0]);
  }
  const sum = 225 - 105 - 45 - 60;
  assert.deepEqual(base, Array.from({ length: 16 }, (_, mv) => sum * mv * 2));
});

test("full-scale output: exactly +-13500 * 2 with all voices at volume 15 and MASTERVOL 15", () => {
  const lo = fresh();
  w(lo, "MASTERVOL", 15);
  for (let i = 0; i < 3; i++) voice(lo, i, 0, 5, 15);   // saw at P 0 -> s 0
  voice(lo, 3, 0, 0, 15);                               // s 0
  assert.equal(run(lo, 1)[0], -27000);

  const hi = fresh();
  w(hi, "MASTERVOL", 15);
  for (let i = 0; i < 3; i++) voice(hi, i, 0, 2, 15);   // pulse at P 0 -> s 15
  voice(hi, 3, 0xffff, 0, 15);                          // s 15 after shift 15 (LONG20[14])
  const out = run(hi, 16);
  assert.equal(out[0], (225 * 3 - 225) * 15 * 2);
  assert.equal(out[15], 27000);

  // Nothing ever exceeds the range, whatever is playing.
  const r = fresh();
  w(r, "MASTERVOL", 15);
  voice(r, 0, 601, 4, 0x3f); voice(r, 1, 1203, 3, 0x2f); voice(r, 2, 77, 6, 15); voice(r, 3, 0x7777, 1, 15);
  for (let i = 0; i < 8; i++) w(r, `WAVE${i}`, 0xf0f0 ^ (i * 0x1111));
  for (const x of run(r, 48000)) assert.ok(x >= -27000 && x <= 27000);
});

test("A4 (FREQ 601) sounds at ~439.64 Hz: rising zero crossings over one second", () => {
  const c = fresh();
  w(c, "MASTERVOL", 15);
  voice(c, 0, 601, 2, 15);
  const pcm = run(c, 47940);
  const rising: number[] = [];
  for (let i = 1; i < pcm.length; i++) if (pcm[i - 1] < 0 && pcm[i] > 0) rising.push(i);
  // Cycles in one second = 601 * 47940 / 65536 = 439.63 -> 439 complete cycles begin inside it.
  assert.ok(rising.length === 439 || rising.length === 440, `${rising.length}`);
  const rate = 47940.34;
  const hz = (rising.length - 1) / ((rising[rising.length - 1] - rising[0]) / rate);
  assert.ok(Math.abs(hz - 439.64) < 0.1, `measured ${hz.toFixed(3)} Hz`);
});

// ---------------------------------------------------------------- state

function busy(c: Cue) {
  w(c, "MASTERVOL", 13);
  for (let i = 0; i < 8; i++) w(c, `WAVE${i}`, 0x1234 * (i + 1) & 0xffff);
  voice(c, 0, 601, 6, 0x3c);                // wavetable, rising p 1
  voice(c, 1, 902, 4, 0x6f);                // triangle, falling p 3
  voice(c, 2, 1203, 1, 0xaf);               // pulse 25%, falling p 5
  voice(c, 3, 0x2345, 1, 0x4c);             // short noise, falling p 2
}

test("serialize round trip mid-note continues bit-identically", () => {
  const a = fresh();
  busy(a);
  a.advanceTo(S * 1234 + 100);              // mid-sample timestamp
  a.takeSamples();
  const snap = a.serialize();
  const b = new Cue();
  b.deserialize(snap);
  assert.equal(b.sampleCount, a.sampleCount);
  for (const n of AUDIO_REGS) assert.equal(b.read(A(n)), a.read(A(n)), n);
  assert.deepEqual(b.serialize(), snap);
  for (let k = 0; k < 5; k++) {
    const t = S * (2000 + 3000 * k);
    a.advanceTo(t); b.advanceTo(t);
    const x = a.takeSamples(), y = b.takeSamples();
    assert.equal(x.length, y.length);
    assert.equal(fnv(x), fnv(y));
    if (k === 1) for (const c of [a, b]) { w(c, "V3CTRL", 1); w(c, "V1WAVE", 5); }
  }
  // The restored chip matches one that was never serialised.
  const ref = fresh();
  busy(ref);
  ref.advanceTo(S * 1234 + 100); ref.advanceTo(S * 5000); ref.takeSamples();
  for (const c of [ref]) { w(c, "V3CTRL", 1); w(c, "V1WAVE", 5); }
  const c2 = new Cue(); c2.deserialize(snap); c2.advanceTo(S * 5000); c2.takeSamples();
  w(c2, "V3CTRL", 1); w(c2, "V1WAVE", 5);
  ref.advanceTo(S * 9000); c2.advanceTo(S * 9000);
  assert.equal(fnv(ref.takeSamples()), fnv(c2.takeSamples()));
});

test("deserialize rejects a foreign blob", () => {
  const c = new Cue();
  assert.throws(() => c.deserialize(new Uint8Array(10)));
  const s = fresh().serialize();
  s[0] ^= 0xff;
  assert.throws(() => c.deserialize(s));
});

test("determinism: two instances given the same writes produce identical samples", () => {
  const hashes = [0, 1].map(() => {
    const c = fresh();
    busy(c);
    let all = 0;
    for (let f = 0; f < 60; f++) {
      c.advanceTo(358416 * (f + 1));
      if (f % 7 === 3) w(c, `V${f % 4}CTRL`, f & 1);
      if (f % 5 === 1) w(c, "V0FREQ", 300 + f * 11);
      all = (Math.imul(all ^ fnv(c.takeSamples()), 0x01000193) >>> 0);
    }
    return all;
  });
  assert.equal(hashes[0], hashes[1]);
});

test("throughput: one second of four-voice audio well under real time", () => {
  const c = fresh();
  busy(c);
  const t0 = performance.now();
  for (let f = 1; f <= 60; f++) { c.advanceTo(358416 * f); c.takeSamples(); }
  const ms = performance.now() - t0;
  assert.ok(ms < 250, `${ms.toFixed(1)} ms for 1 s of audio`);
});
