// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// test-tier: slow (many whole-machine frames; `npm run test:fast` skips this file, `npm test` runs it)
// Cue Sound Driver (roms/lib/cuesound.inc) running on the full machine, driven through a
// mailbox harness (tests/fixtures/snd-harness.asm). Expected pitches come from the note table
// of manual 6.8 and the effect formulas in roms/lib/README.md, computed by hand in comments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assemble } from "../src/asm/assembler.ts";
import { sourceReader } from "../tools/art.ts";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";
import { FREQ_TABLE, noteNumber, TEMPO_ONE } from "../tools/song.ts";
import { tickCycles } from "../tools/song-wav.ts";

const asm = assemble("tests/fixtures/snd-harness.asm", sourceReader(p => readFileSync(p, "utf8")));
if (asm.errors.length) throw new Error(asm.errors.map(e => `${e.file}:${e.line}: ${e.message}`).join("\n"));
const S = (n: string) => { const v = asm.symbols.get(n); if (v === undefined) throw new Error(`no symbol ${n}`); return v; };
const RAM = S("SND_RAM");
const F = (n: string) => FREQ_TABLE[noteNumber(n)];

const C = { play: 1, sfx: 2, stop: 3, tempo: 4, fade: 5, status: 6, r_init: 7, r_play: 8, r_stop: 9, r_sfx: 10, r_tick: 11, r_tempo: 12, r_fade: 13, r_status: 14, s_play: 15, s_sfx: 16, s_status: 17, s_tick: 18 };

function boot(): Machine {
  const m = new Machine(asm.rom, { cpu: new Tally() });
  m.runFrame(0, 0);
  m.audio.takeSamples();
  return m;
}
const poke = (m: Machine, a: number, v: number) => { m.wram[a - 0x8000] = v & 255; m.wram[a - 0x7fff] = (v >> 8) & 255; };
function cmd(m: Machine, c: number, arg = 0) { poke(m, 0x8000, c); poke(m, 0x8002, arg); m.runFrame(0, 0); }
const run = (m: Machine, n: number) => { for (let i = 0; i < n; i++) m.runFrame(0, 0); };
const status = (m: Machine) => { cmd(m, C.status); return m.peek16(0x8004); };
/** FREQ, WAVE, ENV, keyed of voice v. */
const voice = (m: Machine, v: number) => [m.peek16(0xf080 + 8 * v), m.peek16(0xf082 + 8 * v), m.peek16(0xf084 + 8 * v), m.peek16(0xf086 + 8 * v) & 1];
const rows = (m: Machine) => m.peek16(RAM + 8);
const rms = (s: Int16Array) => Math.sqrt(s.reduce((a, x) => a + x * x, 0) / Math.max(1, s.length));

test("SND_INIT: all voices off, master volume 15, fixed RAM footprint", () => {
  assert.equal(S("SND_RAM_SIZE"), 272);
  const m = boot();
  for (let v = 0; v < 4; v++) assert.equal(voice(m, v)[3], 0);
  assert.equal(m.peek16(0xf0b0), 15);
  assert.equal(status(m), 0);
  // every track knows its voice: tracks 0-3 (music) and 4-7 (effects) drive voices 0-3
  for (let t = 0; t < 8; t++) assert.equal(m.peek16(RAM + 16 + 32 * t + 8), 0xf080 + 8 * (t & 3));
});

test("the Sound Test theme plays: every second of the first ten is audible", () => {
  const m = boot();
  cmd(m, C.play, S("SONG_theme"));
  assert.equal(status(m) & 0x0f, 0x0f, "music on all four voices");
  for (let s = 0; s < 10; s++) {
    run(m, 60);
    const r = rms(m.audio.takeSamples());
    assert.ok(r > 1500, `second ${s}: rms ${r.toFixed(0)}`);
  }
});

