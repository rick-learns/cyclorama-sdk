// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Tutorial 2 (docs/guide/tutorial-2-scrim.md): the SCRIM game of examples/tutorial-2/, checked on
// the emulator from power-on through the controller port only. The test reads work RAM, video
// and audio state to judge what the page says the program does; it never writes machine state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compile } from "../src/scrim/compile.ts";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";
import { Cue } from "../src/machine/audio.ts";
import { rgbOf } from "../src/machine/video/render.ts";
import { buildOne, sha256 } from "../tools/build-roms.ts";
import { sampleRanges } from "../tools/doc-check.ts";
import { budgetReport } from "../tools/budget.ts";
import { tickCycles } from "../tools/song-wav.ts";

const SRC = "examples/tutorial-2/tutorial-2.scr";
const UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8;
const GSTATE = 0x8000, PLAY = 1, WON = 2, GEMS = 5;

const compiled = compile(SRC, p => readFileSync(p));
const rom = compiled.rom ?? new Uint8Array(0);
const sym = (n: string) => { const a = compiled.symbols?.get(n); if (a === undefined) throw new Error(`no symbol ${n}`); return a; };
const romWord = (a: number) => rom[a] | (rom[a + 1] << 8);
/** The gem positions, read from the ROM's gemX and gemY tables. */
const gems = () => Array.from({ length: GEMS }, (_, i) => ({ x: romWord(sym("gemX") + 2 * i), y: romWord(sym("gemY") + 2 * i) }));

/** A Cue that notes every key-on (frame, voice) without changing what it does. */
class KeyLog extends Cue {
  frame = 0;
  keys: { frame: number; voice: number }[] = [];
  override write(addr: number, value: number, byteHalf?: 0 | 1): void {
    if (addr >= 0xf080 && addr < 0xf0a0 && (addr & 7) === 6 && byteHalf !== 1 && (value & 1)) this.keys.push({ frame: this.frame, voice: (addr - 0xf080) >> 3 });
    super.write(addr, value, byteHalf);
  }
}

class Run {
  audio = new KeyLog();
  m = new Machine(rom, { cpu: new Tally(), audio: this.audio });
  f = 0;
  pads: number[] = [];
  word(a: number) { return this.m.peek16(a); }
  get px() { return this.word(sym("px")); }
  get py() { return this.word(sym("py")); }
  get got() { return this.word(sym("got")); }
  get state() { return this.word(GSTATE); }
  frame(pad = 0) { this.audio.frame = this.f; this.pads.push(pad); this.m.runFrame(pad, 0); this.f++; return this; }
  frames(n: number, pad = 0) { for (let i = 0; i < n; i++) this.frame(pad); return this; }
  /** Power on and run until start-up has switched the display on and the frame loop has run once. */
  started() {
    while (!(this.m.video.regs.VCTRL & 1) && this.f < 30) this.frame();
    assert.ok(this.m.video.regs.VCTRL & 1, "the display is on within 30 frames");
    return this.frame();
  }
  /** Walk the player's top-left to (x, y) with the D-pad, sideways first, reading where it is;
   *  stop early once `done()` holds. */
  walkTo(x: number, y: number, onFrame = () => {}, done = () => false) {
    for (let guard = 0; guard < 400 && (this.px !== x || this.py !== y) && !done(); guard++) {
      const pad = this.px < x ? RIGHT : this.px > x ? LEFT : this.py < y ? DOWN : UP;
      this.frame(pad);
      onFrame();
    }
    assert.ok(done() || (this.px === x && this.py === y), `walked to ${x},${y}`);
    return this;
  }
  oam(i: number) { const o = this.m.video.oam, w = (k: number) => o[i * 8 + k] | (o[i * 8 + k + 1] << 8); return { y: w(0) & 0x1ff, x: w(2) & 0x1ff, attr: w(4), size: w(6) }; }
  px2(x: number, y: number) { return this.m.framebuffer[y * 256 + x]; }
  cram(i: number) { return rgbOf(this.m.video.cram[i]); }
  /** The picture's pixels in the 16 x 16 box at (x, y). */
  box(x: number, y: number) { const out: number[] = []; for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) out.push(this.px2(x + c, y + r)); return out; }
}

test(`${SRC}: builds reproducibly as a 32 KiB TUTORIAL 2 cartridge; GSTATE at 8000 is PLAY after start-up`, () => {
  assert.deepEqual(compiled.errors, []);
  assert.equal(rom.length, 32768);
  assert.equal(sha256(buildOne({ name: SRC, file: SRC, lang: "scrim" })), sha256(rom), "the gate's build gives the same bytes");
  assert.equal(String.fromCharCode(...rom.subarray(0x18, 0x30)).trimEnd(), "TUTORIAL 2");
  assert.equal(romWord(0x30), 0x0000, "developer code 0000");
  assert.equal(sym("gstate"), GSTATE, "gstate is the first VAR, at 8000");
  const r = new Run().started();
  assert.equal(r.state, PLAY);
  assert.equal(r.got, 0);
  assert.deepEqual([r.px, r.py], [120, 104], "the player starts in the middle");
});

