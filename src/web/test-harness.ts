// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Test-only page script: exposes the emulator to browser tests (Playwright).
import { Machine } from "../machine/machine.ts";
import { Tally } from "../machine/cpu.ts";
import { FramePacer } from "./pacing.ts";

const api = {
  /** Run a ROM until STOP or maxFrames; return result word at 8000, frames and state hash. */
  runToStop(rom: Uint8Array, maxFrames: number, pads: number[] = []) {
    const m = new Machine(rom, { cpu: new Tally() });
    let frames = 0;
    while (frames < maxFrames && m.cpu.mode !== "stop") { m.runFrame(pads[frames] ?? 0, 0); frames++; }
    return { code: m.bus.read16(0x8000), frames, hash: m.hash(), stopped: m.cpu.mode === "stop" };
  },
  /** Drive the pacer with display ticks at `hz` for `seconds`; machine input depends only on the machine frame index. */
  paced(rom: Uint8Array, hz: number, seconds: number) {
    const m = new Machine(rom, { cpu: new Tally() });
    const p = new FramePacer();
    let frame = 0;
    for (let t = 0; t <= seconds * 1000; t += 1000 / hz) {
      const n = p.tick(t);
      for (let k = 0; k < n; k++) { m.runFrame((frame * 5) & 0x1f, 0); frame++; }
    }
    return { frames: frame, hash: m.hash() };
  },
  /** Run exactly `frames` frames with the same input rule as paced(). */
  fixed(rom: Uint8Array, frames: number) {
    const m = new Machine(rom, { cpu: new Tally() });
    for (let f = 0; f < frames; f++) m.runFrame((f * 5) & 0x1f, 0);
    return m.hash();
  },
};
(window as unknown as { cyc: typeof api }).cyc = api;
