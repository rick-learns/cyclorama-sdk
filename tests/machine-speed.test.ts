// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// test-tier: slow (a one-cycle-per-idle-step reference machine is slow by design)
// Idle fast-forward (Machine.step): while the CPU waits in WAI with no interrupt pending, the
// CpuCore contract makes every step a 1-cycle no-op, so the machine takes all the idle cycles up
// to the next thing that can wake it (a video event, a timer underflow, the caller's limit) in
// one step. This is an implementation speed-up only: every test here compares a machine that
// fast-forwards with one that idles one CPU cycle per step, frame by frame (state hash, picture,
// audio samples), over the conformance ROMs and the openings of the production cartridges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";
import type { Bus, CpuCore } from "../src/machine/types.ts";
import { buildOne, discoverRoms, loadScrim } from "../tools/build-roms.ts";
import { buildRom, CONFORMANCE_DIR, padScript } from "../tools/conformance.ts";
import { padsFromEntries, type ReplayFile } from "../tools/replay.ts";
import { createVideoState, renderLine } from "../src/machine/video/render.ts";
import * as refRender from "./fixtures/render-reference.ts";

/** A Tally that never shows the machine it is waiting, so every idle cycle is its own step (the
 *  behaviour before the fast-forward). The CPU itself runs unchanged. */
class OneCycleIdle implements CpuCore {
  readonly t = new Tally();
  get r() { return this.t.r; }
  get sp() { return this.t.sp; } set sp(v: number) { this.t.sp = v; }
  get pc() { return this.t.pc; } set pc(v: number) { this.t.pc = v; }
  get f() { return this.t.f; } set f(v: number) { this.t.f = v; }
  get mode(): "run" | "wait" | "stop" { return this.t.mode === "wait" ? "run" : this.t.mode; }
  set mode(v: "run" | "wait" | "stop") { this.t.mode = v; }
  reset(bus: Bus) { this.t.reset(bus); }
  step(bus: Bus) { return this.t.step(bus); }
  serialize() { return this.t.serialize(); }
  deserialize(b: Uint8Array) { this.t.deserialize(b); }
}

const digest = (a: ArrayBufferView) => createHash("sha256").update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest("hex").slice(0, 16);

/** Run both machines `frames` frames (from power-on, or both from save state `from` taken after
 *  `from.frame` frames); every frame they must agree on state, picture and sound. */
function compare(name: string, rom: Uint8Array, frames: number, pads: (f: number) => [number, number], from?: { state: Uint8Array; frame: number }) {
  const fast = new Machine(rom, { cpu: new Tally() }), ref = new Machine(rom, { cpu: new OneCycleIdle() });
  if (from) { fast.loadState(from.state); ref.loadState(from.state); }
  let steps = 0, refSteps = 0;
  const fs = fast.step.bind(fast), rs = ref.step.bind(ref);
  fast.step = l => { steps++; return fs(l); };
  ref.step = l => { refSteps++; return rs(l); };
  for (let f = from?.frame ?? 0; f < frames; f++) {
    const [a, b] = pads(f);
    fast.runFrame(a, b); ref.runFrame(a, b);
    assert.equal(fast.hash(), ref.hash(), `${name} frame ${f + 1}: state`);
    assert.equal(fast.masterCycle, ref.masterCycle, `${name} frame ${f + 1}: clock`);
    assert.equal(digest(fast.framebuffer), digest(ref.framebuffer), `${name} frame ${f + 1}: picture`);
    assert.equal(digest(fast.audio.takeSamples()), digest(ref.audio.takeSamples()), `${name} frame ${f + 1}: audio`);
    if (fast.cpu.mode === "stop") break;
  }
  return { steps, refSteps };
}

test("conformance ROMs: fast-forwarded idling computes exactly what one-cycle idle steps compute", () => {
  const files = readdirSync(CONFORMANCE_DIR).filter(f => /^\d.*\.asm$/.test(f)).sort();
  assert.ok(files.length >= 15, `${files.length} conformance ROMs`);
  for (const f of files) {
    const file = `${CONFORMANCE_DIR}/${f}`;
    compare(f, buildRom(file), 240, padScript(readFileSync(file, "utf8")) ?? (() => [0, 0]));
  }
});

