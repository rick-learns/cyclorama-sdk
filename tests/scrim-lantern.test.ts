// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// End to end: the SCRIM edition of the lantern demo (roms/lantern-scrim/lantern-scrim.scr), compiled
// and run headlessly with scripted pads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compile } from "../src/scrim/compile.ts";
import { runRom } from "../tools/conformance.ts";
import { rgbOf } from "../src/machine/video/render.ts";

const result = compile("roms/lantern-scrim/lantern-scrim.scr", (p) => readFileSync(p));
const rom = result.rom!;
const sym = (n: string) => result.symbols!.get(n)!;
const lum = (c: number) => ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255);
const RIGHT = 8, LEFT = 4, DOWN = 2, A = 16;

test("lantern (SCRIM) compiles cleanly", () => {
  assert.deepEqual(result.errors, []);
  assert.ok(rom && rom.length === 32768);
});

test("lantern (SCRIM): the light field lights the room around the cat and leaves the corners dark", () => {
  const { m } = runRom(rom, 30);
  const px = m.bus.read16(sym("px")), py = m.bus.read16(sym("py"));
  assert.deepEqual([px, py], [120, 100]);
  const area = (x0: number, y0: number) => { let s = 0; for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) s += lum(m.framebuffer[(y0 + y) * 256 + x0 + x]); return s / 256; };
  const near = area(px, py + 20), far = area(240, 0);
  assert.ok(near > far * 3, `near ${near} far ${far}`);
  assert.ok(m.framebuffer.some((c) => c === rgbOf(0xfd3)), "unlit eye colour on screen");
});

test("lantern (SCRIM): the D-pad moves the cat; sprite and light register follow", () => {
  const pads = (f: number): [number, number] => [f >= 10 && f < 30 ? RIGHT : f >= 30 && f < 36 ? DOWN : f >= 36 && f < 40 ? LEFT | A : 0, 0];
  const { m } = runRom(rom, 45, pads);
  const px = m.bus.read16(sym("px")), py = m.bus.read16(sym("py"));
  assert.deepEqual([px, py], [120 + 20 - 4, 100 + 6]);
  assert.equal(m.bus.read16(0xf030) & 0x3ff, px + 8, "L0X follows the cat's centre");
  assert.equal(m.bus.read16(0xf032) & 0x3ff, py + 8, "L0Y follows the cat's centre");
  assert.equal(m.video.oam[2] | (m.video.oam[3] << 8), px, "sprite 0 X");
  assert.equal(m.video.oam[8] | (m.video.oam[9] << 8), py, "sprite 1 Y");
  assert.equal(m.bus.read16(0xf036), 0x24, "narrow lantern once A is released");
  assert.ok(m.audio.takeSamples().some((v) => v !== 0), "A played a note");
});

test("lantern (SCRIM): light register tracks the pad frame by frame and clamps at the edge", () => {
  const m = runRom(rom, 3).m;
  const xs: number[] = [];
  for (let f = 3; f < 140; f++) { m.runFrame(RIGHT, 0); xs.push(m.bus.read16(0xf030) & 0x3ff); }
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] === xs[i - 1] + 1 || xs[i] === 248, `frame ${i}: ${xs[i - 1]} -> ${xs[i]}`);
  assert.equal(xs.at(-1), 240 + 8, "clamped at MAX_X");
  m.runFrame(A, 0);
  assert.equal(m.bus.read16(0xf036), 0x25, "wide lantern while A is held");
});

test("lantern (SCRIM): deterministic machine state across runs", () => {
  const pads = (f: number): [number, number] => [(f * 7) & 0x1f, 0];
  assert.equal(runRom(rom, 120, pads).m.hash(), runRom(rom, 120, pads).m.hash());
});
