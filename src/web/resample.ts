// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Linear resampler from the Cue's ~47,940 Hz sample clock to the browser's
// output rate, with a small rate adjustment for dynamic rate control
// (keeps the audio queue near half full without touching machine timing).

export class Resampler {
  private readonly inRate: number;
  private readonly outRate: number;
  private step: number;       // input samples advanced per output sample
  private pos = 0;            // position within [prev, next) in input samples
  private prev = 0;

  constructor(inRate: number, outRate: number) {
    this.inRate = inRate; this.outRate = outRate;
    this.step = inRate / outRate;
  }

  /** Scale output rate by `factor` (0.995..1.005). */
  setRateAdjust(factor: number) {
    if (factor < 0.995 || factor > 1.005) throw new Error("rate adjustment limited to ±0.5%");
    this.step = this.inRate / (this.outRate * factor);
  }

  /** Resample signed 16-bit PCM to float samples in [-1, 1). */
  push(input: Int16Array): Float32Array {
    const out = new Float32Array(Math.ceil((input.length + 1) / this.step) + 1);
    let n = 0, pos = this.pos, prev = this.prev;
    for (let i = 0; i < input.length; i++) {
      const next = input[i] / 32768;
      while (pos < 1) { out[n++] = prev + (next - prev) * pos; pos += this.step; }
      pos -= 1; prev = next;
    }
    this.pos = pos; this.prev = prev;
    return out.subarray(0, n);
  }
}