// The one-cycle reference is slow (every idle cycle is a step), so the production cartridges are
// compared over windows: SLICE TEST from power-on to its win, then 90 frames of play in each SCRIM
// game, both machines starting from the same save state (ERG's play takes a LINE interrupt every
// frame; SHADEWORKS' window crosses a change of GAME_STATE; INKLIGHT's crosses a room flip drawn into the hidden
// half of BG0). The Curtain Up splash before them polls with
// interrupts off, so it never waits in WAI.
const WINDOWS: Record<string, [from: number, to: number][]> = {
  "slice-test": [[0, 230]], erg: [[450, 540]], houselights: [[400, 490]], shadeworks: [[340, 430]], inklight: [[470, 560]],
};

test("production cartridges: SLICE TEST to its win and a window of play in each SCRIM game agree frame by frame", async () => {
  await loadScrim();
  const replays = readdirSync("replays").filter(f => f.endsWith(".replay.json")).sort();
  assert.ok(replays.includes("slice-test.replay.json"), replays.join(", "));
  for (const f of replays) {
    const r = JSON.parse(readFileSync(`replays/${f}`, "utf8")) as ReplayFile;
    const windows = WINDOWS[r.rom];
    assert.ok(windows, `${r.rom}: choose its windows`);
    const rom = buildOne(discoverRoms().find(s => s.name === r.rom)!), input = padsFromEntries(r.pads);
    const lead = new Machine(rom, { cpu: new Tally() });
    for (const [from, to] of windows) {
      assert.ok(to <= r.frames);
      while (lead.frame < from) { const [a, b] = input(lead.frame); lead.runFrame(a, b); }
      compare(`${r.rom}@${from}`, rom, to, input, from === 0 ? undefined : { state: lead.saveState(), frame: from });
    }
  }
});

test("renderer: the optimised line renderer matches the reference renderer pixel for pixel on random video states", () => {
  let seed = 0x5eed;
  const rnd = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
  for (let trial = 0; trial < 48; trial++) {
    const a = createVideoState(), b = refRender.createVideoState();
    const sparse = trial % 3;                                      // 0 dense, 1 half empty, 2 mostly empty
    for (let i = 0; i < a.vram.length; i++) a.vram[i] = rnd(4) < sparse + (sparse > 1 ? 1 : 0) ? 0 : rnd(256);
    for (let i = 0; i < 512; i++) a.oam[i] = rnd(256);
    for (let i = 0; i < 512; i++) a.cram[i] = rnd(4096);
    const R: Record<string, number> = {
      VCTRL: trial < 4 ? [0, 1, 0x1f, 0x0f][trial] : rnd(32), BG0MAP: rnd(16), BG1MAP: rnd(16), BG0SCX: rnd(512), BG0SCY: rnd(256),
      BG1SCX: rnd(512), BG1SCY: rnd(256), AMBIENT: rnd(8), FIXED: rnd(8), PROBEX: rnd(256), PROBEY: rnd(512),
    };
    for (let i = 0; i < 4; i++) Object.assign(R, { [`L${i}X`]: trial & 1 ? rnd(256) : rnd(1024), [`L${i}Y`]: trial & 1 ? rnd(224) : rnd(1024), [`L${i}I`]: rnd(3) ? rnd(16) : 0, [`L${i}F`]: rnd(64) & 0x37 });
    Object.assign(a.regs, R);
    b.vram.set(a.vram); b.oam.set(a.oam); b.cram.set(a.cram); Object.assign(b.regs, a.regs);
    for (let y = 0; y < 224; y++) {
      if (trial % 8 === 7) R.PROBEY = y;                            // a probe on every line
      a.regs.PROBEY = b.regs.PROBEY = R.PROBEY;
      const oa = new Uint32Array(256), ob = new Uint32Array(256);
      const ia = renderLine(a, y, oa), ib = refRender.renderLine(b, y, ob);
      assert.deepEqual(ia, ib, `trial ${trial} line ${y}: line info`);
      if (!oa.every((v, x) => v === ob[x])) assert.fail(`trial ${trial} line ${y}: pixels differ at x ${oa.findIndex((v, x) => v !== ob[x])}`);
    }
  }
});

test("a waiting CPU costs a handful of machine steps per frame, not one per idle cycle", () => {
  const rom = buildOne(discoverRoms().find(s => s.name === "lantern-test")!);
  const { steps, refSteps } = compare("lantern-test", rom, 120, f => [f >= 50 && f < 52 ? 16 : 4, 0]);
  assert.ok(refSteps > 120 * 30000, `reference: ${refSteps} steps (one per idle cycle)`);
  assert.ok(steps < refSteps / 10, `fast-forward: ${steps} steps against ${refSteps}`);
});
