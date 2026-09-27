// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// SCRIM compiler: compile errors carry file:line:col and a message (scrim-spec §8).
// In each source, the marker ‹ sits immediately before the token the error must point at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSrc, run, type Files } from "./scrim-harness.ts";

type Case = { name: string; src: string; msg: RegExp; files?: Files; file?: string };

function locate(src: string): { clean: string; line: number; col: number } {
  const i = src.indexOf("‹");
  assert.ok(i >= 0, "test source needs a ‹ marker");
  const before = src.slice(0, i);
  const line = before.split("\n").length;
  const col = i - before.lastIndexOf("\n");
  return { clean: src.replace("‹", ""), line, col };
}

const cases: Case[] = [
  { name: "undeclared name", msg: /undeclared.*'y'/i, src: `PROGRAM E;
VAR x: WORD;
BEGIN
  x := ‹y + 1
END.` },
  { name: "mixing signedness", msg: /mix.*(INT.*WORD|WORD.*INT)/i, src: `PROGRAM E;
VAR i: INT; w: WORD;
BEGIN
  i := i ‹+ w
END.` },
  { name: "assignment to CONST", msg: /constant/i, src: `PROGRAM E;
CONST K = 3;
BEGIN
  ‹K := 4
END.` },
  { name: "assignment to DATA", msg: /DATA.*read-only/i, src: `PROGRAM E;
DATA t: ARRAY [2] OF WORD = (1, 2);
BEGIN
  ‹t[0] := 5
END.` },
  { name: "wrong argument count", msg: /expects 2 arguments, got 1/i, src: `PROGRAM E;
PROC p(a, b: WORD); BEGIN END;
BEGIN
  ‹p(1)
END.` },
  { name: "non-constant array size", msg: /array size must be a constant/i, src: `PROGRAM E;
VAR n: WORD; a: ARRAY [‹n] OF BYTE;
BEGIN END.` },
  { name: "BYTE constant out of range", msg: /256 .*out of range.*BYTE/i, src: `PROGRAM E;
VAR b: BYTE;
BEGIN
  b := ‹256
END.` },
  { name: "FIXED constant out of range", msg: /out of range.*FIXED/i, src: `PROGRAM E;
VAR f: FIXED;
BEGIN
  f := ‹200.0
END.` },
  { name: "function can reach its end without RETURN", msg: /'f'.*without RETURN/i, src: `PROGRAM E;
FUNC f(x: INT): INT;
BEGIN
  IF x > 0 THEN RETURN 1 END
‹END;
BEGIN END.` },
  { name: "RETURN type mismatch", msg: /RETURN.*BOOL.*INT/i, src: `PROGRAM E;
FUNC f: INT; BEGIN RETURN ‹TRUE END;
BEGIN END.` },
  { name: "RETURN with a value in a PROC", msg: /PROC.*cannot return a value/i, src: `PROGRAM E;
PROC p; BEGIN ‹RETURN 1 END;
BEGIN END.` },
  { name: "EXIT outside a loop", msg: /EXIT.*outside.*loop/i, src: `PROGRAM E;
BEGIN
  ‹EXIT
END.` },
  { name: "duplicate declaration", msg: /'a'.*already declared/i, src: `PROGRAM E;
VAR a: WORD; ‹a: INT;
BEGIN END.` },
  { name: "syntax error: missing THEN", msg: /expected THEN/i, src: `PROGRAM E;
VAR x: WORD;
BEGIN
  IF x = 1 ‹x := 2 END
END.` },
  { name: "duplicate CASE label", msg: /duplicate CASE label 1/i, src: `PROGRAM E;
VAR x: WORD;
BEGIN
  CASE x OF 1: x := 1; 2, ‹1: x := 2 END
END.` },
  { name: "unknown record field", msg: /no field 'z'/i, src: `PROGRAM E;
VAR r: RECORD a: WORD END;
BEGIN
  r.‹z := 1
END.` },
  { name: "VECTOR to an ordinary PROC", msg: /INTERRUPT PROC/i, src: `PROGRAM E;
PROC h; BEGIN END;
VECTOR VBLANK := ‹h;
BEGIN END.` },
  { name: "FAR PROC outside a switchable bank", msg: /FAR.*BANK/i, src: `PROGRAM E;
‹FAR PROC f; BEGIN END;
BEGIN END.` },
  { name: "ordinary PROC placed in a switchable bank", msg: /'g'.*not FAR/i, src: `PROGRAM E;
BANK 2;
‹PROC g; BEGIN END;
BEGIN END.` },
  { name: "calling an INTERRUPT PROC directly", msg: /INTERRUPT PROC 'h' cannot be called/i, src: `PROGRAM E;
INTERRUPT PROC h; BEGIN END;
BEGIN
  ‹h
END.` },
  { name: "INCBIN file missing", msg: /cannot read.*nope\.bin/i, src: `PROGRAM E;
DATA d: ARRAY OF BYTE = INCBIN ‹"nope.bin";
BEGIN END.` },
  { name: "banked DATA read from bank 0 code", msg: /bank 3/i, src: `PROGRAM E;
VAR x: WORD;
BANK 3;
DATA t: ARRAY [2] OF WORD = (1, 2);
BANK 0;
BEGIN
  x := ‹t[1]
END.` },
  { name: "arithmetic on BOOL", msg: /BOOL/i, src: `PROGRAM E;
VAR b: BOOL; w: WORD;
BEGIN
  w := b ‹+ 1
END.` },
  { name: "unterminated string", msg: /unterminated string/i, src: `PROGRAM E;
HEADER title = ‹"abc;
BEGIN END.` },
  { name: "PROC used as a value", msg: /'p'.*no result/i, src: `PROGRAM E;
VAR x: WORD;
PROC p; BEGIN END;
BEGIN
  x := ‹p
END.` },
  { name: "name clashes with a CYASM register", msg: /R1.*register/i, src: `PROGRAM E;
VAR ‹R1: WORD;
BEGIN END.` },
  { name: "argument type mismatch", msg: /argument 1.*BOOL.*WORD/i, src: `PROGRAM E;
PROC p(a: WORD); BEGIN END;
BEGIN
  p(‹TRUE)
END.` },
  { name: "constant array index out of bounds", msg: /index 4 out of bounds/i, src: `PROGRAM E;
VAR a: ARRAY [4] OF WORD;
BEGIN
  a[‹4] := 1
END.` },
  { name: "error inside inline ASM maps to the SCRIM line", msg: /FROB/i, src: `PROGRAM E;
BEGIN
  ASM
    NOP
    ‹FROB R1
  END
END.` },
  { name: "error in an INCLUDEd file names that file", msg: /undeclared.*'zz'/i, file: "lib.scr",
    files: { "lib.scr": "CONST A = 1;\nCONST B = ‹zz;\n" }, src: `PROGRAM E;
INCLUDE "lib.scr";
BEGIN END.` },
];

