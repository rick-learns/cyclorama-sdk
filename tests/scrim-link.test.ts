// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// SCRIM linking (docs/scrim-spec.md §10): ASSET (kit-converted .art / .song data in ROM), LINK
// (CYASM source files), module-level ASM, and EXTERN declarations that give assembly symbols
// SCRIM types. Programs run on the full machine; the Cue Sound Driver is the real
// roms/lib/cuesound.inc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compile, type CompileResult } from "../src/scrim/compile.ts";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";
import { runRom } from "../tools/conformance.ts";
import { assemble } from "../src/asm/assembler.ts";
import { sourceReader } from "../tools/art.ts";

type Files = Record<string, string>;
const ART = readFileSync("tests/fixtures/scrim-link.art", "utf8");
const SONG = readFileSync("tests/fixtures/scrim-link.song", "utf8");

/** Compile `src` as roms/linktest/main.scr: in-memory files first, then the repository (roms/lib). */
function compileAt(src: string, files: Files = {}, main = "roms/linktest/main.scr"): CompileResult {
  const all: Files = { [main]: src, ...files };
  return compile(main, (p) => {
    if (p in all) return all[p];
    if (p.startsWith("roms/lib/")) return readFileSync(p, "utf8");
    throw new Error(`file not found: ${p}`);
  });
}
function build(src: string, files: Files = {}): CompileResult {
  const r = compileAt(src, files);
  if (r.errors.length || !r.rom) throw new Error(r.errors.map((e) => `${e.file}:${e.line}:${e.col}: ${e.message}`).join("\n") + "\n--- asm ---\n" + r.asm);
  return r;
}
const sym = (r: CompileResult, n: string) => { const v = r.symbols?.get(n); if (v === undefined) throw new Error(`no symbol ${n}`); return v; };
const errs = (r: CompileResult) => r.errors.map((e) => `${e.file}:${e.line}: ${e.message}`);
const lineOf = (src: string, needle: string) => src.split("\n").findIndex((l) => l.includes(needle)) + 1;

// ------------------------------------------------------------------------------------ ASSET

const ART_PROG = `
PROGRAM ArtLink;
ASSET "gfx/ramp.art";                      -- kit-converted: tiles RAMP (+ RAMP_TILES), palette RAMP_PAL
EXTERN DATA RAMP: ARRAY OF BYTE;
            RAMP_PAL: ARRAY [8] OF WORD;
EXTERN CONST RAMP_TILES: WORD;
VAR i, tiles: WORD; third: BYTE;
BEGIN
  VRAM_COPY(24, @RAMP[0], RAMP_TILES * 12);  -- tiles 1 and 2 (24 bytes a tile)
  CRAMADDR := 8;
  FOR i := 0 TO LEN(RAMP_PAL) - 1 DO CRAMDATA := RAMP_PAL[i] END;
  tiles := RAMP_TILES;
  third := RAMP[8]
END.`;

test("ASSET links a .art file's tiles and palette; EXTERN DATA/CONST reach them; VRAM and CRAM hold the art", () => {
  const r = build(ART_PROG, { "roms/linktest/gfx/ramp.art": ART });
  assert.match(r.asm, /^\s+\.include "gfx\/ramp\.art\.inc"$/m, "ASSET emits a CYASM .include of the converted file");
  const { m } = runRom(r.rom!, 10);
  assert.equal(m.cpu.mode, "stop");
  const vram = Array.from(m.video.vram.subarray(24, 72));
  const rows = (b: number) => Array(8).fill(b);
  assert.deepEqual(vram, [...rows(0x55), ...rows(0x33), ...rows(0x0f), ...rows(0xaa), ...rows(0xcc), ...rows(0xf0)]);
  assert.deepEqual(Array.from(m.video.vram.subarray(0, 24)), Array(24).fill(0), "tile 0 untouched");
  assert.deepEqual(Array.from(m.video.cram.subarray(8, 16)), [0x112, 0x964, 0x533, 0x4a4, 0xfff, 0, 0, 0]);
  assert.equal(m.bus.read16(sym(r, "tiles")), 2);
  assert.equal(m.bus.read8(sym(r, "third")), 0x33);
  assert.ok(sym(r, "RAMP") < 0x4000 && (sym(r, "RAMP") & 1) === 0, "asset data in bank 0, word aligned");
});

