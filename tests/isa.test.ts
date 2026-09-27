// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Tally ISA table: encodings and a total decoder over all 65,536 words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { enc, decode, hasExtension, ALU_OPS, UNARY_OPS, CONDITIONS } from "../src/isa/isa.ts";

test("encoders produce the documented bit layouts", () => {
  assert.equal(enc.unary(8, 3), 0b0000_01000_011_0000);           // NOT R3
  assert.equal(enc.aluR(1, 2, 5), 0b0001_0001_010_101_00);          // ADD R2,R5
  assert.equal(enc.aluI(0, 7), 0b0010_0000_111_000_00);             // MOV R7,#imm16
  assert.equal(enc.quick(true, 4, -1), 0b0011_100_1_11111111);      // ADDQ R4,#-1
  assert.equal(enc.mem(false, false, 1, 2, 3), 0b0100_001_010_000011); // LD R1,[R2+6]
  assert.equal(enc.mem(true, true, 1, 2, 3), 0b0111_001_010_000011);   // STB R1,[R2+3]
  assert.equal(enc.memx(1, 2, false, true, 2), 0b1000_001_010_0_1_10_00); // ST R1,[R2]+
  assert.equal(enc.sprel(6, true, 5), 0b1001_110_1_00000101);        // ST R6,[SP+10]
  assert.equal(enc.branch(1, -2), 0b1010_0001_11111110);            // BEQ -2 words
  assert.equal(enc.long(2, 0x81), 0b1011_0010_10000001);            // PUSHM {R0,R7}
});

test("decoder: every one of the 65,536 words decodes to exactly one form", () => {
  const seen = new Map<string, number>();
  for (let w = 0; w < 0x10000; w++) {
    const d = decode(w);
    assert.ok(d.mnemonic.length > 0, `word ${w.toString(16)}`);
    seen.set(d.mnemonic, (seen.get(d.mnemonic) ?? 0) + 1);
  }
  for (const op of ALU_OPS) assert.ok(seen.has(op), `ALU ${op} reachable`);
  for (const op of UNARY_OPS) assert.ok(seen.has(op), `unary ${op} reachable`);
  for (const c of CONDITIONS) assert.ok(seen.has("B" + c), `B${c} reachable`);
  for (const m of ["MOVQ", "ADDQ", "LD", "ST", "LDB", "STB", "JMP", "CALL", "PUSHM", "POPM", "ADDSP", "JMPT"]) assert.ok(seen.has(m), m);
  assert.ok(seen.has("RESERVED"));
});

test("decoder: hasExtension agrees with decoded operand kinds", () => {
  for (let w = 0; w < 0x10000; w++) assert.equal(hasExtension(w), decode(w).ext, `word ${w.toString(16)}`);
});

test("decoder: fields round-trip through the encoders", () => {
  assert.deepEqual(decode(enc.aluR(5, 6, 1)), { mnemonic: "CMP", kind: "aluR", op: 5, d: 6, s: 1, ext: false });
  assert.deepEqual(decode(enc.aluI(15, 2)), { mnemonic: "FMUL", kind: "aluI", op: 15, d: 2, ext: true });
  assert.deepEqual(decode(enc.quick(false, 3, -128)), { mnemonic: "MOVQ", kind: "quick", d: 3, imm: -128, ext: false });
  assert.deepEqual(decode(enc.mem(true, false, 7, 0, 63)), { mnemonic: "LDB", kind: "mem", d: 7, s: 0, disp: 63, ext: false });
  assert.deepEqual(decode(enc.mem(false, true, 7, 0, 63)), { mnemonic: "ST", kind: "mem", d: 7, s: 0, disp: 126, ext: false });
  assert.deepEqual(decode(enc.memx(1, 2, true, false, 3)), { mnemonic: "LDB", kind: "memx", d: 1, s: 2, mode: 3, ext: false });
  assert.deepEqual(decode(enc.memx(1, 2, false, false, 1)), { mnemonic: "LD", kind: "memx", d: 1, s: 2, mode: 1, ext: true });
  assert.deepEqual(decode(enc.sprel(0, false, 255)), { mnemonic: "LD", kind: "sprel", d: 0, disp: 510, ext: false });
  assert.deepEqual(decode(enc.branch(15, 127)), { mnemonic: "BSR", kind: "branch", cond: 15, disp: 127, ext: false });
  assert.deepEqual(decode(enc.unary(15, 4, 15)), { mnemonic: "SHLI", kind: "unary", op: 15, d: 4, imm: 15, ext: false });
  assert.deepEqual(decode(enc.long(4, 0xff)), { mnemonic: "ADDSP", kind: "long", op: 4, imm: -1, ext: false });
  assert.deepEqual(decode(enc.long(5, 3 << 5)), { mnemonic: "JMPT", kind: "long", op: 5, d: 3, ext: true });
  assert.deepEqual(decode(enc.long(2, 0x81)), { mnemonic: "PUSHM", kind: "long", op: 2, mask: 0x81, ext: false });
});

test("decoder: reserved encodings", () => {
  for (const w of [0xc000, 0xd123, 0xe000, 0xffff, enc.unary(27), enc.unary(31), enc.long(6), enc.long(15)])
    assert.equal(decode(w).mnemonic, "RESERVED", w.toString(16));
});
