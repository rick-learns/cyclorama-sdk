// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// SCRIM compiler: language semantics, proven by running compiled programs on the emulator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, u16, s16 } from "./scrim-harness.ts";

test("empty program compiles, runs and reaches STOP", () => {
  const t = run("PROGRAM Empty;\nBEGIN\nEND.\n");
  assert.equal(t.stopped, true);
  assert.equal(t.frames, 1);
});

test("module VARs live from 8000 upward in declaration order and start zeroed", () => {
  const t = run(`
PROGRAM Layout;
VAR a: WORD; b: BYTE; c: WORD; d: BYTE; e: BYTE; f: INT;
BEGIN
  a := 1; c := 3; f := -1;
END.`);
  assert.equal(t.addr("a"), 0x8000);
  assert.equal(t.addr("b"), 0x8002);
  assert.equal(t.addr("c"), 0x8004); // words are even-aligned
  assert.equal(t.addr("d"), 0x8006);
  assert.equal(t.addr("e"), 0x8007);
  assert.equal(t.addr("f"), 0x8008);
  assert.deepEqual([t.w("a"), t.b("b"), t.w("c"), t.b("d"), t.b("e"), t.s("f")], [1, 0, 3, 0, 0, -1]);
});

test("integer arithmetic: wraparound, signed and unsigned division/modulo, shifts, bitwise ops", () => {
  const t = run(`
PROGRAM Arith;
VAR r: ARRAY [40] OF WORD;
    a, b, z: INT;
    u, v, zu: WORD;
BEGIN
  a := 7; b := -3; z := 0;
  r[0] := WORD(a + b);
  r[1] := WORD(a - b);
  r[2] := WORD(a * b);
  r[3] := WORD(a / b);
  r[4] := WORD(a MOD b);
  r[5] := WORD(-a / 2);
  r[6] := WORD(-a MOD 2);
  r[7] := WORD(a / z);
  r[8] := WORD(-a MOD z);
  u := 65535; v := 10; zu := 0;
  r[9] := u + 1;
  r[10] := u / v;
  r[11] := u MOD v;
  r[12] := u / zu;
  r[13] := u MOD zu;
  r[14] := u / 16;
  r[15] := u MOD 16;
  a := 32767;
  r[16] := WORD(a + 1);
  a := -32768; b := -1;
  r[17] := WORD(a / b);
  u := 300;
  r[18] := u * u;
  r[19] := $F000 SHR 4;
  u := $F000;
  r[20] := u SHR 4;
  a := -16;
  r[21] := WORD(a SHR 2);
  r[22] := WORD(a SHL 3);
  r[23] := (u AND $0FF0) OR $0005;
  r[24] := u XOR $FFFF;
  r[25] := NOT u;
  r[26] := WORD(-a);
  a := -7;
  r[27] := WORD(a / 4);
  r[28] := WORD(a MOD 4);
  v := 3;
  r[29] := u SHR v;
  r[30] := 1 SHL v;
  r[31] := %1010 + 'A' + 1;
  u := 1000; v := 7;
  r[32] := (u + v) * 2 - v / 2 + u MOD 3;
END.`);
  const exp = [4, 10, -21, -2, 1, -3, -1, 0, -7, 0, 6553, 5, 0, 65535, 4095, 15, -32768, -32768, 90000, 0x0f00,
    0x0f00, -4, -128, 0x0005, 0x0fff, 0x0fff, 16, -1, -3, 0x1e00, 8, 10 + 65 + 1, (1007 * 2) - 3 + 1];
  assert.deepEqual(t.words("r", exp.length), exp.map(u16));
});

