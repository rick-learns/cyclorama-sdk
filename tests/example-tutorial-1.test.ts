// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Tutorial 1 (docs/guide/tutorial-1-cyasm.md): what each step's program shows on screen and how
// it answers the pad, checked on the emulator from power-on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";
import { rgbOf } from "../src/machine/video/render.ts";
import { buildOne } from "../tools/build-roms.ts";
import { budgetReport } from "../tools/budget.ts";
import { sampleRanges } from "../tools/doc-check.ts";
import { readFileSync } from "node:fs";

const STEP1 = "examples/tutorial-1/step1.asm", STEP2 = "examples/tutorial-1/step2.asm";
const rom = (file: string) => buildOne({ name: file, file, lang: "asm" });
const run = (r: Uint8Array, frames: number, pad = (_f: number) => 0) => {
  const m = new Machine(r, { cpu: new Tally() });
  for (let f = 0; f < frames; f++) m.runFrame(pad(f), 0);
  return m;
};
const px = (m: Machine, x: number, y: number) => m.framebuffer[y * 256 + x];
const cram = (m: Machine, i: number) => rgbOf(m.video.cram[i]);
const BACKDROP = 7 * 64, AMBER = 7 * 64 + 4 * 8 + 3, COOL = 7 * 64 + 5 * 8 + 3;   // colour 3: the lamp's centre

test(`${STEP1}: a lamp in the middle of a dark stage`, () => {
  const m = run(rom(STEP1), 10);
  assert.equal(px(m, 0, 0), cram(m, BACKDROP), "backdrop in the corner");
  assert.equal(px(m, 128, 112), cram(m, AMBER), "the lamp's white-hot centre at 128,112");
  assert.equal(px(m, 118, 112), cram(m, BACKDROP), "transparent outside the lamp");
  const lit = [...m.framebuffer].filter(p => p !== cram(m, BACKDROP)).length;
  assert.ok(lit > 150 && lit < 256, `${lit} lamp pixels of 256`);
  assert.equal(m.cpu.mode, "wait", "asleep in WAI");
});

test(`${STEP2}: the D-pad moves the lamp 2 pixels a frame and stops at the edge`, () => {
  const r = rom(STEP2);
  const centre = (m: Machine) => { const i = [...m.framebuffer].findIndex(p => p === cram(m, AMBER) || p === cram(m, COOL)); return [i % 256, Math.floor(i / 256)]; };
  const still = centre(run(r, 12));
  const right = centre(run(r, 12, f => f < 10 ? 8 : 0));          // Right for frames 0-9
  assert.equal(right[0] - still[0], 20, "10 frames of Right = 20 pixels");
  assert.equal(right[1], still[1]);
  const up = centre(run(r, 12, f => f < 5 ? 1 : 0));
  assert.deepEqual([up[0], still[1] - up[1]], [still[0], 10]);
  const far = run(r, 200, () => 8 | 2);                             // Right + Down, held
  assert.deepEqual([far.wram[0] | (far.wram[1] << 8), far.wram[2] | (far.wram[3] << 8)], [240, 208], "clamped at x 240, y 208");
});

test(`${STEP2}: A switches the lamp between two palettes and plays a note on voice 0`, () => {
  const r = rom(STEP2);
  const tap = (at: number[]) => (f: number) => at.includes(f) ? 16 : 0;
  assert.equal(px(run(r, 20), 128, 112), cram(run(r, 20), AMBER));
  const once = run(r, 20, tap([10]));
  assert.equal(px(once, 128, 112), cram(once, COOL), "one press: the cool palette");
  const held = run(r, 20, f => f >= 10 ? 16 : 0);
  assert.equal(px(held, 128, 112), cram(held, COOL), "holding A counts once");
  const twice = run(r, 20, tap([10, 14]));
  assert.equal(px(twice, 128, 112), cram(twice, AMBER), "two presses: back to amber");
  assert.deepEqual(budgetReport(r, { frames: 20, pads: f => [tap([10])(f), 0] }).audio.keyedVoices, [0]);
  assert.deepEqual(budgetReport(r, { frames: 20 }).audio.keyedVoices, [], "silent until A");
});

test("docs/guide/tutorial-1-cyasm.md quotes all of step 1 and every line step 2 adds (it says so)", () => {
  const ranges = sampleRanges(readFileSync("docs/guide/tutorial-1-cyasm.md", "utf8"));
  const lines = (f: string) => readFileSync(f, "utf8").split("\n");
  const covered = (f: string) => { const c = new Set<number>(); for (const r of ranges) if (r.path === f) for (let i = r.from ?? 1; i <= (r.to ?? lines(f).length); i++) c.add(i); return c; };
  const header = (l: string, i: number) => i < 5 && l.startsWith(";");          // the SPDX lines and the file's title comment
  const missing = (f: string, need: (l: string, i: number) => boolean) => lines(f).map((l, i) => [l, i] as const)
    .filter(([l, i]) => l.trim() && !header(l, i) && need(l, i) && !covered(f).has(i + 1)).map(([l, i]) => `${f}:${i + 1}: ${l.trim()}`);
  assert.deepEqual(missing(STEP1, () => true), [], "every line of step 1");
  const inStep1 = new Set(lines(STEP1).map(l => l.trim()));
  assert.deepEqual(missing(STEP2, l => !inStep1.has(l.trim())), [], "every line step 2 adds");
  assert.deepEqual(missing("examples/tutorial-1/tutorial-1.art", () => true), [], "the lamp's picture");
});
