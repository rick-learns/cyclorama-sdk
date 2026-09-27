// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Cue (AV-3105) audio chip — docs/spec-notes.md §4, §8.10-14, §9.39-40, §10.48-50; manual chapter 6.
// Integer-only state. Register writes apply to the state immediately (§10.48-50); the machine calls
// advanceTo(t) before a write at time t so the write takes effect from the first sample after t.
import { MASTER_PER_SAMPLE, type AudioCore } from "./types.ts";

const SAMPLES_PER_TICK = 750;
const PULSE_LIMIT = [8192, 16384, 32768, 49152];
const MAGIC = 0x31455543; // "CUE1" little-endian
const STATE_BYTES = 4 + 8 + 2 + 1 + 4 * 9 + 3 * 2 + 2 + 2 + 8 * 2;

/** Offsets within the Cue register block (address & 0x3e). */
const OFF_WAVETABLE = 0x20, OFF_MASTERVOL = 0x30;

export class Cue implements AudioCore {
  // Registers
  private freq = new Uint16Array(4);
  private wave = new Uint8Array(4);        // bits 2-0 (voice 3: bit 0)
  private env = new Uint8Array(4);         // bits 7-0, read at key-on
  private wavetable = new Uint16Array(8);  // WAVE0-7 as written
  private table = new Uint8Array(32);      // unpacked nibbles of WAVE0-7
  private masterVol = 0;
  // Voice state
  private keyed = new Uint8Array(4);
  private vol = new Uint8Array(4);
  private envPeriod = new Uint8Array(4);   // latched at key-on
  private envRise = new Uint8Array(4);     // latched at key-on
  private envCount = new Uint8Array(4);    // global ticks since key-on (mod period)
  private phase = new Uint16Array(3);      // P, voices 0-2
  private q = 0;                           // noise accumulator Q
  private lfsr = 0x7fff;
  // Time
  private samples = 0;                     // samples produced since reset (next sample index)
  private tickSub = 0;                     // samples produced mod 750
  // Output
  private out = new Int16Array(4096);
  private outLen = 0;

  constructor() { this.reset(); }

  /** Number of samples produced since reset; sample k has timestamp 448 * (k + 1). */
  get sampleCount(): number { return this.samples; }

  reset(): void {
    this.freq.fill(0); this.wave.fill(0); this.env.fill(0);
    this.wavetable.fill(0); this.table.fill(0); this.masterVol = 0;
    this.keyed.fill(0); this.vol.fill(0); this.envPeriod.fill(0); this.envRise.fill(0); this.envCount.fill(0);
    this.phase.fill(0); this.q = 0; this.lfsr = 0x7fff;
    this.samples = 0; this.tickSub = 0; this.outLen = 0;
  }

  read(addr: number): number {
    const off = addr & 0x3e;
    if (off < OFF_WAVETABLE) {
      const v = off >> 3;
      switch (off & 6) {
        case 0: return this.freq[v];
        case 2: return this.wave[v];
        case 4: return this.env[v];
        default: return this.keyed[v] | (this.vol[v] << 8);
      }
    }
    if (off < OFF_MASTERVOL) return this.wavetable[(off - OFF_WAVETABLE) >> 1];
    if (off === OFF_MASTERVOL) return this.masterVol;
    return 0;
  }

  write(addr: number, value: number, byteHalf?: 0 | 1): void {
    const off = addr & 0x3e;
    if (off < OFF_WAVETABLE && (off & 6) === 6) {
      // Command register (spec §9.40): only a word write or a low-byte write acts.
      if (byteHalf === 1) return;
      this.control(off >> 3, value & 1);
      return;
    }
    let v = value & 0xffff;
    if (byteHalf !== undefined) {
      const old = this.read(addr);
      v = byteHalf === 0 ? (old & 0xff00) | (value & 0xff) : (old & 0x00ff) | ((value & 0xff) << 8);
    }
    if (off < OFF_WAVETABLE) {
      const i = off >> 3;
      switch (off & 6) {
        case 0: this.freq[i] = v; break;
        case 2: this.wave[i] = v & (i < 3 ? 7 : 1); break;
        case 4: this.env[i] = v & 0xff; break;
      }
    } else if (off < OFF_MASTERVOL) {
      const n = (off - OFF_WAVETABLE) >> 1;
      this.wavetable[n] = v;
      for (let j = 0; j < 4; j++) this.table[n * 4 + j] = (v >> (4 * j)) & 15;
    } else if (off === OFF_MASTERVOL) {
      this.masterVol = v & 15;
    }
  }

  private control(i: number, on: number): void {
    if (on) {
      const e = this.env[i];
      this.keyed[i] = 1;
      this.vol[i] = e & 15;
      this.envRise[i] = (e >> 4) & 1;
      this.envPeriod[i] = e >> 5;
      this.envCount[i] = 0;
      if (i < 3) this.phase[i] = 0; else this.lfsr = 0x7fff;
    } else {
      this.keyed[i] = 0;
      this.vol[i] = 0;
    }
  }

  private envelopeTick(): void {
    for (let i = 0; i < 4; i++) {
      const p = this.envPeriod[i];
      if (!this.keyed[i] || p === 0) continue;
      if (++this.envCount[i] < p) continue;
      this.envCount[i] = 0;
      const v = this.vol[i];
      if (this.envRise[i]) { if (v < 15) this.vol[i] = v + 1; } else if (v > 0) this.vol[i] = v - 1;
    }
  }