test("the .asm the compiler emits assembles to the same ROM with the kit's own reader (no hidden steps)", () => {
  const files: Files = { "roms/linktest/main.scr": ART_PROG, "roms/linktest/gfx/ramp.art": ART };
  const r = build(ART_PROG, files);
  const a = assemble("roms/linktest/main.asm", sourceReader((p) => {
    if (p === "roms/linktest/main.asm") return r.asm;
    if (p in files) return files[p];
    throw new Error(`file not found: ${p}`);
  }));
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.rom, r.rom);
});

test("ASSET and LINK paths are relative to the SCRIM file that names them (INCLUDEd modules too); a file is linked once", () => {
  const r = build(`
PROGRAM Paths;
INCLUDE "mod/art.scr";
ASSET "mod/pics/ramp.art";                 -- the same file again: linked once
VAR t: WORD;
BEGIN t := RAMP_TILES END.`, {
    "roms/linktest/mod/art.scr": `ASSET "pics/ramp.art";\nEXTERN CONST RAMP_TILES: WORD;\n`,
    "roms/linktest/mod/pics/ramp.art": ART,
  });
  assert.equal(r.asm.match(/\.include/g)?.length, 1);
  assert.match(r.asm, /\.include "mod\/pics\/ramp\.art\.inc"/);
  const { m } = runRom(r.rom!, 5);
  assert.equal(m.bus.read16(sym(r, "t")), 2);
});

test("ASSET after BANK n places the data in bank n; EXTERN DATA there follows the DATA bank rule", () => {
  const src = `
PROGRAM Banked;
BANK 1;
ASSET "ramp.art";
EXTERN DATA RAMP_PAL: ARRAY [8] OF WORD;
FAR FUNC second: WORD; BEGIN RETURN RAMP_PAL[1] END;
BANK 0;
VAR w: WORD;
BEGIN w := second END.`;
  const r = build(src, { "roms/linktest/ramp.art": ART });
  assert.ok(sym(r, "RAMP_PAL") >= 0x4000, "RAMP_PAL is in the switchable window");
  const { m } = runRom(r.rom!, 5);
  assert.equal(m.bus.read16(sym(r, "w")), 0x964);
  const bad = compileAt(src.replace("BEGIN w := second END.", "BEGIN w := RAMP_PAL[1] END."), { "roms/linktest/ramp.art": ART });
  assert.ok(errs(bad).some((e) => /RAMP_PAL.*bank 1/.test(e)), errs(bad).join("\n"));
});

// ------------------------------------------------------------------------------------ LINK + Cue Sound Driver

const SOUND_PROG = `
PROGRAM SoundLink;
-- The driver's RAM: a SCRIM VAR named SND_RAM is the assembler symbol cuesound.inc needs.
-- ARRAY OF WORD keeps it word aligned; 136 words = SND_RAM_SIZE (272 bytes).
VAR SND_RAM: ARRAY [136] OF WORD;
LINK "../lib/cuesound.inc";
ASSET "link.song";
EXTERN PROC SndInit;
EXTERN PROC SndPlaySong(song: WORD);
EXTERN PROC SndSfx(sfx: WORD);
EXTERN PROC SndTick;
EXTERN FUNC SndStatus: WORD;
EXTERN CONST SONG_tune: WORD;
             SFX_ping: WORD;
             SND_RAM_SIZE: WORD;
EXTERN VAR SND_ROWS: WORD;
VAR frames, before, during, after, rows, ramSize: WORD;

INTERRUPT PROC onVblank;
BEGIN
  SndTick;
  frames := frames + 1;
  IF_PORT := 1
END;
VECTOR VBLANK := onVblank;

BEGIN
  ramSize := SND_RAM_SIZE;
  SndInit;
  SndPlaySong(SONG_tune);
  IE := 1;
  ASM EI END;
  WHILE frames < 30 DO WAIT END;
  before := SndStatus;
  SndSfx(SFX_ping);
  WHILE frames < 40 DO WAIT END;
  during := SndStatus;
  WHILE frames < 120 DO WAIT END;
  after := SndStatus;
  rows := SND_ROWS;
  WHILE TRUE DO WAIT END
END.`;

