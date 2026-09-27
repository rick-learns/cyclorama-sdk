// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// test-tier: slow (many whole-machine frames; `npm run test:fast` skips this file, `npm test` runs it)
// CUE SOUND TEST cartridge (roms/sound-test): straight from power-on into the "Followspot" theme
// (no Curtain Up: an open demo never includes the brand splash) with sound effects fired from
// the pad, verified headlessly on the full machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assemble } from "../src/asm/assembler.ts";
import { sourceReader } from "../tools/art.ts";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";
import { rgbOf } from "../src/machine/video/render.ts";
import { tickCycles, renderSong } from "../tools/song-wav.ts";

const asm = assemble("roms/sound-test/sound-test.asm", sourceReader(p => readFileSync(p, "utf8")));
if (asm.errors.length) throw new Error(asm.errors.map(e => `${e.file}:${e.line}: ${e.message}`).join("\n"));
const S = (n: string) => asm.symbols.get(n)!;
const RAM = S("SND_RAM");
const A = 0x10, C = 0x40, UP = 0x01, DOWN = 0x02, START = 0x80;
const PLAYING = 17;                           // the theme runs from frame 0: 16 frames into the song, as before the splash was dropped

function boot(pads: (f: number) => number = () => 0, frames = PLAYING) {
  const m = new Machine(asm.rom, { cpu: new Tally() });
  for (let f = 0; f < frames; f++) m.runFrame(pads(f), 0);
  return m;
}
const voice = (m: Machine, v: number) => [0, 2, 4].map(o => m.peek16(0xf080 + 8 * v + o)).concat(m.peek16(0xf086 + 8 * v) & 1);
const effects = (m: Machine) => [4, 5, 6, 7].map(t => m.peek16(RAM + 16 + 32 * t) !== 0);
const music = (m: Machine) => [0, 1, 2, 3].map(t => m.peek16(RAM + 16 + 32 * t) !== 0);

test("boots straight into the theme, with the text screen up from the first frame", () => {
  const first = boot(() => 0, 1);
  assert.deepEqual(music(first), [true, true, true, true], "theme playing after frame 0: no splash");
  assert.equal(first.inspect().regs.VCTRL, 3, "text screen up after frame 0: no splash");
  const m = boot();
  assert.deepEqual(music(m), [true, true, true, true]);
  assert.ok(m.peek16(RAM + 8) > 0, "rows playing");
  assert.equal(m.inspect().regs.VCTRL, 3);
  const heading = rgbOf(0x6cf), ink = rgbOf(0xfe8);
  const row = (y: number) => new Set(m.framebuffer.subarray(y * 256, y * 256 + 256));
  assert.ok([...Array(8).keys()].some(i => row(16 + i).has(heading)), "CUE SOUND TEST heading");
  assert.ok([...Array(8).keys()].some(i => row(80 + i).has(ink)), "PART row");
});

test("the theme is audible through every second of 20 s (rendered as for the WAV)", () => {
  const { pcm, startFrame } = renderSong("roms/sound-test/sound-test.asm", "SONG_theme", 20, () => [0, 0]);
  assert.equal(startFrame, 1, "the song has played its first row after frame 0 (no splash to skip)");
  for (let s = 0; s < 20; s++) {
    const w = pcm.subarray(s * 47940, (s + 1) * 47940);
    const rms = Math.sqrt(w.reduce((a, v) => a + v * v, 0) / w.length);
    assert.ok(rms > 1500, `second ${s}: rms ${rms.toFixed(0)}`);
  }
});

test("A fires the jump over the music: voice 2 borrowed, lead, bass and drums unchanged", () => {
  const press = (f: number) => (f === PLAYING + 5 ? A : 0);
  const a = boot(), b = boot(press);
  let borrowed = false;
  for (let f = PLAYING; f < PLAYING + 20; f++) {
    a.runFrame(0, 0); b.runFrame(press(f), 0);
    for (const v of [0, 1, 3]) assert.deepEqual(voice(b, v), voice(a, v), `frame ${f} voice ${v}`);
    if (b.peek8(RAM + 16 + 32 * 6 + 18)) { borrowed = true; assert.equal(voice(b, 2)[1], 2, "jump keyed: pulse 50%"); }
  }
  assert.ok(borrowed, "jump played on voice 2");
});

test("C fires the explosion on the noise voice; START fades the music out and plays it again", () => {
  const m = boot();
  m.runFrame(C, 0); m.runFrame(0, 0);
  assert.deepEqual(effects(m), [false, false, false, true]);
  assert.equal(voice(m, 3)[3], 1);
  m.runFrame(START, 0);
  const vol: number[] = [];
  for (let f = 0; f < 50; f++) { m.runFrame(0, 0); vol.push(m.peek16(0xf0b0)); }
  assert.ok(vol[10] < 15 && vol[10] > vol[40], `fading: ${vol.join(",")}`);
  assert.deepEqual(music(m), [false, false, false, false], "faded out (15 steps x 3 frames)");
  assert.equal(m.peek16(0xf0b0), 15);
  m.runFrame(START, 0); m.runFrame(0, 0);
  assert.deepEqual(music(m), [true, true, true, true], "START again: the theme restarts");
});

test("UP hurries the tempo by a quarter, DOWN restores it", () => {
  const m = boot();
  m.runFrame(UP, 0);
  assert.equal(m.peek16(RAM + 2), S("HURRY"));
  assert.equal(S("HURRY"), Math.floor(S("SONG_theme_RATE") * 5 / 4));
  m.runFrame(0, 0); m.runFrame(DOWN, 0);
  assert.equal(m.peek16(RAM + 2), S("SONG_theme_RATE"));
});

test("SND_TICK inside the cartridge stays a small fraction of the frame", (t) => {
  const m = boot();
  const pads = (f: number) => [[A, 0, 0x20, 0, C, 0, 0x04, 0][f % 8], 0] as [number, number];
  const r = tickCycles(m, S("SND_TICK"), 1200, undefined, pads);
  t.diagnostic(`SND_TICK in the cartridge: max ${r.max} cycles (${(100 * r.max / 59736).toFixed(1)}% of a frame), mean ${r.mean.toFixed(0)}`);
  assert.ok(r.max < 3000);
});

test("the cartridge is deterministic", () => {
  const pads = (f: number) => [0x10, 0x40, 0x20, 0x04, 0x01, 0x02, 0x80][(f >> 4) % 7] * ((f & 15) === 0 ? 1 : 0);
  assert.equal(boot(pads, 600).hash(), boot(pads, 600).hash());
});
