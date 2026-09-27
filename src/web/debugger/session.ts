// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// The debugger's DOM-free core: a Machine plus stepping, PC breakpoints and
// write watchpoints. Stepping calls machine.step() exactly as runFrame() does
// (same frame limit, frames closed by runFrame() once their end has passed), so
// a stepped machine computes exactly what a free-running one does.
//
// Pads: runFrame(p1, p2) latches the pads for the frame it runs. When a frame is
// run stepwise, the pads latched are those given when the previous frame was
// closed; the fast path (no breakpoints or watchpoints) latches them per frame.
import { Machine } from "../../machine/machine.ts";
import { Tally } from "../../machine/cpu.ts";
import { MASTER_PER_FRAME } from "../../machine/types.ts";
import { loadFailureMessage, storedStateLoadOptions } from "../stored-state.ts";

export type BreakHit =
  | { kind: "breakpoint"; pc: number }
  | { kind: "watch"; addr: number; value: number; pc: number };
type Pads = readonly [number, number];

export class DebugSession {
  readonly machine: Machine;
  readonly breakpoints = new Set<number>();
  /** CPU addresses whose writes stop execution (word writes cover both bytes). */
  readonly watchpoints = new Set<number>();
  private watchHit: BreakHit | null = null;
  private pcAtStep = 0;

  /** Load a state the debugger stored (memory slot or localStorage). Returns null when it loaded,
   *  otherwise the player-facing reason; a refused state changes nothing (loadState is
   *  transactional). Like the museum, a v1 state is one the debugger wrote before save states v2. */
  loadStored(state: Uint8Array, title: string): string | null {
    try { this.machine.loadState(state, storedStateLoadOptions(state)); return null; } catch (e) { return loadFailureMessage(e, title); }
  }

  constructor(rom: Uint8Array) {
    this.machine = new Machine(rom, { cpu: new Tally() });
    // Observe CPU writes for watchpoints; the writes themselves are unchanged.
    const bus = this.machine.bus, w8 = bus.write8, w16 = bus.write16;
    bus.write8 = (a, v) => {
      if (this.watchpoints.size && this.watchpoints.has(a & 0xffff)) this.hit(a & 0xffff, v & 0xff);
      w8(a, v);
    };
    bus.write16 = (a, v) => {
      if (this.watchpoints.size) {
        const e = a & 0xfffe;
        if (this.watchpoints.has(e)) this.hit(e, v & 0xffff);
        else if (this.watchpoints.has(e + 1)) this.hit(e + 1, v & 0xffff);
      }
      w16(a, v);
    };
  }

  private hit(addr: number, value: number) {
    if (!this.watchHit) this.watchHit = { kind: "watch", addr, value, pc: this.pcAtStep };
  }

  private closeFrames(pads: Pads) {
    const m = this.machine;
    while (m.masterCycle >= (m.frame + 1) * MASTER_PER_FRAME) { m.runFrame(pads[0], pads[1]); m.audio.takeSamples(); }
  }

  /** One machine.step() within the current frame; returns a watchpoint hit or a breakpoint at the new PC. */
  private stepOnce(pads: Pads): BreakHit | null {
    const m = this.machine;
    this.closeFrames(pads);
    this.watchHit = null;
    this.pcAtStep = m.cpu.pc;
    m.step((m.frame + 1) * MASTER_PER_FRAME);
    this.closeFrames(pads);
    if (this.watchHit) return this.watchHit;
    if (m.cpu.mode === "run" && this.breakpoints.has(m.cpu.pc)) return { kind: "breakpoint", pc: m.cpu.pc };
    return null;
  }

  /**
   * Execute one instruction (or interrupt entry). If the CPU is waiting (WAI), idle until it
   * resumes, at most two frames. Returns a watchpoint hit, if any; the step always stops.
   */
  stepInstruction(pads: Pads): BreakHit | null {
    const m = this.machine, waiting = m.cpu.mode === "wait", f = m.frame;
    let r = this.stepOnce(pads);
    while (waiting && !r && m.cpu.mode === "wait" && m.frame - f < 2) r = this.stepOnce(pads);
    return r?.kind === "watch" ? r : null;
  }

  /** Run to the end of the current frame, stopping early at a breakpoint or watchpoint. */
  advanceFrame(pads: Pads): BreakHit | null {
    const m = this.machine, f = m.frame;
    if (!this.breakpoints.size && !this.watchpoints.size) {
      m.runFrame(pads[0], pads[1]);
      m.audio.takeSamples();
      return null;
    }
    while (m.frame === f) {
      const r = this.stepOnce(pads);
      if (r) return r;
    }
    return null;
  }
}
