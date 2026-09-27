// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Contracts between the Cyclorama emulator's parts (docs/spec-notes.md §1, §6).
// The machine (src/machine/machine.ts) owns time; components never read host time.

/** The CPU's view of the address space. All accesses happen "at instruction start" (spec §1). */
export interface Bus {
  read8(addr: number): number;
  read16(addr: number): number;   // addr & 0xfffe
  write8(addr: number, value: number): void;
  write16(addr: number, value: number): void;
  /** IE & IF: bit 0 VBLANK, bit 1 LINE, bit 2 TIMER. */
  pendingInterrupts(): number;
  /** Extra CPU cycles caused by the accesses of the current instruction (port waits, DMA stalls). Reading resets it to 0. */
  takeExtraCycles(): number;
}

/** Tally CPU. `step` executes one instruction (or takes one interrupt, or idles) and returns CPU cycles used. */
export interface CpuCore {
  r: Uint16Array;     // R0-R7
  sp: number;
  pc: number;
  f: number;          // flags: Z=1 N=2 C=4 V=8 I=16
  /** "run" | "wait" (WAI) | "stop" (STOP executed). */
  mode: "run" | "wait" | "stop";
  reset(bus: Bus): void;
  /**
   * Run until one instruction completes or an interrupt is entered; return CPU cycles consumed
   * (including bus.takeExtraCycles()). In "wait" mode with no pending interrupt, return 1 (one idle cycle).
   * In "stop" mode, return 1 and do nothing.
   */
  step(bus: Bus): number;
  serialize(): Uint8Array;
  deserialize(b: Uint8Array): void;
}

/** Cue audio chip. Master-cycle timestamps are absolute since power-on. */
export interface AudioCore {
  reset(): void;
  read(addr: number): number;                      // word register read (addr even, F080-F0BF)
  write(addr: number, value: number, byteHalf?: 0 | 1): void; // word write, or byte write to low (0) / high (1) half
  /** Produce every sample whose timestamp 448*(k+1) <= masterCycle. */
  advanceTo(masterCycle: number): void;
  /** Take the signed 16-bit PCM samples produced since the last call (mix * 2). */
  takeSamples(): Int16Array;
  serialize(): Uint8Array;
  deserialize(b: Uint8Array): void;
}

export const MASTER_PER_CPU = 6;
export const MASTER_PER_DOT = 4;
export const MASTER_PER_LINE = 1368;
export const LINES_PER_FRAME = 262;
export const MASTER_PER_FRAME = MASTER_PER_LINE * LINES_PER_FRAME; // 358,416
export const MASTER_PER_SAMPLE = 448;