test("LINK the Cue Sound Driver: EXTERN PROC calls play a .song (ASSET), audible, with the effect layered over the music", () => {
  const r = build(SOUND_PROG, { "roms/linktest/link.song": SONG });
  assert.match(r.asm, /\.include "\.\.\/lib\/cuesound\.inc"/);
  assert.equal(sym(r, "SND_RAM"), 0x8000);
  const m = new Machine(r.rom!, { cpu: new Tally() });
  const rms: number[] = [];
  const voice1: number[] = [];
  for (let f = 0; f < 125; f++) {
    m.runFrame(0, 0);
    const s = m.audio.takeSamples();
    rms.push(Math.sqrt(s.reduce((a, x) => a + x * x, 0) / Math.max(1, s.length)));
    voice1.push(m.peek16(0xf080 + 8));
  }
  const w = (n: string) => m.bus.read16(sym(r, n));
  assert.equal(w("ramSize"), 272, "EXTERN CONST reads the driver's equate");
  assert.ok(w("SND_RAM") !== undefined);
  for (let f = 5; f < 125; f += 10) assert.ok(rms[f] > 500, `frame ${f}: rms ${rms[f].toFixed(0)} (music audible)`);
  assert.equal(w("before"), 0x03, "music on voices 0 and 1, no effect");
  assert.equal(w("during"), 0x23, "effect on voice 1 (bit 5) while the music keeps both tracks");
  assert.equal(w("after"), 0x03, "the effect ended and gave voice 1 back");
  assert.ok(w("rows") > 12, `rows played: ${w("rows")}`);
  // the effect's C-6 / G-6 / C-7 reach voice 1 while it plays; before and after it holds bass notes
  const F = (n: number) => Math.round(440 * 2 ** ((n - 57) / 12) * 65536 / (945e6 / 44 / 448));
  assert.ok(voice1.slice(30, 40).includes(F(72)), "C-6 from the effect");
  assert.ok(voice1.slice(30, 60).includes(F(84)), "C-7 from the effect");
  assert.ok(!voice1.slice(0, 29).some((v) => v >= F(72)), "only bass on voice 1 before the effect");
});

test("module-level ASM defines routines; EXTERN FUNC calls them with the SCRIM convention (args pushed right to left)", () => {
  const r = build(`
PROGRAM AsmLink;
ASM
; Diff(a, b) = a - b: a (first argument) at [SP+2], b at [SP+4]
Diff:   LD   R0, [SP+2]
        LD   R1, [SP+4]
        SUB  R0, R1
        RTS
LinkTable: .word $1234, $5678
END;
EXTERN FUNC Diff(a, b: WORD): WORD;
EXTERN DATA LinkTable: ARRAY [2] OF WORD;
VAR x, y, z: WORD;
BEGIN
  x := Diff(10, 3);
  y := Diff(Diff(100, 1), 9) + 1;
  z := LinkTable[1]
END.`);
  const { m } = runRom(r.rom!, 5);
  assert.deepEqual([sym(r, "x"), sym(r, "y"), sym(r, "z")].map((a) => m.bus.read16(a)), [7, 91, 0x5678]);
});

test("the §10 example in docs/scrim-spec.md compiles and plays", () => {
  const spec = readFileSync("docs/scrim-spec.md", "utf8");
  const example = /## 10\.[\s\S]*?```\n([\s\S]*?)```/.exec(spec)![1];
  const r = build(example, {
    "roms/linktest/gfx/hero.art": ART.replace("@tiles RAMP", "@tiles HERO").replace("@palette RAMP_PAL", "@palette HERO_PAL"),
    "roms/linktest/hero.song": SONG.replace("song tune", "song theme").replace("sfx ping", "sfx jump"),
  });
  const { m } = runRom(r.rom!, 30, (f) => [f === 20 ? 1 : 0, 0]);
  assert.deepEqual(Array.from(m.video.cram.subarray(0, 5)), [0x112, 0x964, 0x533, 0x4a4, 0xfff]);
  assert.equal(m.video.vram[0], 0x55);
  assert.equal(m.peek16(sym(r, "SND_RAM") + 6), sym(r, "SONG_theme"), "the driver is playing SONG_theme");
});