test("runtime division matches the reference for signed and unsigned edge cases (incl. divide by zero)", () => {
  const sp: [number, number][] = [[7, 2], [-7, 2], [7, -2], [-7, -2], [0, 5], [5, 0], [-5, 0], [-32768, -1], [-32768, 1],
    [32767, -32768], [-32768, 32767], [12345, 123], [-1, 2], [100, 7], [-100, -7], [1, 1], [-32768, -32768], [32767, 1]];
  const up: [number, number][] = [[65535, 1], [65535, 65535], [65535, 32768], [40000, 3], [1, 65535], [9, 0], [0, 0],
    [32768, 2], [65534, 65535], [50000, 49999], [43690, 21845], [1000, 33]];
  const list = (xs: number[]) => xs.join(", ");
  const t = run(`
PROGRAM Div;
CONST NS = ${sp.length}; NU = ${up.length};
DATA sa: ARRAY [NS] OF INT = (${list(sp.map((p) => p[0]))});
DATA sb: ARRAY [NS] OF INT = (${list(sp.map((p) => p[1]))});
DATA ua: ARRAY [NU] OF WORD = (${list(up.map((p) => p[0]))});
DATA ub: ARRAY [NU] OF WORD = (${list(up.map((p) => p[1]))});
VAR sq, sm: ARRAY [NS] OF INT;
    uq, um: ARRAY [NU] OF WORD;
    i: WORD;
BEGIN
  FOR i := 0 TO NS - 1 DO sq[i] := sa[i] / sb[i]; sm[i] := sa[i] MOD sb[i] END;
  FOR i := 0 TO NU - 1 DO uq[i] := ua[i] / ub[i]; um[i] := ua[i] MOD ub[i] END;
END.`);
  sp.forEach(([a, b], i) => {
    const q = b === 0 ? 0 : s16(Math.trunc(a / b));
    const m = b === 0 ? a : a - Math.trunc(a / b) * b;
    assert.deepEqual([t.s("sq", i), t.s("sm", i)], [q, s16(m)], `${a} / ${b}`);
  });
  up.forEach(([a, b], i) => {
    assert.deepEqual([t.w("uq", i), t.w("um", i)], b === 0 ? [0, a] : [Math.floor(a / b), a % b], `${a} / ${b} unsigned`);
  });
});

test("FIXED 8.8 arithmetic, literals and conversions (TRUNC rounds toward minus infinity)", () => {
  const t = run(`
PROGRAM Fix;
VAR r: ARRAY [20] OF WORD; f, g, h: FIXED; i: INT;
BEGIN
  f := 1.5; g := -2.25;
  h := f * g; r[0] := WORD(h);
  r[1] := WORD(f + g);
  r[2] := WORD(TRUNC(g));
  r[3] := WORD(TRUNC(f));
  h := -0.5; r[4] := WORD(TRUNC(h));
  i := 3; r[5] := WORD(FIXED(i));
  i := -2; r[6] := WORD(FIXED(i));
  r[7] := WORD(f * 3);
  i := -4; r[8] := WORD(f * i);
  r[9] := WORD(g / 2);
  r[10] := WORD(f + 1);
  r[11] := WORD(0.1);
  IF g < f THEN r[12] := 1 END;
  IF f > 1 THEN r[13] := 1 END;
  f := 0.75; g := 0.75; r[14] := WORD(f * g);
  f := -1.0; r[15] := WORD(f * f);
  f := -128.0; r[16] := WORD(f);
  r[17] := WORD(FIXED(-3) - 0.25);
  f := 10.0; g := 20.0; r[18] := WORD(f * g);
  r[19] := WORD(TRUNC(FIXED(-7) / 2));
END.`);
  const fx = (v: number) => u16(Math.round(v * 256));
  const exp = [fx(-3.375), fx(-0.75), u16(-3), 1, u16(-1), fx(3), fx(-2), fx(4.5), fx(-6), fx(-1.125), fx(2.5), 26, 1, 1,
    fx(0.5625), fx(1), 0x8000, fx(-3.25), u16((2560 * 5120) >> 8), u16(-4)];
  assert.deepEqual(t.words("r", exp.length), exp);
});