test("the theme loops: one loop later the driver and voice registers repeat exactly", () => {
  const m = boot();
  cmd(m, C.play, S("SONG_theme"));
  const ROWS = S("SONG_theme_ROWS"), LOOP = S("SONG_theme_LOOP_ROWS"), FPR = TEMPO_ONE / S("SONG_theme_RATE");
  assert.equal([ROWS, LOOP, FPR].join(), "288,256,6");
  const snap = () => JSON.stringify([[0, 1, 2, 3].map(v => voice(m, v)), Array.from(m.wram.subarray(RAM - 0x8000, RAM - 0x8000 + 272)).filter((_, i) => i !== 8 && i !== 9)]);
  // second pass through the loop starts on row ROWS (0-based), third pass on row ROWS + LOOP
  while (rows(m) < ROWS + 1) m.runFrame(0, 0);
  const fa = m.frame, first: string[] = [];
  for (let i = 0; i < LOOP * FPR; i++) { first.push(snap()); m.runFrame(0, 0); }
  assert.equal(rows(m), ROWS + LOOP + 1, "one loop later = LOOP rows");
  assert.equal(m.frame - fa, LOOP * FPR);
  for (let i = 0; i < LOOP * FPR; i++) {
    assert.equal(snap(), first[i], `frame ${i} of the loop differs one loop later`);
    m.runFrame(0, 0);
  }
});

test("an effect borrows its voice; the other voices play on exactly as without it, then the voice returns", () => {
  const a = boot(), b = boot();
  for (const m of [a, b]) { cmd(m, C.play, S("SONG_theme")); run(m, 400); }
  cmd(a, C.status); cmd(b, C.sfx, S("SFX_jump"));      // same frame count on both
  let v2differs = false;
  for (let f = 0; f < 11; f++) {
    run(a, 1); run(b, 1);
    for (const v of [0, 1, 3]) assert.deepEqual(voice(b, v), voice(a, v), `frame ${f} voice ${v}`);
    if (voice(b, 2).join() !== voice(a, 2).join()) v2differs = true;
    if (f < 10) {
      // jumpy: pulse 50%, C-5 rising 48 per frame, keyed
      assert.deepEqual(voice(b, 2), [F("C-5") + 48 * (f + 1), 2, 0x4d, 1], `effect frame ${f}`);
      assert.equal(b.peek8(RAM + 16 + 32 * 2 + 19), 1, "music track of voice 2 muted");
    }
  }
  assert.ok(v2differs);
  assert.equal(voice(b, 2)[3], 0, "effect over: voice keyed off until the music's next note");
  assert.equal(status(b), 0x0f, "effect finished, music on all voices");
  run(a, 1);
  let back = -1;
  for (let f = 0; f < 60 && back < 0; f++) {
    run(a, 1); run(b, 1);
    if (voice(b, 2).join() === voice(a, 2).join() && voice(b, 2)[3] === 1) back = f;
  }
  assert.ok(back >= 0, "voice 2 plays the music again");
  for (let f = 0; f < 200; f++) { run(a, 1); run(b, 1); assert.deepEqual([0, 1, 2, 3].map(v => voice(b, v)), [0, 1, 2, 3].map(v => voice(a, v))); }
});

test("a noise effect borrows voice 3; the tone voices are untouched", () => {
  const a = boot(), b = boot();
  for (const m of [a, b]) { cmd(m, C.play, S("SONG_theme")); run(m, 250); }
  cmd(a, C.status); cmd(b, C.sfx, S("SFX_boom"));
  for (let f = 0; f < 40; f++) {
    run(a, 1); run(b, 1);
    for (const v of [0, 1, 2]) assert.deepEqual(voice(b, v), voice(a, v));
    assert.equal(voice(b, 3)[0], Math.max(0, 9000 - 150 * (f + 1)), "blast: fixed 9000 sliding -150 per frame");
  }
  assert.notEqual(b.peek16(RAM + 16 + 32 * 7), 0, "effect track still reading after 40 frames");
  assert.equal(voice(b, 3)[3], 1);
  run(b, 1);
  assert.equal(b.peek16(RAM + 16 + 32 * 7), 0, "40 rows at speed 1, then the end marker");
  assert.equal(status(b) & 0x80, 0);
});

test("priority: a lower-priority effect is ignored, an equal or higher one replaces", () => {
  const m = boot();
  cmd(m, C.sfx, S("SFX_hi")); run(m, 1);
  assert.equal(voice(m, 2)[0], F("C-6"));
  cmd(m, C.sfx, S("SFX_lo")); run(m, 1);
  assert.equal(voice(m, 2)[0], F("C-6"), "priority 1 < 5 ignored");
  cmd(m, C.sfx, S("SFX_hi2")); run(m, 1);
  assert.equal(voice(m, 2)[0], F("G-6"), "priority 5 = 5 replaces");
  assert.equal(status(m), 0x40);
});