// ------------------------------------------------------------------------------------ errors

test("an EXTERN symbol no linked file defines is an error at the EXTERN line; its uses fail at their SCRIM lines", () => {
  const src = `
PROGRAM Missing;
LINK "../lib/cuesound.inc";
VAR SND_RAM: ARRAY [136] OF WORD;
EXTERN PROC SndInit;
EXTERN PROC SndNope;
EXTERN CONST SONG_nothing: WORD;
VAR w: WORD;
BEGIN
  SndInit;
  SndNope;
  w := 1
END.`;
  const r = compileAt(src);
  const e = errs(r);
  assert.equal(r.rom, undefined);
  assert.ok(e.includes(`roms/linktest/main.scr:${lineOf(src, "SndNope;")}: EXTERN PROC 'SndNope' is not defined by any LINK, ASSET or ASM block`), e.join("\n"));
  assert.ok(e.includes(`roms/linktest/main.scr:${lineOf(src, "SONG_nothing")}: EXTERN CONST 'SONG_nothing' is not defined by any LINK, ASSET or ASM block`), e.join("\n"));
  assert.ok(e.some((x) => x.startsWith(`roms/linktest/main.scr:${lineOf(src, "  SndNope;")}: assembler: undefined symbol 'SndNope'`)), e.join("\n"));
  assert.ok(!e.some((x) => /SndInit/.test(x)), "SndInit is defined");
});

test("type misuse of EXTERN DATA / CONST / PROC is caught by the checker", () => {
  const cases: [string, RegExp][] = [
    ["RAMP_PAL[0] := 1", /DATA 'RAMP_PAL' is read-only/],
    ["RAMP := RAMP", /DATA 'RAMP' is read-only/],
    ["w := RAMP_PAL", /ARRAY \[8\] OF WORD is not compatible with WORD/],
    ["w := LEN(RAMP)", /LEN: the size of EXTERN DATA 'RAMP' is not declared/],
    ["w := SIZEOF(RAMP)", /SIZEOF: the size of EXTERN DATA 'RAMP' is not declared/],
    ["RAMP_TILES := 3", /cannot assign to constant 'RAMP_TILES'/],
    ["w := WORD(@RAMP_TILES)", /cannot take the address of 'RAMP_TILES'/],
    ["w := RAMP_PAL[8]", /index 8 out of bounds/],
    ["Twice(1, 2)", /'Twice' expects 1 argument, got 2/],
    ["w := Twice(@RAMP_PAL)", /POINTER TO ARRAY \[8\] OF WORD is not compatible with WORD/],
    ["Flag := 300", /300 is out of range for BYTE/],
  ];
  for (const [stmt, re] of cases) {
    const r = compileAt(`
PROGRAM Misuse;
ASSET "ramp.art";
EXTERN DATA RAMP: ARRAY OF BYTE; RAMP_PAL: ARRAY [8] OF WORD;
EXTERN CONST RAMP_TILES: WORD;
EXTERN FUNC Twice(x: WORD): WORD;
EXTERN VAR Flag: BYTE;
VAR w: WORD;
BEGIN ${stmt} END.`, { "roms/linktest/ramp.art": ART });
    assert.ok(errs(r).some((e) => re.test(e)), `${stmt}: ${errs(r).join(" | ")}`);
  }
});