test("comparisons: INT/FIXED signed, WORD/BYTE unsigned, as values and conditions", () => {
  const t = run(`
PROGRAM Cmp;
VAR r: ARRAY [24] OF BOOL; i, j: INT; u, v: WORD; bb: BYTE; f: FIXED;
BEGIN
  i := -1; j := 1; u := 65535; v := 1; bb := 200; f := -0.5;
  r[0] := i < j; r[1] := i <= j; r[2] := i > j; r[3] := i >= j; r[4] := i = j; r[5] := i <> j;
  r[6] := u < v; r[7] := u <= v; r[8] := u > v; r[9] := u >= v; r[10] := u = v; r[11] := u <> v;
  r[12] := i < 0; r[13] := u > 0; r[14] := bb > 100; r[15] := WORD(i) > v;
  r[16] := i = -1; r[17] := 0 > i;
  IF i < j THEN r[18] := TRUE ELSE r[18] := FALSE END;
  r[19] := u > 32767;
  r[20] := f < 0; r[21] := f > -1;
  r[22] := NOT (i < j);
  r[23] := (i < j) = (u > v);
END.`);
  const exp = [1, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];
  assert.deepEqual(Array.from({ length: exp.length }, (_, k) => t.b("r", k)), exp);
});

test("AND/OR short-circuit on BOOL (conditions and values); NOT is logical on BOOL", () => {
  const t = run(`
PROGRAM Short;
VAR calls: WORD; t, f, x: BOOL; r: ARRAY [10] OF WORD; p: POINTER TO WORD;
FUNC touch(v: BOOL): BOOL;
BEGIN calls := calls + 1; RETURN v END;
BEGIN
  t := TRUE; f := FALSE;
  IF f AND touch(TRUE) THEN r[0] := 1 END; r[1] := calls;
  IF t OR touch(TRUE) THEN r[2] := 1 END; r[3] := calls;
  IF t AND touch(FALSE) THEN r[4] := 1 END; r[5] := calls;
  x := f OR touch(TRUE); r[6] := calls; r[7] := WORD(x);
  p := NIL;
  IF (p <> NIL) AND (p^ = 5) THEN r[8] := 1 ELSE r[8] := 2 END;
  x := NOT (t AND NOT f); r[9] := WORD(x) + 10;
END.`);
  assert.deepEqual(t.words("r", 10), [0, 0, 1, 0, 0, 1, 2, 1, 2, 10]);
  assert.equal(t.w("calls"), 2);
});

test("every statement form: IF/ELSIF/ELSE, WHILE, REPEAT, FOR TO/DOWNTO/STEP, EXIT", () => {
  const t = run(`
PROGRAM Stmts;
VAR r: ARRAY [20] OF WORD; i, j, n, s: WORD; k: INT; bb: BYTE;
BEGIN
  FOR i := 0 TO 3 DO
    IF i = 0 THEN r[i] := 10 ELSIF i = 1 THEN r[i] := 11 ELSIF i = 2 THEN r[i] := 12 ELSE r[i] := 13 END
  END;
  n := 0; s := 0; WHILE n < 10 DO s := s + n; n := n + 1 END; r[4] := s;
  n := 0; REPEAT n := n + 3 UNTIL n > 10; r[5] := n;
  s := 0; FOR i := 1 TO 10 STEP 3 DO s := s + i END; r[6] := s;
  s := 0; FOR k := 2 DOWNTO -1 DO s := s * 10 + WORD(k + 2) END; r[7] := s;
  n := 0; FOR bb := 0 TO 255 DO n := n + 1 END; r[8] := n;
  n := 0; FOR i := 65530 TO 65535 DO n := n + 1 END; r[9] := n;
  n := 0; FOR i := 5 TO 4 DO n := n + 1 END; r[10] := n;
  j := 5; n := 0; FOR i := 1 TO j DO j := j + 1; n := n + 1 END; r[11] := n;
  n := 0;
  FOR i := 0 TO 4 DO
    j := 0;
    WHILE TRUE DO j := j + 1; IF j = 3 THEN EXIT END END;
    n := n + j
  END;
  r[12] := n;
  n := 0; REPEAT n := n + 1; IF n = 7 THEN EXIT END UNTIL FALSE; r[13] := n;
  FOR i := 0 TO 100 DO IF i = 42 THEN EXIT END END; r[14] := i;
  s := 0; FOR k := 10 DOWNTO 0 STEP 4 DO s := s * 10 + WORD(k) END; r[15] := s;
  FOR i := 1 TO 3 DO END; r[16] := i;
  n := 0; FOR i := 1 TO 3 DO FOR j := 1 TO i DO n := n + j END END; r[17] := n;
  n := 0; k := -3; FOR i := 0 TO 2 DO k := k + 1 END; r[18] := WORD(k);
  ;;
END.`);
  assert.deepEqual(t.words("r", 19), [10, 11, 12, 13, 45, 12, 22, 4321, 256, 6, 0, 5, 15, 7, 42, 1062, 4, 10, 0]);
});

