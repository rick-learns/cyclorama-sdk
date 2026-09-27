// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// SCRIM compiler: shape of the generated CYASM (not wasteful; calling convention; determinism).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build, compileSrc } from "./scrim-harness.ts";
import { compile } from "../src/scrim/compile.ts";

/** Instructions of the routine starting at `label:` up to the next global label, whitespace-normalised. */
function body(asm: string, label: string): string[] {
  const lines = asm.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${label}:`));
  assert.ok(start >= 0, `label ${label} in output`);
  const out: string[] = [];
  const first = lines[start].slice(label.length + 1);
  for (const raw of [first, ...lines.slice(start + 1)]) {
    if (raw !== first && /^(?!__L\d)[A-Za-z_]\w*:/.test(raw)) break; // internal __Ln labels stay inside
    const t = raw.replace(/;.*$/, "").replace(/^\s*\.?[\w.]+:/, "").trim().replace(/\s+/g, " ");
    if (t) out.push(t);
  }
  return out;
}

test("a leaf function compiles to SP-relative loads, one ALU op and RTS (no frame, no pushes)", () => {
  const r = build(`PROGRAM C; VAR x: INT; FUNC add(a, b: INT): INT; BEGIN RETURN a + b END; BEGIN x := add(1, 2) END.`);
  assert.deepEqual(body(r.asm, "add"), ["LD R0, [SP+2]", "LD R1, [SP+4]", "ADD R0, R1", "RTS"]);
});

test("per-procedure report: code size and static worst-case cycles (spec §7)", () => {
  const r = build(`PROGRAM C; VAR x: INT; FUNC add(a, b: INT): INT; BEGIN RETURN a + b END; BEGIN x := add(1, 2) END.`);
  const add = r.report!.find((p) => p.name === "add")!;
  assert.deepEqual(add, { name: "add", bytes: 8, cycles: 4 + 4 + 2 + 6 }); // LD [SP+d] x2, ADD Rd,Rs, RTS
  assert.ok(r.report!.some((p) => p.name === "(main)" && p.bytes > 0));
});

test("calls push arguments right to left and the caller pops them", () => {
  const r = build(`PROGRAM C; VAR x: INT; FUNC add(a, b: INT): INT; BEGIN RETURN a + b END; BEGIN x := add(1, 2) END.`);
  assert.deepEqual(body(r.asm, "__main"), ["MOVQ R0, #2", "PUSH R0", "MOVQ R0, #1", "PUSH R0", "CALL add", "ADD SP, #4", "ST R0, [x]", "RTS"]);
});

test("quick forms: MOVQ/ADDQ for small constants; register locals are callee-saved with PUSHM/POPM", () => {
  const r = build(`
PROGRAM C;
VAR out: WORD;
PROC count;
VAR i, s: WORD;
BEGIN
  s := 0;
  FOR i := 1 TO 10 DO s := s + 3 END;
  out := s
END;
BEGIN count END.`);
  const b = body(r.asm, "count");
  assert.equal(b[0], "PUSHM R4-R5");
  assert.ok(b.includes("MOVQ R5, #0") || b.includes("MOVQ R4, #0"), b.join(" | "));
  assert.ok(b.some((l) => /^ADDQ R[45], #3$/.test(l)), b.join(" | "));
  assert.ok(b.some((l) => /^ADDQ R[45], #1$/.test(l)), b.join(" | "));
  assert.deepEqual(b.slice(-2), ["POPM R4-R5", "RTS"]);
});

test("FIXED * FIXED uses FMUL; FIXED * INT and INT * INT use MUL; powers of two become shifts", () => {
  const r = build(`
PROGRAM C;
VAR f, g: FIXED; i, j: INT; w: WORD;
BEGIN
  f := f * g;
  g := g * i;
  i := i * j;
  w := w * 8;
  w := w / 4;
  w := w MOD 16
END.`);
  const b = body(r.asm, "__main");
  assert.equal(b.filter((l) => l.startsWith("FMUL ")).length, 1);
  assert.equal(b.filter((l) => l.startsWith("MUL ")).length, 2);
  assert.ok(b.includes("SHL R0, #3") && b.includes("SHR R0, #2") && b.includes("AND R0, #15"), b.join(" | "));
  assert.equal(r.symbols!.has("__divu"), false);
});

test("locals and parameters use [SP+d]; pointer fields use short [Rs+d] forms", () => {
  const r = build(`
PROGRAM C;
TYPE Actor = RECORD x, y: INT; hp: WORD END;
VAR a: Actor; out: WORD;
PROC hurt(p: POINTER TO Actor; n: WORD);
BEGIN p^.hp := p^.hp - n END;
BEGIN hurt(@a, 3); out := a.hp END.`);
  const b = body(r.asm, "hurt");
  assert.ok(b.some((l) => /\[SP\+2\]/.test(l)) && b.some((l) => /\[SP\+4\]/.test(l)), b.join(" | "));
  assert.ok(b.some((l) => /\[R\d\+4\]/.test(l)), b.join(" | "));
  assert.ok(b.length <= 6, `hurt is ${b.length} instructions: ${b.join(" | ")}`); // p is loaded once for p^.hp := p^.hp - n
});

test("bit tests (x AND m) <> 0 compile to a single TST; comparisons with 0 use TST Rd,Rd", () => {
  const r = build(`
PROGRAM C; VAR w, n: WORD; i: INT;
BEGIN
  IF (w AND 4) <> 0 THEN n := 1 END;
  IF i < 0 THEN n := 2 END
END.`);
  assert.deepEqual(body(r.asm, "__main").slice(0, 3), ["LD R0, [w]", "TST R0, #4", "BEQ __L1"]);
  assert.ok(body(r.asm, "__main").includes("TST R0, R0"));
});

test("INTERRUPT PROC saves R0-R7 and returns with RTI; unused vectors point at a bare RTI", () => {
  const r = build(`
PROGRAM C; VAR n: WORD;
INTERRUPT PROC tick; BEGIN n := n + 1; IF_PORT := 4 END;
VECTOR TIMER := tick;
BEGIN END.`);
  const b = body(r.asm, "tick");
  assert.equal(b[0], "PUSHM R0-R7");
  assert.deepEqual(b.slice(-2), ["POPM R0-R7", "RTI"]);
  const rom = r.rom!;
  const vec = (a: number) => rom[a] | (rom[a + 1] << 8);
  assert.equal(vec(6), r.symbols!.get("tick"));
  assert.equal(vec(2), r.symbols!.get("__irq_rti"));
  assert.deepEqual(body(r.asm, "__irq_rti"), ["RTI"]);
});

test("long branches are relaxed automatically (conditional over a large body)", () => {
  const stmts = Array.from({ length: 200 }, (_, i) => `x := x + ${i + 300};`).join("\n");
  const r = build(`PROGRAM C; VAR x, y: WORD;\nBEGIN\n IF y = 0 THEN\n${stmts}\n END\nEND.`);
  assert.ok(/\bJMP\b/.test(body(r.asm, "__main").join("\n")));
});

test("determinism: the same sources give identical assembly and ROM bytes", () => {
  const src = readFileSync("roms/lantern-scrim/lantern-scrim.scr", "utf8");
  const a = compileSrc(src), b = compileSrc(src);
  assert.equal(a.errors.length, 0, a.errors.map((e) => e.message).join("\n"));
  assert.equal(a.asm, b.asm);
  assert.deepEqual(a.rom, b.rom);
  const c = compile("roms/lantern-scrim/lantern-scrim.scr", (p) => readFileSync(p));
  assert.deepEqual(c.rom, a.rom, "reading the file as bytes changes nothing");
  assert.doesNotMatch(a.asm, /\d{4}-\d\d-\d\d|\d\d:\d\d:\d\d/, "no timestamps in the output");
});