for (const c of cases) {
  test(`compile error: ${c.name}`, () => {
    let src = c.src, files = c.files ?? {}, where: { line: number; col: number };
    if (c.file) {
      const loc = locate(files[c.file] as string);
      files = { ...files, [c.file]: loc.clean };
      where = loc;
    } else {
      const loc = locate(src);
      src = loc.clean;
      where = loc;
    }
    const r = compileSrc(src, files);
    assert.equal(r.rom, undefined, "no ROM when there are errors");
    assert.ok(r.errors.length >= 1, "an error is reported");
    const e = r.errors[0];
    assert.match(e.message, c.msg);
    assert.deepEqual({ file: e.file, line: e.line, col: e.col }, { file: c.file ?? "main.scr", line: where.line, col: where.col }, e.message);
  });
}

// Ruling §9.22 (found by the SLICE gate cartridge): `@a` of an ARRAY is a POINTER TO ARRAY, not a
// pointer to its first element; pass `@a[0]` where a POINTER TO element is wanted (DATA strings too).
test("ruling 22: @array is POINTER TO ARRAY; @array[0] is POINTER TO its element type", () => {
  const src = (arg: string) => `PROGRAM P;
TYPE PB = POINTER TO BYTE;
DATA s: ARRAY OF BYTE = "HI!";
VAR out: ARRAY [3] OF WORD;
PROC copy(p: PB; n: WORD);
VAR i: WORD; q: PB;
BEGIN
  FOR i := 1 TO n DO q := PB(WORD(p) + i - 1); out[i - 1] := q^ END
END;
BEGIN
  copy(${arg}, LEN(s))
END.`;
  const bad = compileSrc(src("@s"));
  assert.equal(bad.rom, undefined);
  assert.match(bad.errors[0].message, /POINTER TO ARRAY \[3\] OF BYTE is not compatible with POINTER TO BYTE/);
  const t = run(src("@s[0]"));
  assert.deepEqual(t.words("out", 3), [72, 73, 33]);
});

test("compile errors: at most 20 are reported, in source order", () => {
  const body = Array.from({ length: 30 }, (_, i) => `  x := u${i};`).join("\n");
  const r = compileSrc(`PROGRAM E;\nVAR x: WORD;\nBEGIN\n${body}\nEND.`);
  assert.equal(r.errors.length, 20);
  assert.deepEqual(r.errors.map((e) => e.line), Array.from({ length: 20 }, (_, i) => i + 4));
});
