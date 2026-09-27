// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Idle fast-forward, fast tier (DECISIONS 2026-09-27 [perf/ci] dedup gap 2): Machine.step takes all
// the idle cycles of a WAI in one step, up to the next video event, timer underflow or the caller's
// limit. tests/machine-speed.test.ts (slow tier) proves that over whole ROMs; this file proves it
// in well under a second on small assembled programs built to hit every bound: the timer at each
// prescaler with the WAI entered at a different prescale phase every time, LINE at several lines,
// VBLANK, all together, none, and limits passed to Machine.step. Each program runs on a machine that
// fast-forwards and on one whose CPU never admits to waiting (one idle cycle per step, the
// behaviour before the fast-forward). Every instruction and interrupt entry must start at the same
// machine cycle on both, and each frame must end with the same clock and state hash. A step that
// overshoots its bound by one CPU cycle delays the next interrupt entry, so it shows here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";
import type { Bus, CpuCore } from "../src/machine/types.ts";
import { assemble } from "../src/asm/assembler.ts";

type Case = { name: string; ie: number; tctrl: number; reload: number; linecmp: number };

/** A program that sets the timer, LINECMP and IE, then waits in a WAI loop. The handler clears
 *  IF and burns 0-7 loop turns (a counter kept in work RAM), so each WAI starts at a new phase. */
function program(c: Case): Uint8Array {
  const src = `
        .org $0000
        .word start, isr, isr, isr, isr
        .header title="IDLE FF PROBE", dev=$0001, date=$19870301, version=$0100
        .org $0040
start:  MOVW R0, #${c.reload}
        ST   R0, [TRELOAD]
        ST   R0, [TCOUNT]
        MOVW R0, #${c.linecmp}
        ST   R0, [LINECMP]
        MOVW R0, #${c.tctrl}
        ST   R0, [TCTRL]
        MOVW R0, #${c.ie}
        ST   R0, [IE]
        EI
loop:   WAI
        BRA  loop
isr:    PUSH R0
        PUSH R1
        LD   R0, [IF]
        ST   R0, [IF]
        LD   R1, [$8000]
        INC  R1
        ST   R1, [$8000]
        AND  R1, #7
.burn:  TST  R1, R1
        BEQ  .done
        DEC  R1
        BRA  .burn
.done:  POP  R1
        POP  R0
        RTI
`;
  const res = assemble("probe.asm", p => { if (p !== "probe.asm") throw new Error(p); return src; });
  assert.deepEqual(res.errors, [], `${c.name}: assembles`);
  return res.rom;
}

/** Tally that logs (machine cycle, PC) for every step that does work: an instruction or an
 *  interrupt entry, never an idle WAI cycle. With `hideWait` it never shows the machine it is
 *  waiting, so the machine cannot fast-forward and idles one CPU cycle per step. */
class Traced implements CpuCore {
  readonly t = new Tally();
  readonly trace: number[] = [];
  clock = () => 0;
  readonly hideWait: boolean;
  constructor(hideWait: boolean) { this.hideWait = hideWait; }
  get r() { return this.t.r; }
  get sp() { return this.t.sp; } set sp(v: number) { this.t.sp = v; }
  get pc() { return this.t.pc; } set pc(v: number) { this.t.pc = v; }
  get f() { return this.t.f; } set f(v: number) { this.t.f = v; }
  get mode(): "run" | "wait" | "stop" { return this.hideWait && this.t.mode === "wait" ? "run" : this.t.mode; }
  set mode(v: "run" | "wait" | "stop") { this.t.mode = v; }
  reset(bus: Bus) { this.t.reset(bus); }
  step(bus: Bus) {
    if (!(this.t.mode === "wait" && (bus.pendingInterrupts() & 7) === 0)) this.trace.push(this.clock(), this.t.pc);
    return this.t.step(bus);
  }
  serialize() { return this.t.serialize(); }
  deserialize(b: Uint8Array) { this.t.deserialize(b); }
}