test("EXTERN declaration errors: link-time constants, types, banks, ASSET kinds, syntax", () => {
  const cases: [string, RegExp][] = [
    ["EXTERN CONST N: WORD; VAR a: ARRAY [N] OF BYTE;", /array size must be a constant integer \(EXTERN CONST 'N' is only known when linking\)/],
    ["EXTERN CONST N: WORD; CONST M = N + 1;", /CONST M must be a constant expression \(EXTERN CONST 'N' is only known when linking\)/],
    ["EXTERN CONST T: ARRAY [2] OF WORD;", /EXTERN CONST 'T' must have a BYTE, WORD, INT, FIXED or POINTER type/],
    ["EXTERN DATA D: ARRAY OF BYTE = (1, 2);", /EXTERN DATA has no initialiser: the linked assembly defines D/],
    ["EXTERN VAR V: ARRAY OF BYTE;", /ARRAY OF without a size is only allowed for DATA/],
    ["EXTERN FAR PROC P;", /expected PROC, FUNC, DATA, CONST or VAR after EXTERN/],
    ["BANK 1; EXTERN PROC P;", /EXTERN PROC 'P' follows BANK 1/],
    ["EXTERN PROC P; PROC P; BEGIN END;", /'P' is already declared/],
    ["EXTERN PROC MEMCPY;", /'MEMCPY' is a runtime library routine/],
    ["EXTERN PROC VCTRL;", /'VCTRL' is the I\/O register/],
    ["ASSET \"pic.png\";", /ASSET takes a \.art or \.song file \(use LINK for CYASM source\)/],
    ["LINK 3;", /LINK needs a quoted file name/],
  ];
  for (const [decl, re] of cases) {
    const r = compileAt(`PROGRAM Decl;\n${decl}\nBEGIN END.`);
    assert.ok(errs(r).some((e) => re.test(e)), `${decl}: ${errs(r).join(" | ")}`);
  }
});

test("an assembler error inside a LINKed file is reported at the LINK line, naming the file and its line", () => {
  const src = `PROGRAM BadLib;\nLINK "lib/bad.inc";\nBEGIN END.`;
  const r = compileAt(src, { "roms/linktest/lib/bad.inc": "Good:   RTS\n        FROB R0\n" });
  assert.deepEqual(errs(r).map((e) => e.replace(/ \(.*$/, "")), [`roms/linktest/main.scr:2: assembler: roms/linktest/lib/bad.inc:2: unknown mnemonic 'FROB'`]);
  const missing = compileAt(`PROGRAM NoLib;\nLINK "nowhere.inc";\nBEGIN END.`);
  assert.ok(errs(missing).some((e) => e.startsWith("roms/linktest/main.scr:2: ") && /cannot read file 'roms\/linktest\/nowhere\.inc'/.test(e)), errs(missing).join("\n"));
  const badArt = compileAt(`PROGRAM BadArt;\nASSET "x.art";\nBEGIN END.`, { "roms/linktest/x.art": "@tiles X\n12\n" });
  assert.ok(errs(badArt).some((e) => e.startsWith("roms/linktest/main.scr:2: ") && /x\.art:1: @tiles X must be a multiple of 8/.test(e)), errs(badArt).join("\n"));
});

// ------------------------------------------------------------------------------------ determinism and reports

test("linking is deterministic: two compiles give identical assembly and ROM bytes", () => {
  const files = { "roms/linktest/link.song": SONG };
  const a = build(SOUND_PROG, files), b = build(SOUND_PROG, files);
  assert.equal(a.asm, b.asm);
  assert.deepEqual(a.rom, b.rom);
  assert.ok(!/[A-Za-z]:[\\/]|\\/.test(a.asm.split("\n").filter((l) => /\.include/.test(l)).join("\n")), "include paths are relative, forward slashes");
});

test("the size report still attributes code to SCRIM procedures after linked files (bank 0 and FAR bank 1)", () => {
  // the same procedures with SndInit as a SCRIM stub (no LINK) must report identical sizes
  const src = (link: boolean) => `
PROGRAM Report;
${link ? `LINK "../lib/cuesound.inc";` : ""}
VAR SND_RAM: ARRAY [136] OF WORD; w: WORD;
${link ? "EXTERN PROC SndInit;" : "PROC SndInit; BEGIN END;"}
BANK 1;
FAR PROC far1; BEGIN w := 1; w := w + 2 END;
BANK 0;
PROC near1; BEGIN SndInit END;
BEGIN near1; far1 END.`;
  const linked = build(src(true)).report ?? [], plain = build(src(false)).report ?? [];
  assert.deepEqual(linked, plain.filter((x) => x.name !== "SndInit"));
  assert.deepEqual(linked.map((x) => x.name), ["(startup)", "far1", "near1", "(main)"], "linked code is not reported as a SCRIM procedure");
  assert.ok(linked.every((x) => x.bytes > 0));
});
