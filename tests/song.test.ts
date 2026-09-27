// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Song converter: Cyclorama ".song" text files -> CYASM include text for the Cue Sound Driver
// (roms/lib/cuesound.inc). Expected bytes below are written from the format description in
// tools/song.ts and roms/lib/README.md, not read back from the implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertSong, parseSong, noteNumber, FREQ_TABLE, TEMPO_ONE, rateForSpeed, rateForBpm, FRAME_RATE } from "../tools/song.ts";
import { sourceReader } from "../tools/art.ts";
import { assemble } from "../src/asm/assembler.ts";

const SRC = `; a tiny song file
instrument lead
  wave pulse25
  env 12 down 2
  vibrato 8 6 delay 10
instrument bass
  wave triangle
  env 10 hold
instrument chord
  wave pulse12
  env 9 down 3
  arp 0 4 7
instrument kick
  wave noise
  env 15 down 1
  fixed $1800
  slide -256
instrument zap
  wave saw
  env 13 up 1
  slide 40

pattern mel inst lead
  C-4:2 --- off E-4@bass | ---:3
pattern low inst bass
  C-3:4 G-2:4
pattern beat
  kick --- kick:2 off:4
pattern arps inst chord
  C-4:8

song tiny
  title "TINY TUNE"
  speed 6
  voices 0 1 3
  order mel low beat
  loop
  order -   low beat
  order mel low -

sfx pew voice 2 priority 3 speed 2 inst zap
  C-5:3 E-5

song once
  tempo 150
  voices 2
  wavetable 0123456789ABCDEFFEDCBA9876543210
  order arps
`;

function build(src = SRC) {
  const inc = convertSong(src, "t.song");
  const r = assemble("m.asm", p => (p === "m.asm" ? ".org $100\n.include \"t.song.inc\"\n" : inc));
  assert.deepEqual(r.errors, [], inc);
  const sym = (n: string) => { const v = r.symbols.get(n); assert.ok(v !== undefined, `symbol ${n}`); return v!; };
  const b = (a: number) => r.rom[a];
  const w = (a: number) => r.rom[a] | (r.rom[a + 1] << 8);
  const bytes = (a: number, n: number) => Array.from(r.rom.subarray(a, a + n));
  return { r, sym, b, w, bytes, inc };
}

test("note names: tracker style, sharps and flats, octaves 0-8", () => {
  assert.equal(noteNumber("C-0"), 0);
  assert.equal(noteNumber("C-4"), 48);
  assert.equal(noteNumber("C#4"), 49);
  assert.equal(noteNumber("Db4"), 49);
  assert.equal(noteNumber("A-4"), 57);
  assert.equal(noteNumber("B-8"), 107);
  assert.equal(noteNumber("Cb4"), 47);
  for (const bad of ["H-4", "C-9", "C4", "c-4x", "B#8"]) assert.equal(noteNumber(bad), -1, bad);
});

test("frequency table: equal temperament A4 = 440 Hz, FREQ = round(f x 65536 / 47940.34) (manual 6.8)", () => {
  assert.equal(FREQ_TABLE.length, 108);
  const n = (s: string) => FREQ_TABLE[noteNumber(s)];
  assert.equal(n("A-2"), 150);
  assert.equal(n("C-4"), 358);
  assert.equal(n("E-4"), 451);
  assert.equal(n("G-4"), 536);
  assert.equal(n("A-4"), 601);
  assert.equal(n("C-5"), 715);
  assert.equal(n("A-5"), 1203);
  assert.equal(n("C-7"), 2861);
  for (let i = 1; i < 108; i++) assert.ok(FREQ_TABLE[i] > FREQ_TABLE[i - 1]);
});