test(`${SRC}: the D-pad moves the player sprite 2 pixels a frame, and it stays on screen`, () => {
  const r = new Run().started();
  const x0 = r.px, y0 = r.py;
  r.frames(10, RIGHT);
  assert.deepEqual([r.px - x0, r.py - y0], [20, 0], "10 frames of Right = 20 pixels");
  r.frames(5, UP);
  assert.deepEqual([r.px - x0, y0 - r.py], [20, 10], "5 frames of Up = 10 pixels");
  const s = r.oam(0);
  assert.deepEqual([s.x, s.y, s.size & 3], [r.px, r.py, 1], "sprite 0 is the player: 16x16, shown, at px,py");
  assert.equal(s.attr & 0x8000, 0x8000, "the player sprite is unlit");
  r.frames(200, LEFT | UP);
  assert.deepEqual([r.px, r.py, r.oam(0).x, r.oam(0).y], [0, 0, 0, 0], "stops at the top-left corner");
  r.frames(200, RIGHT | DOWN);
  assert.deepEqual([r.px, r.py, r.oam(0).x, r.oam(0).y], [240, 208, 240, 208], "stops at the bottom-right corner (256-16, 224-16)");
});

test(`${SRC}: light 0 is an octagon that follows the player's centre`, () => {
  const r = new Run().started();
  const at = () => { const g = r.m.video.regs; return [g.L0X, g.L0Y]; };
  assert.deepEqual(at(), [r.px + 8, r.py + 8]);
  r.frames(12, RIGHT | DOWN);
  assert.deepEqual(at(), [r.px + 8, r.py + 8]);
  r.frames(30, LEFT);
  assert.deepEqual(at(), [r.px + 8, r.py + 8]);
  const g = r.m.video.regs;
  assert.equal((g.L0F >> 4) & 3, 2, "shape 2: octagon");
  assert.equal(g.L0I & 15, 7, "intensity 7");
  assert.equal(g.AMBIENT & 7, 0, "AMBIENT 0: dark outside the light");
  assert.equal(g.VCTRL & 16, 16, "light field on");
});

test(`${SRC}: a gem far from the light is dark; standing next to it shows it`, () => {
  const r = new Run().started();
  const g = gems()[0];
  const s = r.oam(1);
  assert.deepEqual([s.x, s.y, s.size & 3, s.attr & 0x8000], [g.x, g.y, 1, 0], "sprite 1 is gem 0: 16x16, shown, lit");
  const gemColours = new Set<number>(), floorColours = new Set<number>();
  for (let sh = 1; sh < 8; sh++) {
    for (let k = 1; k < 5; k++) gemColours.add(r.cram(sh * 64 + 40 + k));    // sprite palette 1, colours 1-4
    for (let k = 0; k < 3; k++) floorColours.add(r.cram(sh * 64 + k));       // backdrop and floor
  }
  assert.ok(![...gemColours].some(c => floorColours.has(c)), "gem and floor colours can be told apart");
  assert.deepEqual([r.m.video.cram[7 * 64 + 40 + 4], r.m.video.cram[0 * 64 + 40 + 4]], [0xcff, 0], "the glint: as drawn in plane 7, black in plane 0");
  const dark = r.box(g.x, g.y);
  assert.ok(dark.every(p => p === r.cram(0)), "in the dark every pixel of the gem's box is the unlit floor colour (shade 0)");
  r.walkTo(g.x + 20, g.y);                                            // beside it, not touching
  assert.equal(r.got, 0, "not collected");
  const lit = r.box(g.x, g.y).filter(p => gemColours.has(p)).length;
  assert.ok(lit >= 40, `${lit} gem-coloured pixels in the light`);
});