test("SND_STOP silences the music; a playing effect finishes", () => {
  const m = boot();
  cmd(m, C.play, S("SONG_theme")); run(m, 100);
  cmd(m, C.sfx, S("SFX_boom"));
  cmd(m, C.stop);
  for (const v of [0, 1, 2]) assert.equal(voice(m, v)[3], 0, `voice ${v} off`);
  assert.equal(voice(m, 3)[3], 1, "effect still sounding");
  assert.equal(status(m), 0x80);
  run(m, 45);
  assert.equal(status(m), 0);
});

test("SND_TEMPO overrides the song's tempo; 0 restores it; at most one row per frame", () => {
  const m = boot();
  cmd(m, C.play, S("SONG_theme")); run(m, 10);
  let r0 = rows(m); run(m, 120);
  assert.equal(rows(m) - r0, 20, "speed 6: 20 rows in 120 frames");
  cmd(m, C.tempo, TEMPO_ONE / 3);
  r0 = rows(m); run(m, 120);
  assert.equal(rows(m) - r0, 40, "rate for speed 3");
  cmd(m, C.tempo, 0);
  r0 = rows(m); run(m, 120);
  assert.equal(rows(m) - r0, 20);
  cmd(m, C.tempo, 65535);
  assert.equal(m.peek16(RAM + 2), TEMPO_ONE);
});

test("SND_FADE steps the master volume down every n frames, then stops the music at full volume", () => {
  const m = boot();
  cmd(m, C.play, S("SONG_theme")); run(m, 50);
  cmd(m, C.fade, 4);
  const vols: number[] = [];
  for (let f = 1; f <= 59; f++) { run(m, 1); vols.push(m.peek16(0xf0b0)); }
  assert.equal(vols[3], 14); assert.equal(vols[2], 15); assert.equal(vols[55], 1);
  for (let i = 1; i < vols.length; i++) assert.ok(vols[i] <= vols[i - 1]);
  assert.notEqual(m.peek16(RAM + 16) , 0, "still playing at volume 1");
  run(m, 1);
  assert.equal(m.peek16(0xf0b0), 15);
  assert.equal(status(m) & 0x0f, 0, "faded out: music stopped");
  // cancel
  cmd(m, C.play, S("SONG_theme"));
  cmd(m, C.fade, 2); run(m, 10);
  assert.ok(m.peek16(0xf0b0) < 15);
  cmd(m, C.fade, 0);
  assert.equal(m.peek16(0xf0b0), 15);
  run(m, 100);
  assert.equal(status(m) & 0x0f, 0x0f);
});

test("a song without a loop plays once and its voices end", () => {
  const m = boot();
  cmd(m, C.play, S("SONG_honce"));
  assert.equal(status(m), 0x03);
  assert.deepEqual(voice(m, 0), [F("C-4"), 2, 0x0a, 1]);
  // speed 2: row r is played 2r frames after row 0
  run(m, 7);
  assert.equal(voice(m, 0)[3], 1);
  run(m, 1);
  assert.equal(voice(m, 0)[3], 0, "off on row 4");
  assert.equal(voice(m, 1)[3], 1);
  run(m, 7);
  assert.equal(status(m), 0);
  assert.equal(voice(m, 1)[3], 0);
});

test("per-frame effects: arpeggio, vibrato (after its delay), slide, fixed noise pitch", () => {
  const m = boot();
  poke(m, 0x8000, C.play); poke(m, 0x8002, S("SONG_hfx"));
  const seen: number[][][] = [];
  for (let f = 0; f < 14; f++) { m.runFrame(0, 0); seen.push([0, 1, 2, 3].map(v => voice(m, v))); }
  // row 0 is played by the tick of the frame after the command
  const T = seen.findIndex(s => s[0][3] === 1);
  assert.equal(T, 1);
  const at = (v: number, k: number) => seen[T + k][v][0];
  // arpeggio 0 4 7 on C-4, one step per frame
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(k => at(0, k)), [F("C-4"), F("E-4"), F("G-4"), F("C-4"), F("E-4"), F("G-4")]);
  // vibrato depth 16 speed 32 delay 4 on A-4 (601): swing = (601>>4)*16>>6 = 9; phase from 64 in steps of 32;
  // offset = (9 * ((tri>>1) - 32)) >> 5 (arithmetic): 4, 8, 4, -1, -5, -9, -5, 0
  assert.deepEqual([...Array(12).keys()].map(k => at(1, k)), [601, 601, 601, 601, 605, 609, 605, 600, 596, 592, 596, 601]);
  // slide +100 per frame from A-4 (the first frame already includes one step)
  assert.deepEqual([0, 1, 2].map(k => at(2, k)), [701, 801, 901]);
  // noise: fixed FREQ 40000, long mode
  assert.deepEqual(seen[T][3].slice(0, 3), [40000, 0, 0x28]);
  // loop step: pfall (-2000 per frame from C-5) clamps at FREQ 0
  run(m, 20);
  assert.equal(voice(m, 2)[0], 0);
});