test("tempo: speed N rows are exactly N frames; BPM converts through the 59.92 Hz frame rate", () => {
  assert.equal(TEMPO_ONE, 55440);
  for (const s of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16]) assert.equal(rateForSpeed(s) * s, TEMPO_ONE, `speed ${s}`);
  assert.ok(Math.abs(FRAME_RATE - 59.9227) < 1e-3);
  // 150 BPM, 4 rows per beat = 10 rows/s; per frame 10 / 59.9227 of a row.
  assert.equal(rateForBpm(150, 4), Math.round(10 / FRAME_RATE * TEMPO_ONE));
  assert.throws(() => rateForSpeed(0));
});

test("instruments: 16-byte records (wave, env, fixed, slide, vibrato, arp)", () => {
  const { sym, b, w, bytes } = build();
  const I = sym("SNDI_t");
  assert.equal(I % 2, 0);
  // lead: pulse25 (1), env 12 | down | period 2 << 5 = $4C, vibrato 8/6 delay 10
  assert.deepEqual(bytes(I, 16), [1, 0x4c, 0, 0, 0, 0, 8, 6, 10, 0, 0, 0, 0, 0, 0, 0]);
  // bass: triangle (4), env 10 hold = $0A
  assert.deepEqual(bytes(I + 16, 10), [4, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
  // chord: pulse12 (0), env 9 down 3 = $69, arp 3 entries -> table 0 4 7
  assert.equal(b(I + 32), 0); assert.equal(b(I + 33), 0x69); assert.equal(b(I + 41), 3);
  assert.deepEqual(bytes(w(I + 42), 3), [0, 4, 7]);
  // kick: noise long (0), env 15 down 1 = $2F, fixed $1800, slide -256
  assert.deepEqual(bytes(I + 48, 6), [0, 0x2f, 0x00, 0x18, 0x00, 0xff]);
  // zap: saw (5), env 13 up 1 = $3D, slide +40
  assert.deepEqual(bytes(I + 64, 6), [5, 0x3d, 0, 0, 40, 0]);
});

test("patterns: note / wait / off / instrument bytes, end marker FF", () => {
  const { sym, bytes } = build();
  // C-4:2 then --- : note 48 then 2 empty rows ($81); off; E-4 with bass (instr 1) then back to lead;
  // ---:3 -> $82. Pattern starts by selecting its instrument (C1 00).
  assert.deepEqual(bytes(sym("SNDP_t_mel"), 9), [0xc1, 0, 48, 0x81, 0xc0, 0xc1, 1, 52, 0x82]);
  assert.equal(bytes(sym("SNDP_t_mel") + 9, 1)[0], 0xff);
  assert.deepEqual(bytes(sym("SNDP_t_low"), 7), [0xc1, 1, 36, 0x82, 31, 0x82, 0xff]);
  // drum triggers: instrument name = note at the instrument's fixed pitch (note byte 0)
  assert.deepEqual(bytes(sym("SNDP_t_beat"), 9), [0xc1, 3, 0, 0x80, 0, 0x80, 0xc0, 0x82, 0xff]);
});

test("waits longer than 64 rows split into several wait bytes", () => {
  const src = "instrument a\n wave pulse50\n env 9\npattern p inst a\n C-4 ---:100\nsong s\n speed 3\n voices 0\n order p\n";
  const { sym, bytes } = build(src);
  // one note row, then 100 empty rows = 64 ($BF) + 36 ($A3)
  assert.deepEqual(bytes(sym("SNDP_t_p"), 6), [0xc1, 0, 48, 0xbf, 0x80 + 35, 0xff]);
});

test("songs: header (rate, instruments, wavetable, 4 order lists) and order lists with loop point", () => {
  const { sym, w, inc } = build();
  const S = sym("SONG_tiny");
  assert.equal(S % 2, 0);
  assert.equal(w(S), 9240);                 // speed 6
  assert.equal(sym("SONG_tiny_RATE"), 9240);
  assert.equal(w(S + 2), sym("SNDI_t"));
  assert.equal(w(S + 4), 0);                // no wavetable
  const o0 = w(S + 6), o1 = w(S + 8), o2 = w(S + 10), o3 = w(S + 12);
  assert.equal(o2, 0, "voice 2 unused by this song");
  // voice 0: mel, (loop) rest16?, mel, 0, loop target
  const rest8 = w(o0 + 2);
  assert.deepEqual([w(o0), w(o0 + 4), w(o0 + 6), w(o0 + 8)], [sym("SNDP_t_mel"), sym("SNDP_t_mel"), 0, o0 + 2]);
  assert.notEqual(rest8, 0);
  assert.deepEqual([w(o1), w(o1 + 2), w(o1 + 4), w(o1 + 6), w(o1 + 8)], [sym("SNDP_t_low"), sym("SNDP_t_low"), sym("SNDP_t_low"), 0, o1 + 2]);
  const r3 = w(o3 + 4);
  assert.deepEqual([w(o3), w(o3 + 2), w(o3 + 6), w(o3 + 8)], [sym("SNDP_t_beat"), sym("SNDP_t_beat"), 0, o3 + 2]);
  assert.equal(r3, rest8, "rest patterns of equal length are shared");
  assert.equal(sym("SONG_tiny_LOOP_ROWS"), 16);
  assert.equal(sym("SONG_tiny_ROWS"), 24);
  assert.match(inc, /SONG_tiny_TITLE:\s*\n?\s*\.asciz "TINY TUNE"/);
});

test("rest patterns: n empty rows then FF", () => {
  const { w, sym, bytes } = build();
  const rest = w(w(sym("SONG_tiny") + 6) + 2);
  assert.deepEqual(bytes(rest, 2), [0x87, 0xff]);
});

test("a song without 'loop' ends (loop target 0); wavetable packs sample j into WAVE(j>>2) bits 4(j&3)", () => {
  const { sym, w } = build();
  const S = sym("SONG_once");
  assert.equal(w(S), rateForBpm(150, 4));
  const o2 = w(S + 10);
  assert.deepEqual([w(o2), w(o2 + 2), w(o2 + 4)], [sym("SNDP_t_arps"), 0, 0]);
  assert.equal(w(S + 6), 0);
  const wt = w(S + 4);
  assert.equal(w(wt), 0x3210);
  assert.equal(w(wt + 2), 0x7654);
  assert.equal(w(wt + 8), 0xcdef);
  assert.equal(w(wt + 14), 0x0123);
  assert.equal(sym("SONG_once_LOOP_ROWS"), 0);
});

test("sfx: header (voice, priority, speed, instruments) then pattern bytes", () => {
  const { sym, b, w, bytes } = build();
  const X = sym("SFX_pew");
  assert.equal(X % 2, 0);
  assert.deepEqual([b(X), b(X + 1), b(X + 2), b(X + 3)], [2, 3, 2, 0]);
  assert.equal(w(X + 4), sym("SNDI_t"));
  assert.deepEqual(bytes(X + 6, 6), [0xc1, 4, 60, 0x81, 64, 0xff]);
});

test("parseSong exposes the model: loop start, steps, frames per loop", () => {
  const m = parseSong(SRC, "t.song");
  const s = m.songs.find(x => x.name === "tiny")!;
  assert.equal(s.loopStep, 1);
  assert.deepEqual(s.steps.map(x => x.rows), [8, 8, 8]);
  assert.deepEqual(s.voices, [0, 1, 3]);
  assert.equal(m.sfx[0].voice, 2);
  assert.equal(m.prefix, "t");
});

test("the file prefix comes from the base name, made into a symbol", () => {
  const inc = convertSong("instrument a\n wave saw\n env 9\n", "roms/x/sound-test.song");
  assert.match(inc, /^SNDI_sound_test:/m);
});

const bad = (src: string, re: RegExp) => assert.throws(() => convertSong(src, "e.song"), re);
const INST = "instrument a\n wave pulse50\n env 9\ninstrument n\n wave noise\n env 9\n fixed 100\n";

test("errors carry file:line and say what is wrong", () => {
  bad("frob x\n", /e\.song:1: .*unknown/);
  bad("instrument a\n wave sine\n", /e\.song:2: .*wave/);
  bad("instrument a\n env 16\n", /e\.song:2: .*volume/);
  bad("instrument a\n env 9 down 8\n", /e\.song:2: .*period/);
  bad("instrument a\n vibrato 40 2\n", /e\.song:2: .*depth/);
  bad("instrument a\n wave saw\n bogus 1\n", /e\.song:3: .*bogus/);
  bad(INST + "pattern p\n C-4\n", /e\.song:9: .*instrument/);
  bad(INST + "pattern p inst a\n C-4 Q-4\n", /e\.song:9: .*Q-4/);
  bad(INST + "pattern p inst a\n C-4@zz\n", /e\.song:9: .*zz/);
  bad(INST + "pattern p inst a\n a\n", /e\.song:9: .*fixed/);
  bad(INST + "pattern p inst a\n C-4:0\n", /e\.song:9: .*rows/);
  bad(INST + "pattern p inst a\n C-4\npattern p inst a\n D-4\n", /e\.song:10: .*defined twice/);
  bad(INST + "pattern p inst a\n C-4\npattern q inst a\n C-4:2\nsong s\n speed 6\n voices 0 1\n order p q\n", /e\.song:15: .*length/);
  bad(INST + "pattern p inst a\n C-4\nsong s\n speed 6\n voices 0\n order zz\n", /e\.song:13: .*zz/);
  bad(INST + "pattern p inst a\n C-4\nsong s\n speed 6\n voices 0 1\n order p\n", /e\.song:13: .*2 voices/);
  bad(INST + "pattern p inst a\n C-4\nsong s\n speed 6\n voices 0\n order p\n loop\n", /e\.song:14: .*loop/);
  bad(INST + "pattern p inst a\n C-4\nsong s\n voices 0\n order p\n", /e\.song:10: .*tempo/);
  bad(INST + "pattern p inst n\n C-4\nsong s\n speed 6\n voices 1\n order p\n", /e\.song:13: .*noise.*voice 1/);
  bad(INST + "pattern p inst a\n C-4\nsong s\n speed 6\n voices 3\n order p\n", /e\.song:13: .*tone.*voice 3/);
  bad(INST + "pattern p inst a\n -\n", /e\.song:9:/);
  bad("instrument c\n wave pulse50\n env 9\n arp 0 12\npattern p inst c\n A-8\n", /e\.song:6: .*arp/);
  bad(INST + "sfx x priority 2\n C-4@a\n", /e\.song:8: .*voice/);
  bad(INST + "song s\n speed 6\n voices 0 0\n", /e\.song:10: .*twice/);
  bad(INST + "song s\n speed 6\n wavetable 0123\n", /e\.song:10: .*32/);
  bad(INST + "pattern p inst a\n", /e\.song:8: .*empty/);
});

test("sourceReader converts foo.song.inc from foo.song on demand; art conversion unchanged", () => {
  const files: Record<string, string | Uint8Array> = {
    "d/foo.song": new TextEncoder().encode("instrument a\n wave saw\n env 9\n"),
    "d/bar.art": "@tiles T\n" + Array(8).fill("11111111").join("\n") + "\n",
    "d/have.song.inc": "; on disk\n",
  };
  const read = sourceReader(p => { if (!(p in files)) throw new Error("ENOENT " + p); return files[p]; });
  assert.match(String(read("d/foo.song.inc")), /^SNDI_foo:/m);
  assert.match(String(read("d/bar.art.inc")), /T:/);
  assert.equal(read("d/have.song.inc"), "; on disk\n");
  assert.throws(() => read("d/none.song.inc"));
});