test("CASE: dense labels compile to a JMPT table, sparse ones to compares; ranges, lists and ELSE", () => {
  const t = run(`
PROGRAM Cases;
CONST N = 13;
DATA din: ARRAY [N] OF INT = (-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1000, -32768);
DATA sin: ARRAY [7] OF INT = (-5, 100, 1000, 2000, 30000, 0, -4);
VAR dout: ARRAY [N] OF INT; sout: ARRAY [7] OF INT; hits: WORD; i: WORD;
FUNC dense(x: INT): INT;
BEGIN
  CASE x OF
    0: RETURN 100;
    1: RETURN 101;
    2, 3: RETURN 123;
    5: RETURN 105;
    6..8: RETURN 168;
  ELSE RETURN -1
  END
END;
FUNC sparse(x: INT): INT;
VAR r: INT;
BEGIN
  r := 0;
  CASE x OF
    -5: r := 1;
    100: r := 2; r := r + 0;
    1000, 2000: r := 3;
    30000: r := 4
  ELSE r := 9
  END;
  RETURN r
END;
PROC nomatch(x: WORD);
BEGIN CASE x OF 1: hits := hits + 1 END END;
BEGIN
  FOR i := 0 TO N - 1 DO dout[i] := dense(din[i]) END;
  FOR i := 0 TO 6 DO sout[i] := sparse(sin[i]) END;
  nomatch(2); nomatch(1);
END.`);
  assert.deepEqual(Array.from({ length: 13 }, (_, i) => t.s("dout", i)), [-1, 100, 101, 123, 123, -1, 105, 168, 168, 168, -1, -1, -1]);
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => t.s("sout", i)), [1, 2, 3, 3, 4, 9, 9]);
  assert.equal(t.w("hits"), 1);
  assert.equal((t.r.asm.match(/\bJMPT\b/g) ?? []).length, 1, "exactly one jump table (the dense CASE)");
});

test("procedures: recursion (fibonacci), argument order, calls nested in expressions, callee-saved registers", () => {
  const t = run(`
PROGRAM Procs;
VAR r: ARRAY [12] OF INT; g: WORD;
    a, b, c, d, e, f, h, k, m: INT;
FUNC fib(n: WORD): WORD;
BEGIN
  IF n < 2 THEN RETURN n END;
  RETURN fib(n - 1) + fib(n - 2)
END;
FUNC digits(a, b, c, d, e: INT): INT;
BEGIN RETURN (((a * 10 + b) * 10 + c) * 10 + d) * 10 + e END;
FUNC sq(x: INT): INT; BEGIN RETURN x * x END;
FUNC add3(a, b, c: INT): INT; BEGIN RETURN a + b + c END;
PROC clobber;
VAR x, y, z, w: WORD;
BEGIN
  x := 1; y := 2; z := 3; w := x + y + z;
  FOR x := 0 TO 10 DO y := y + x; z := z + y END;
  g := y + z + w
END;
PROC outer;
VAR i, acc, kk: INT;
BEGIN
  acc := 0; kk := 7;
  FOR i := 1 TO 5 DO clobber; acc := acc + i * kk END;
  r[5] := acc
END;
FUNC sumto(n: INT): INT;
VAR t: INT;
BEGIN
  IF n = 0 THEN RETURN 0 END;
  t := n;
  RETURN t + sumto(n - 1)
END;
FUNC isOdd(n: WORD): BOOL; BEGIN IF n = 0 THEN RETURN FALSE END; RETURN isEven(n - 1) END;
FUNC isEven(n: WORD): BOOL; BEGIN IF n = 0 THEN RETURN TRUE END; RETURN isOdd(n - 1) END;
BEGIN
  r[0] := INT(fib(15));
  r[1] := digits(1, 2, 3, 4, 5);
  r[2] := add3(sq(2), sq(3), sq(4));
  a := 2; b := 3; c := 4; d := 5; e := 6; f := 7; h := 8; k := 9; m := 10;
  r[3] := (a + b) * (c + d) - (e + f) * (h + (k * m)) + ((a - b) * (c - (d * (e - (f * (h - k))))));
  r[4] := a + sq(b) * (c - sq(d));
  outer;
  r[6] := sumto(100);
  IF isEven(10) AND isOdd(7) AND NOT isOdd(4) THEN r[7] := 1 END;
  r[8] := sq(sq(sq(2)));
  r[9] := add3(1, add3(2, 3, add3(4, 5, 6)), sq(add3(1, 1, 1)));
END.`);
  const [a, b, c, d, e, f, h, k, m] = [2, 3, 4, 5, 6, 7, 8, 9, 10];
  const r3 = (a + b) * (c + d) - (e + f) * (h + k * m) + (a - b) * (c - d * (e - f * (h - k)));
  assert.deepEqual(Array.from({ length: 10 }, (_, i) => t.s("r", i)),
    [610, 12345, 29, s16(r3), 2 + 9 * (4 - 25), 7 * 15, 5050, 1, 256, 1 + 2 + 3 + 15 + 9]);
});

