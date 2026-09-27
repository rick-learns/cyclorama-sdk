// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Frame pacing for the browser host. The machine's clock is authoritative:
// the host only decides HOW MANY whole frames to run for elapsed wall time.
// Display refresh rate (60/120/144 Hz) changes when frames are shown, never
// what the machine computes.

/** One Cyclorama frame: 358,416 master cycles at 945/44 MHz, in milliseconds. */
export const FRAME_MS = 358416 / (945e6 / 44) * 1000;
const MAX_CATCH_UP = 4;

export class FramePacer {
  private last = -1;
  private acc = 0;

  /** Call on every animation frame with a monotonic timestamp (ms); returns frames to run now. */
  tick(now: number): number {
    if (this.last < 0) { this.last = now; return 0; }
    this.acc += Math.max(0, now - this.last);
    this.last = now;
    let n = Math.floor(this.acc / FRAME_MS);
    if (n > MAX_CATCH_UP) { this.acc = 0; return MAX_CATCH_UP; } // stall: resync, don't spiral
    this.acc -= n * FRAME_MS;
    return n;
  }

  /** Forget elapsed time (e.g. after the tab was hidden). */
  reset() { this.last = -1; this.acc = 0; }
}
