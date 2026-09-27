// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Lantern Test, the engineering test cartridge (roms/lantern-test): behaviour verified headlessly on the full machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRom, runRom } from "../tools/conformance.ts";
import { rgbOf } from "../src/machine/video/render.ts";

const rom = buildRom("roms/lantern-test/lantern-test.asm");
const lum = (c: number) => ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255);

test("lantern lights the room around the cat and leaves the corners dark", () => {
  const { m } = runRom(rom, 30);
  const px = m.bus.read16(0x8000), py = m.bus.read16(0x8002);
  assert.deepEqual([px, py], [120, 100]);
  const area = (x0: number, y0: number) => { let s = 0; for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) s += lum(m.framebuffer[(y0 + y) * 256 + x0 + x]); return s / 256; };
  const near = area(px, py + 20), far = area(240, 0);
  assert.ok(near > far * 3, `near ${near} far ${far}`);
});

test("the cat's eyes are unlit: full-brightness eye colour even with the lantern elsewhere", () => {
  const { m } = runRom(rom, 30);
  const eye = rgbOf(0xfd3);
  assert.ok(m.framebuffer.some(c => c === eye), "eye colour on screen");
});

test("the D-pad moves the cat and the light; A plays a note", () => {
  const { m } = runRom(rom, 40, f => [f >= 10 && f < 30 ? 8 : f === 35 ? 16 : 0, 0]); // right x20, then A
  assert.equal(m.bus.read16(0x8000), 140);
  assert.equal(m.bus.read16(0xf030) & 0x3ff, 148); // L0X follows the cat centre
  let s = m.audio.takeSamples();
  const { m: m2 } = runRom(rom, 40, f => [f === 35 ? 16 : 0, 0]);
  s = m2.audio.takeSamples();
  assert.ok(s.some(v => v !== 0), "note audible");
});

test("the demo is deterministic", () => {
  const a = runRom(rom, 120, f => [(f * 7) & 0x1f, 0]).m.hash();
  const b = runRom(rom, 120, f => [(f * 7) & 0x1f, 0]).m.hash();
  assert.equal(a, b);
});