test("records, arrays, pointers, @ and ^ (prefix and postfix), whole-record assignment", () => {
  const t = run(`
PROGRAM Recs;
TYPE Actor = RECORD x, y: FIXED; state: BYTE; hp: WORD END;
     PActor = POINTER TO Actor;
     Grid = ARRAY [3] OF ARRAY [4] OF BYTE;
     Node = RECORD value: WORD; next: POINTER TO Node END;
VAR actors: ARRAY [4] OF Actor;
    p: PActor; i, j: WORD; pw: POINTER TO WORD; w: WORD;
    grid: Grid; r: ARRAY [16] OF WORD;
    nodes: ARRAY [3] OF Node; head: POINTER TO Node;
PROC move(a: PActor; dx: INT);
BEGIN a^.x := a^.x + FIXED(dx) END;
FUNC localSum: WORD;
VAR buf: ARRAY [5] OF WORD; rec: Actor; k, s: WORD;
BEGIN
  FOR k := 0 TO 4 DO buf[k] := k * k END;
  rec.hp := 1000; rec.state := 7;
  s := 0; FOR k := 0 TO 4 DO s := s + buf[k] END;
  RETURN s + rec.hp + rec.state
END;
BEGIN
  FOR i := 0 TO 3 DO
    actors[i].x := FIXED(INT(i)); actors[i].y := 0.5; actors[i].state := BYTE(i + 250); actors[i].hp := i * 100
  END;
  p := @actors[2];
  move(p, 5);
  r[0] := WORD(TRUNC(actors[2].x));
  r[1] := p^.hp;
  r[2] := (^p).state;
  actors[0] := actors[3];
  r[3] := actors[0].hp; r[4] := actors[0].state;
  pw := @w; pw^ := 1234; r[5] := w;
  FOR i := 0 TO 2 DO FOR j := 0 TO 3 DO grid[i][j] := BYTE(i * 10 + j) END END;
  r[6] := grid[2][3]; r[7] := grid[1][0];
  r[8] := localSum();
  r[9] := SIZEOF(Actor); r[10] := SIZEOF(grid); r[11] := LEN(actors);
  nodes[0].value := 1; nodes[1].value := 20; nodes[2].value := 300;
  nodes[0].next := @nodes[1]; nodes[1].next := @nodes[2]; nodes[2].next := NIL;
  head := @nodes[0]; w := 0;
  WHILE head <> NIL DO w := w + head^.value; head := head^.next END;
  r[12] := w;
  i := 3; r[13] := actors[i - 1].hp + actors[i].hp;
  r[14] := WORD(@actors[1]) - WORD(@actors[0]);
END.`);
  assert.deepEqual(t.words("r", 15), [7, 200, 252, 300, 253, 1234, 23, 10, 30 + 1000 + 7, 8, 12, 4, 321, 500, 8]);
  // record layout: x at +0, y at +2, state at +4, hp at +6 (word aligned), size 8
  const base = t.addr("actors");
  assert.equal(t.m.bus.read16(base + 3 * 8 + 6), 300);
  assert.equal(t.m.bus.read8(base + 3 * 8 + 4), 253);
});