const T = (div: 0 | 1 | 2 | 3) => 1 | (div << 1);     // TCTRL: enabled, prescaler 1/16/64/256
const CASES: Case[] = [
  { name: "timer /1", ie: 4, tctrl: T(0), reload: 211, linecmp: 511 },
  { name: "timer /1 long", ie: 4, tctrl: T(0), reload: 997, linecmp: 511 },
  { name: "timer /16", ie: 4, tctrl: T(1), reload: 9, linecmp: 511 },
  { name: "timer /16 long", ie: 4, tctrl: T(1), reload: 61, linecmp: 511 },
  { name: "timer /64", ie: 4, tctrl: T(2), reload: 3, linecmp: 511 },
  { name: "timer /64 long", ie: 4, tctrl: T(2), reload: 20, linecmp: 511 },
  { name: "timer /256", ie: 4, tctrl: T(3), reload: 1, linecmp: 511 },
  { name: "timer /256 long", ie: 4, tctrl: T(3), reload: 6, linecmp: 511 },
  { name: "VBLANK, timer running but masked", ie: 1, tctrl: T(1), reload: 7, linecmp: 511 },
  { name: "LINE 0", ie: 2, tctrl: 0, reload: 0, linecmp: 0 },
  { name: "LINE 100", ie: 2, tctrl: 0, reload: 0, linecmp: 100 },
  { name: "LINE 261", ie: 2, tctrl: 0, reload: 0, linecmp: 261 },
  { name: "VBLANK + LINE 223 + timer /64", ie: 7, tctrl: T(2), reload: 13, linecmp: 223 },
  { name: "nothing enabled", ie: 0, tctrl: T(3), reload: 50, linecmp: 511 },
];
const FRAMES = 2;

function firstDiff(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i;
  return -1;
}

/** The program of `c` on a fast-forwarding machine and on the one-cycle reference, with step counts. */
function pair(c: Case) {
  const rom = program(c);
  const fc = new Traced(false), rc = new Traced(true);
  const fast = new Machine(rom, { cpu: fc }), ref = new Machine(rom, { cpu: rc });
  fc.clock = () => fast.masterCycle; rc.clock = () => ref.masterCycle;
  const steps = { fast: 0, ref: 0 };
  const fs = fast.step.bind(fast), rs = ref.step.bind(ref);
  fast.step = l => { steps.fast++; return fs(l); };
  ref.step = l => { steps.ref++; return rs(l); };
  /** Both traces and clocks agree since the last check; the traces are then cleared. */
  const agree = (where: string) => {
    const at = firstDiff(fc.trace, rc.trace);
    if (at >= 0) {
      const i = at & ~1;
      assert.fail(`${c.name}, ${where}, work step ${i / 2}: fast-forward at cycle ${fc.trace[i]} pc ${fc.trace[i + 1]?.toString(16)}, one-cycle idle at cycle ${rc.trace[i]} pc ${rc.trace[i + 1]?.toString(16)}`);
    }
    assert.equal(fast.masterCycle, ref.masterCycle, `${c.name}, ${where}: clock`);
    const work = fc.trace.length / 2;
    fc.trace.length = 0; rc.trace.length = 0;
    return work;
  };
  return { fast, ref, steps, agree };
}

test("idle fast-forward: every instruction and interrupt entry starts on the same cycle as with one idle cycle per step", () => {
  let fastSteps = 0, refSteps = 0;
  for (const c of CASES) {
    const { fast, ref, steps, agree } = pair(c);
    for (let f = 0; f < FRAMES; f++) {
      fast.runFrame(0, 0); ref.runFrame(0, 0);
      const work = agree(`frame ${f + 1}`);
      if (f === 0 || c.ie) assert.ok(work > 10, `${c.name}, frame ${f + 1}: the program runs (${work} work steps)`);
      assert.equal(fast.hash(), ref.hash(), `${c.name}, frame ${f + 1}: state`);
    }
    fastSteps += steps.fast; refSteps += steps.ref;
  }
  // The fast machine really fast-forwarded (the comparison is not one-cycle against one-cycle).
  assert.ok(fastSteps * 4 < refSteps, `fast-forward took ${fastSteps} steps against ${refSteps}`);
});

// runFrame's limit is the frame end, which is also a video event (line 0, dot 0), so the frames
// above never make `limit` the nearest bound. Machine.step(limit) is public: drive it to limits
// that fall between events and CPU cycle boundaries, as runFrame drives it to the frame end.
test("idle fast-forward: Machine.step(limit) idles to the first step boundary at or after an arbitrary limit", () => {
  for (const c of CASES.filter(k => ["nothing enabled", "timer /16 long", "LINE 100"].includes(k.name))) {
    const { fast, ref, steps, agree } = pair(c);
    for (let k = 0, limit = 3001; k < 200; k++, limit += 1733 + (k % 5)) {
      while (fast.masterCycle < limit) fast.step(limit);
      while (ref.masterCycle < limit) ref.step(limit);
      agree(`limit ${limit}`);
    }
    assert.ok(steps.fast * 4 < steps.ref, `${c.name}: fast-forward took ${steps.fast} steps against ${steps.ref}`);
  }
});