  advanceTo(masterCycle: number): void {
    const target = Math.floor(masterCycle / MASTER_PER_SAMPLE);
    let n = target - this.samples;
    if (n <= 0) return;
    if (this.outLen + n > this.out.length) {
      let cap = this.out.length;
      while (cap < this.outLen + n) cap *= 2;
      const grown = new Int16Array(cap);
      grown.set(this.out.subarray(0, this.outLen));
      this.out = grown;
    }
    const out = this.out, table = this.table, freq = this.freq, wave = this.wave, vol = this.vol, keyed = this.keyed;
    let p0 = this.phase[0], p1 = this.phase[1], p2 = this.phase[2];
    let q = this.q, lfsr = this.lfsr, sub = this.tickSub, len = this.outLen;
    const f0 = freq[0], f1 = freq[1], f2 = freq[2], f3 = freq[3];
    const w0 = wave[0], w1 = wave[1], w2 = wave[2], shortMode = wave[3];
    const k0 = keyed[0], k1 = keyed[1], k2 = keyed[2];
    const mv2 = this.masterVol * 2;
    // Volumes change only on envelope ticks, so cache them between ticks.
    let v0 = vol[0], v1 = vol[1], v2 = vol[2], v3 = vol[3];
    while (n-- > 0) {
      // 1. envelope tick (spec §8.10, §9.39)
      if (++sub === SAMPLES_PER_TICK) {
        sub = 0;
        this.envelopeTick();
        v0 = vol[0]; v1 = vol[1]; v2 = vol[2]; v3 = vol[3];
      }
      // 2. accumulator step, 3. step value, 4. mix
      p0 = (p0 + f0) & 0xffff;
      p1 = (p1 + f1) & 0xffff;
      p2 = (p2 + f2) & 0xffff;
      q += f3;
      if (q > 0xffff) {
        q &= 0xffff;
        const b = (lfsr ^ (lfsr >> 1)) & 1;
        lfsr = (lfsr >> 1) | (b << 14);
        if (shortMode) lfsr = (lfsr & ~0x40) | (b << 6);
      }
      let sum = (lfsr & 1 ? -15 : 15) * v3;
      if (k0 && w0 !== 7) sum += (2 * step(w0, p0, table) - 15) * v0;
      if (k1 && w1 !== 7) sum += (2 * step(w1, p1, table) - 15) * v1;
      if (k2 && w2 !== 7) sum += (2 * step(w2, p2, table) - 15) * v2;
      out[len++] = sum * mv2;
    }
    this.phase[0] = p0; this.phase[1] = p1; this.phase[2] = p2;
    this.q = q; this.lfsr = lfsr; this.tickSub = sub; this.outLen = len;
    this.samples = target;
  }

  takeSamples(): Int16Array {
    const r = this.out.slice(0, this.outLen);
    this.outLen = 0;
    return r;
  }

  /** Chip state (not the untaken output buffer). Little-endian, fixed layout "CUE1". */
  serialize(): Uint8Array {
    const b = new Uint8Array(STATE_BYTES), d = new DataView(b.buffer);
    let o = 0;
    const u8 = (v: number) => { d.setUint8(o, v); o += 1; };
    const u16 = (v: number) => { d.setUint16(o, v, true); o += 2; };
    d.setUint32(o, MAGIC, true); o += 4;
    d.setFloat64(o, this.samples, true); o += 8;
    u16(this.tickSub);
    u8(this.masterVol);
    for (let i = 0; i < 4; i++) {
      u16(this.freq[i]); u8(this.wave[i]); u8(this.env[i]); u8(this.keyed[i]); u8(this.vol[i]);
      u8(this.envPeriod[i]); u8(this.envRise[i]); u8(this.envCount[i]);
    }
    for (let i = 0; i < 3; i++) u16(this.phase[i]);
    u16(this.q); u16(this.lfsr);
    for (let i = 0; i < 8; i++) u16(this.wavetable[i]);
    return b;
  }

  deserialize(b: Uint8Array): void {
    if (b.length !== STATE_BYTES) throw new Error(`Cue state: expected ${STATE_BYTES} bytes, got ${b.length}`);
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (d.getUint32(0, true) !== MAGIC) throw new Error("Cue state: bad magic");
    let o = 4;
    const u8 = () => d.getUint8(o++);
    const u16 = () => { const v = d.getUint16(o, true); o += 2; return v; };
    this.samples = d.getFloat64(o, true); o += 8;
    this.tickSub = u16();
    this.masterVol = u8();
    for (let i = 0; i < 4; i++) {
      this.freq[i] = u16(); this.wave[i] = u8(); this.env[i] = u8(); this.keyed[i] = u8(); this.vol[i] = u8();
      this.envPeriod[i] = u8(); this.envRise[i] = u8(); this.envCount[i] = u8();
    }
    for (let i = 0; i < 3; i++) this.phase[i] = u16();
    this.q = u16(); this.lfsr = u16();
    for (let i = 0; i < 8; i++) {
      const v = u16();
      this.wavetable[i] = v;
      for (let j = 0; j < 4; j++) this.table[i * 4 + j] = (v >> (4 * j)) & 15;
    }
    this.outLen = 0;
  }
}

/** Step value s (0-15) of tone waveform w (0-6) at phase p. */
function step(w: number, p: number, table: Uint8Array): number {
  if (w < 4) return p < PULSE_LIMIT[w] ? 15 : 0;
  if (w === 4) { const t = p >> 11; return t < 16 ? t : 31 - t; }
  if (w === 5) return p >> 12;
  return table[p >> 11];
}