test("BYTE truncation on store: globals, locals, register locals, arrays, fields and pointers", () => {
  const t = run(`
PROGRAM Trunc;
TYPE R = RECORD a: BYTE; b: BYTE; c: WORD END;
VAR gb: BYTE; arr: ARRAY [4] OF BYTE; rec: R; pb: POINTER TO BYTE; out: ARRAY [8] OF WORD; w: WORD;
FUNC viaLocal(v: WORD): WORD;
VAR lb: BYTE; buf: ARRAY [3] OF BYTE;
BEGIN
  lb := v; buf[0] := $11; buf[1] := v; buf[2] := $33;
  RETURN lb + buf[1] * 256 + buf[0] + buf[2] - $44
END;
FUNC wrapByte(v: BYTE): WORD;
VAR k: BYTE;
BEGIN k := v; k := k + 100; RETURN k END;
BEGIN
  w := $1234;
  gb := w;
  arr[0] := $AA; arr[2] := $CC; arr[1] := w; arr[3] := w + 1;
  rec.c := $FFFF; rec.a := w; rec.b := $FF;
  pb := @arr[2]; pb^ := w + $CB;
  out[0] := gb; out[1] := arr[0]; out[2] := arr[1]; out[3] := arr[2]; out[4] := arr[3];
  out[5] := viaLocal($5678);
  out[6] := wrapByte(200);
  out[7] := rec.a + rec.c;
END.`);
  assert.deepEqual(t.words("out", 8), [0x34, 0xaa, 0x34, 0xff, 0x35, 0x78 + 0x7800, 44, 0x33]);
  assert.equal(t.b("rec", 1), 0xff);
});

test("DATA tables in ROM: word/byte arrays, strings, records, INCBIN (bytes and words), LEN", () => {
  const blob = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0xff]);
  const words = new Uint8Array([0x34, 0x12, 0x78, 0x56]);
  const t = run(`
PROGRAM Tables;
TYPE Pt = RECORD x, y: INT END; Box = RECORD v: WORD END;
DATA sq: ARRAY [8] OF WORD = (0, 1, 4, 9, 16, 25, 36, 49);
DATA bin: ARRAY OF BYTE = INCBIN "blob.bin";
DATA wb: ARRAY OF WORD = INCBIN "assets/words.bin";
DATA msg: ARRAY OF BYTE = "HELLO\\n";
DATA pts: ARRAY [2] OF Pt = ((1, -2), (3, -4));
DATA half: FIXED = 0.5;
DATA small: ARRAY OF BYTE = (1, 2, 3);
DATA one: ARRAY [1] OF WORD = (7);
DATA box: Box = (9);
VAR r: ARRAY [16] OF WORD; i: WORD;
BEGIN
  r[0] := sq[5]; i := 7; r[1] := sq[i];
  r[2] := LEN(bin); r[3] := bin[3]; r[4] := bin[10];
  r[5] := LEN(wb); r[6] := wb[1];
  r[7] := LEN(msg); r[8] := msg[1]; r[9] := msg[5];
  r[10] := WORD(pts[1].y); r[11] := WORD(pts[0].x);
  r[12] := WORD(half);
  r[13] := LEN(small) + small[2];
  r[14] := one[0] + box.v;
END.`, { files: { "blob.bin": blob, "assets/words.bin": words } });
  assert.deepEqual(t.words("r", 15), [25, 49, 11, 6, 255, 2, 0x5678, 6, 69, 10, u16(-4), 1, 128, 6, 16]);
  assert.ok(t.addr("sq") < 0x4000, "DATA lives in ROM");
});

test("inline ASM: SCRIM globals, constants, procedures, locals and parameters usable as symbols", () => {
  const t = run(`
PROGRAM Inline;
CONST K = 40;
VAR g, h, res: WORD;
FUNC add3(a, b, c: WORD): WORD; BEGIN RETURN a + b + c END;
PROC p(a: WORD);
VAR t: WORD;
BEGIN
  t := a + 1;
  ASM
    LD   R0, [SP+t]      ; the local t
    ADD  R0, #K          ; a SCRIM constant
    ST   R0, [g]         ; a SCRIM global
    LD   R1, [SP+a]      ; the parameter a
    ST   R1, [h]
  END
END;
BEGIN
  p(2);
  ASM
    MOVQ R0, #3          ; calling convention: args pushed right to left, caller pops
    PUSH R0
    MOVQ R0, #20
    PUSH R0
    MOVQ R0, #100
    PUSH R0
    CALL add3
    ADD  SP, #6
    ST   R0, [res]
  END;
END.`);
  assert.deepEqual([t.w("g"), t.w("h"), t.w("res")], [43, 2, 123]);
});

