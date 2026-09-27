// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Audio output plumbing shared by both browser backends (AudioWorklet and the
// ScriptProcessor fallback used where worklets are unavailable, e.g. non-secure
// contexts). DOM-free, so it is unit-tested in Node. Output only: nothing here
// feeds back into the machine, whose timing never depends on the browser.

export type AudioReport = { depth: number; under: number; played: number; peak: number };

/** FIFO of resampled Float32 chunks, pulled a block at a time by the audio callback.
 *  Self-contained (no outside references): its source is embedded in the worklet. */
export class SampleQueue {
  q: Float32Array[] = [];
  off = 0;
  depth = 0;
  under = 0;
  played = 0;
  peak = 0;

  push(chunk: Float32Array) { if (chunk.length) { this.q.push(chunk); this.depth += chunk.length; } }

  /** Fill `out` from the queue; silence (and an underrun count) once it runs dry. */
  pull(out: Float32Array) {
    let peak = this.peak;
    for (let i = 0; i < out.length; i++) {
      if (!this.q.length) { out[i] = 0; this.under++; continue; }
      const b = this.q[0], v = b[this.off++];
      out[i] = v; this.depth--; this.played++;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      if (this.off >= b.length) { this.q.shift(); this.off = 0; }
    }
    this.peak = peak;
  }

  /** Counters so far, and the peak magnitude played since the previous report. */
  report(): AudioReport {
    const r = { depth: this.depth, under: this.under, played: this.played, peak: this.peak };
    this.peak = 0;
    return r;
  }
}

/** Dynamic rate control: nudge the resampler (within ±0.5%) to keep the queue near `target`. */
export function rateAdjust(depth: number, target: number): number {
  const err = (target - depth) / target;          // positive: queue too short -> make more samples
  return 1 + Math.max(-0.005, Math.min(0.005, err * 0.005));
}

/** Peak meter for the play view: jumps to a louder peak, otherwise decays exponentially. */
export class LevelMeter {
  private readonly halfLife: number;
  private level = 0;
  private at = 0;

  constructor(halfLifeMs = 120) { this.halfLife = halfLifeMs; }

  read(now: number): number {
    const dt = Math.max(0, now - this.at);
    const v = this.level * Math.pow(0.5, dt / this.halfLife);
    return v < 1e-6 ? 0 : v;
  }

  feed(peak: number, now: number) {
    const cur = this.read(now);
    this.level = peak > cur ? peak : cur;
    this.at = now;
  }
}

export const WORKLET_NAME = "cyclorama-out";

/** AudioWorklet module source: plays queued chunks, reports queue state and peak every 8 blocks. */
export const WORKLET_SOURCE = `const SampleQueue = (${SampleQueue.toString()});
class CycloramaOut extends AudioWorkletProcessor {
  constructor() { super(); this.sq = new SampleQueue(); this.n = 0;
    this.port.onmessage = e => this.sq.push(e.data); }
  process(_, outputs) {
    this.sq.pull(outputs[0][0]);
    if ((++this.n & 7) === 0) this.port.postMessage(this.sq.report());
    return true;
  }
}
registerProcessor(${JSON.stringify(WORKLET_NAME)}, CycloramaOut);`;