test(`${SRC}: collecting all 5 gems plays the effect each time, fills the row of icons, and wins`, () => {
  const r = new Run().started();
  const pickups: number[] = [];
  let last = 0;
  const watch = () => {
    assert.ok(r.got === last || r.got === last + 1, "one gem at a time");
    if (r.got !== last) { pickups.push(r.f - 1); last = r.got; }
  };
  const icon = (i: number) => { const a = 0x6000 + (64 + 12 + 2 * i) * 2; return r.m.video.vram[a] | (r.m.video.vram[a + 1] << 8); };
  const empty = icon(0), full = [] as number[];
  for (let i = 0; i < GEMS; i++) assert.equal(icon(i), empty, `slot ${i} starts empty`);
  assert.equal(empty & 0x8000, 0x8000, "HUD icons are unlit");
  gems().forEach((g, i) => {
    r.walkTo(g.x, g.y, watch, () => r.got > i);                        // until gem i is collected
    assert.equal(r.got, i + 1, `gem ${i} collected`);
    full.push(icon(i));
  });
  assert.equal(pickups.length, GEMS, "five pickups");
  assert.equal(r.got, GEMS);
  const x = r.px, y = r.py;
  r.frames(40, LEFT | UP);                                            // the pad after the win
  for (let i = 0; i < GEMS; i++) {
    assert.notEqual(icon(i), empty, `slot ${i} filled`);
    assert.ok(r.audio.keys.some(k => k.voice === 2 && k.frame >= pickups[i] && k.frame <= pickups[i] + 2), `pickup ${i + 1} at frame ${pickups[i]} keys the effect on voice 2`);
  }
  assert.equal(new Set(full).size, 1, "every filled slot shows the same icon");
  // The fifth gem wins: state WON, the win jingle, a wider light, and the pad does nothing.
  assert.equal(r.state, WON);
  assert.equal(r.word(sym("SND_SONG")), sym("SONG_win"), "the driver is playing SONG_win");
  const won = pickups[GEMS - 1];
  assert.ok(r.audio.keys.some(k => k.voice === 0 && k.frame > won && k.frame <= won + 3), "the jingle's first note");
  const jingle = r.audio.keys.filter(k => k.frame > won && k.voice < 2).length;
  assert.ok(jingle >= 6, `${jingle} jingle notes on voices 0-1 in 40 frames`);
  assert.equal(r.m.video.regs.L0F & 7, 5, "falloff 5: the light widens");
  assert.deepEqual([r.px, r.py, r.state], [x, y, WON], "after the win the pad does nothing");
  // The budget report of the same input: the effect's voice is keyed; without pickups it is not.
  const pads = r.pads;
  const rep = budgetReport(rom, { frames: pads.length, pads: f => [pads[f] ?? 0, 0] });
  assert.ok(rep.audio.keyedVoices.includes(2), `voices keyed ${rep.audio.keyedVoices}`);
  assert.deepEqual(rep.violations, []);
  assert.equal(rep.cpu.overrunFrames, 0);
  assert.equal(rep.video.framesWithMidFrameLightChanges, 0, "the light moves only in vertical blank");
  assert.ok(rep.video.maxSpritesOnLine <= 6);
  assert.equal(rep.hash, r.m.hash(), "the metered run is the same run");
  const quiet = budgetReport(rom, { frames: pads.length });
  assert.ok(!quiet.audio.keyedVoices.includes(2), "no gem, no effect");
  // The driver's cost on the same input (theme, five effects, the jingle): within the kit's 3,000-cycle limit.
  const tick = tickCycles(new Machine(rom, { cpu: new Tally() }), sym("SndTick"), pads.length, undefined, f => [pads[f] ?? 0, 0]);
  assert.ok(tick.calls >= pads.length - 10 && tick.max < 3000, `SndTick: ${tick.calls} calls, max ${tick.max} cycles, mean ${Math.round(tick.mean)}`);
  // The page's numbers: "about 1,200 at most" for SndTick, "at most about 2,200" for a whole frame.
  assert.ok(tick.max <= 1300, `SndTick max ${tick.max}`);
  assert.ok(rep.cpu.busy.max <= 2300, `busy max ${rep.cpu.busy.max} cycles a frame`);
  console.log(`# tutorial-2: ${pads.length} frames, cpu max ${rep.cpu.percentOfBudget.max}% p95 ${rep.cpu.percentOfBudget.p95}%, busy max ${rep.cpu.busy.max}, SndTick max ${tick.max} mean ${Math.round(tick.mean)}, sprites/line ${rep.video.maxSpritesOnLine}, hash ${rep.hash}`);
});

test(`${SRC}: the theme is audible from power-on`, () => {
  const rep = budgetReport(rom, { frames: 120 });
  assert.ok(rep.audio.keyedVoices.includes(0) && rep.audio.keyedVoices.includes(1), `voices keyed in 120 frames: ${rep.audio.keyedVoices}`);
  const r = new Run();
  let loud = 0;
  const notes = new Set<number>();
  for (let f = 0; f < 120; f++) {
    r.frame();
    for (const s of r.audio.takeSamples()) loud = Math.max(loud, Math.abs(s));
    notes.add(r.m.peek16(0xf080));                                    // V0FREQ: the lead's pitch
  }
  assert.ok(loud > 1000, `peak sample ${loud}`);
  assert.ok(notes.size >= 4, `${notes.size} distinct lead pitches in 2 seconds`);
  assert.equal(r.word(sym("SND_SONG")), sym("SONG_theme"));
});

test("docs/guide/tutorial-2-scrim.md quotes the whole program, in file order (type the excerpts in order and it compiles)", () => {
  const ranges = sampleRanges(readFileSync("docs/guide/tutorial-2-scrim.md", "utf8")).filter(r => r.path === SRC);
  const starts = ranges.map(r => r.from ?? 1);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), "excerpts of the program appear in file order");
  const lines = readFileSync(SRC, "utf8").split("\n");
  const covered = new Set<number>();
  for (const r of ranges) for (let i = r.from ?? 1; i <= (r.to ?? lines.length); i++) covered.add(i);
  const missing = lines.map((l, i) => [l, i] as const).filter(([l, i]) => l.trim() && !(i < 6 && l.startsWith("--")) && !covered.has(i + 1)).map(([l, i]) => `${i + 1}: ${l}`);
  assert.deepEqual(missing, [], "every line of the program is quoted");
});