test("names: keywords are case-insensitive, identifiers case-sensitive; comments nest", () => {
  const t = run(`
program Names;
var X, x: word;
(* outer (* nested *) still comment *)
begin
  X := 1; x := 2;  -- line comment
  If X < x Then x := x + 10 End
end.`);
  assert.deepEqual([t.w("X"), t.w("x")], [1, 12]);
});

test("typed constants stored to BYTE are truncated, including into register locals", () => {
  const t = run(`
PROGRAM Konst;
VAR out: ARRAY [3] OF WORD; gb: BYTE;
FUNC f: WORD;
VAR k: BYTE;
BEGIN k := WORD(1000); RETURN k END;
BEGIN
  out[0] := f(); gb := WORD(1001); out[1] := gb;
  out[2] := BYTE(WORD(1002));
END.`);
  assert.deepEqual(t.words("out", 3), [1000 & 255, 1001 & 255, 1002 & 255]);
});

test("large frames: SP offsets beyond 510 and frames beyond 256 bytes", () => {
  const t = run(`
PROGRAM Big;
VAR out: ARRAY [6] OF WORD;
FUNC big(p1, p2: WORD): WORD;
VAR buf: ARRAY [300] OF WORD; s1, s2, s3, s4, s5: WORD; bb: BYTE; i: WORD;
BEGIN
  FOR i := 0 TO 299 DO buf[i] := i END;
  s1 := 1; s2 := 2; s3 := 3; s4 := p1; s5 := p2; bb := p1 + p2;
  RETURN buf[299] + buf[150] + s1 + s2 + s3 + s4 + s5 + bb
END;
BEGIN
  out[0] := big(1000, 24);
END.`);
  assert.equal(t.w("out", 0), 299 + 150 + 1 + 2 + 3 + 1000 + 24 + ((1000 + 24) & 255));
  assert.equal(t.m.cpu.sp, 0xc000);
});

test("AT placement, redeclared predeclared PORTs, INCLUDE, 2-D comma indexing, aliases and pointer conversions, TRAP vector", () => {
  const t = run(`
PROGRAM Misc;
INCLUDE "defs.scr";
PORT VCTRL: WORD AT $F006;
TYPE Speed = INT; PB = POINTER TO BYTE;
VAR frame: WORD AT $8100;
    alias: ARRAY [2] OF BYTE AT $8100;
    m: ARRAY [2, 3] OF BYTE;
    out: ARRAY [8] OF WORD;
    s: Speed; p: PB; traps: WORD;
INTERRUPT PROC onTrap; BEGIN traps := traps + 1 END;
VECTOR TRAP := onTrap;
BEGIN
  frame := $1234;
  out[0] := alias[0]; out[1] := alias[1];
  m[1, 2] := 7; out[2] := m[1][2]; out[3] := SIZEOF(m);
  s := Speed(-5); out[4] := WORD(s * 3);
  p := @m[0, 0]; p := PB(WORD(p) + 5); out[5] := p^;
  VCTRL := 0; out[6] := LIMIT + SIZEOF(WORD);
  ASM
    TRAP #3
    TRAP #4
  END;
END.`, { files: { "defs.scr": "CONST LIMIT = 40;\n" } });
  assert.equal(t.addr("frame"), 0x8100);
  assert.equal(t.m.bus.read16(0x8100), 0x1234);
  assert.deepEqual(t.words("out", 7), [0x34, 0x12, 7, 6, u16(-15), 7, 42]);
  assert.equal(t.w("traps"), 2);
  assert.ok(t.addr("m") < 0x8100 && t.addr("out") < 0x8100, "AT variables take no space in the allocated area");
});