test("a song's wavetable is loaded into WAVE0-7 when it starts", () => {
  const m = boot();
  cmd(m, C.play, S("SONG_hwave"));
  const wt = [0, 1, 2, 3, 4, 5, 6, 7].map(i => m.peek16(0xf0a0 + 2 * i));
  assert.deepEqual(wt, [0xca98, 0xfeed, 0xeeff, 0x9acd, 0x3568, 0x0112, 0x1100, 0x6532]);   // manual 6.4 sine
  run(m, 1);
  assert.deepEqual(voice(m, 2), [F("C-4"), 6, 0x0a, 1]);
});

test("assembly convention: R1-R7 preserved by every entry, R0 too by SND_TICK", () => {
  const m = boot();
  const regs = () => [...Array(8).keys()].map(i => m.peek16(0x8010 + 2 * i));
  const expect = (r0: number | null) => { const r = regs(); assert.deepEqual(r.slice(1), [0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777]); if (r0 !== null) assert.equal(r[0], r0); };
  cmd(m, C.r_play, S("SONG_theme")); expect(null);
  cmd(m, C.r_sfx, S("SFX_gem")); expect(null);
  cmd(m, C.r_tick, 0x1234); expect(0x1234);
  cmd(m, C.r_tempo, 0); expect(null);
  cmd(m, C.r_fade, 0); expect(null);
  cmd(m, C.r_status); expect(0x4f);
  cmd(m, C.r_stop); expect(null);
  cmd(m, C.r_init); expect(null);
  assert.equal(status(m), 0);
});

test("SCRIM convention: stack entries take the pushed word, keep SP balanced and R1-R7 intact", () => {
  const m = boot();
  const regs = () => [...Array(8).keys()].map(i => m.peek16(0x8010 + 2 * i));
  const balanced = () => assert.equal(m.peek16(0x8008), m.peek16(0x8006));
  cmd(m, C.s_play, S("SONG_theme")); balanced();
  assert.deepEqual(regs().slice(1), [0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777]);
  cmd(m, C.s_sfx, S("SFX_boom")); balanced();
  cmd(m, C.s_status); balanced();
  assert.equal(regs()[0], 0x8f);
  cmd(m, C.s_tick, 0x4321); balanced();
  assert.deepEqual(regs(), [0x4321, 0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777]);
});

test("SND_TICK costs a small fraction of the 59,736-cycle frame (measured worst case)", (t) => {
  const worst: number[] = [];
  // theme with an effect fired every 9 frames, rotating through all four
  {
    const m = boot();
    cmd(m, C.play, S("SONG_theme"));
    const fx = ["SFX_jump", "SFX_gem", "SFX_power", "SFX_boom"].map(S);
    const r = tickCycles(m, S("SND_TICK"), 1800, f => { if (f % 9 === 0) { poke(m, 0x8000, C.sfx); poke(m, 0x8002, fx[(f / 9) % 4]); } });
    worst.push(r.max);
    t.diagnostic(`theme + effects: SND_TICK max ${r.max} cycles, mean ${r.mean.toFixed(0)} over ${r.calls} calls`);
  }
  // every effect feature at once on all four voices, plus an effect on voice 2
  {
    const m = boot();
    cmd(m, C.play, S("SONG_hfx"));
    const r = tickCycles(m, S("SND_TICK"), 300, f => { if (f % 25 === 0) { poke(m, 0x8000, C.sfx); poke(m, 0x8002, S("SFX_hi")); } });
    worst.push(r.max);
    t.diagnostic(`arp+vibrato+slide+noise: SND_TICK max ${r.max} cycles, mean ${r.mean.toFixed(0)}`);
  }
  const max = Math.max(...worst);
  assert.ok(max < 3000, `worst SND_TICK ${max} cycles (limit 3000 = 5% of a frame)`);
});

test("the driver is deterministic: same commands, same machine hash", () => {
  const go = () => {
    const m = boot();
    cmd(m, C.play, S("SONG_theme"));
    for (let i = 0; i < 20; i++) { run(m, 13); cmd(m, C.sfx, S(i % 2 ? "SFX_boom" : "SFX_jump")); }
    return m.hash();
  };
  assert.equal(go(), go());
});
