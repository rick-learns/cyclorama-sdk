// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Disassembler: exact text for representative forms and the round-trip
// property disassemble -> assemble -> identical bytes over the whole ISA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { enc, decode, hasExtension } from "../src/isa/isa.ts";
import { assemble } from "../src/asm/assembler.ts";
import { disassemble } from "../src/asm/disassembler.ts";

function asmOk(src: string) {
  const r = assemble("t.asm", () => src);
  assert.deepEqual(r.errors.slice(0, 5), [], "assembly errors");
  return r;
}
function bytesOf(words: number[]): Uint8Array {
  const b = new Uint8Array(words.length * 2);
  words.forEach((w, i) => { b[i * 2] = w & 255; b[i * 2 + 1] = w >> 8; });
  return b;
}
const text1 = (words: number[], addr = 0) => {
  const mem = new Uint8Array(0x10000);
  mem.set(bytesOf(words), addr);
  return disassemble(mem, addr, 1)[0].text;
};

test("disassembler: text for representative forms", () => {
  assert.equal(text1([enc.unary(0)]), "NOP");
  assert.equal(text1([enc.unary(7, 0, 9)]), "TRAP #9");
  assert.equal(text1([enc.unary(8, 3)]), "NOT R3");
  assert.equal(text1([enc.unary(15, 2, 15)]), "SHL R2, #16");
  assert.equal(text1([enc.unary(19, 4)]), "JMP [R4]");
  assert.equal(text1([enc.unary(23, 1)]), "MOV R1, SP");
  assert.equal(text1([enc.unary(24, 1)]), "MOV SP, R1");
  assert.equal(text1([enc.aluR(1, 2, 5)]), "ADD R2, R5");
  assert.equal(text1([enc.aluI(5, 3), 0x1234]), "CMPW R3, #$1234");
  assert.equal(text1([enc.quick(false, 3, -128)]), "MOV R3, #-128");
  assert.equal(text1([enc.quick(true, 3, 5)]), "ADD R3, #5");
  assert.equal(text1([enc.mem(false, false, 1, 2, 3)]), "LD R1, [R2+6]");
  assert.equal(text1([enc.mem(true, true, 1, 2, 0)]), "STB R1, [R2]");
  assert.equal(text1([enc.memx(1, 2, false, false, 0), 0x80]), "LDX R1, [R2+$0080]");
  assert.equal(text1([enc.memx(1, 0, false, true, 1), 0xf002]), "ST R1, [$F002]");
  assert.equal(text1([enc.memx(1, 2, true, false, 2)]), "LDB R1, [R2]+");
  assert.equal(text1([enc.memx(1, 2, false, true, 3)]), "ST R1, -[R2]");
  assert.equal(text1([enc.sprel(6, true, 5)]), "ST R6, [SP+10]");
  assert.equal(text1([enc.branch(1, -2)], 0x100), "BEQ $00FE");
  assert.equal(text1([enc.long(0), 0x1234]), "JMP $1234");
  assert.equal(text1([enc.long(1), 0x0200]), "CALL $0200");
  assert.equal(text1([enc.long(2, 0b0011_1001)]), "PUSHM R0, R3-R5");
  assert.equal(text1([enc.long(4, -2)]), "ADD SP, #-4");
  assert.equal(text1([enc.long(5, 3 << 5), 0x2000]), "JMPT R3, $2000");
  assert.equal(text1([0xc123]), ".word $C123");
  assert.equal(text1([enc.unary(0, 1)]), ".word $0010", "must-be-zero bits set");
});

test("disassembler: addresses and word counts for a sequence", () => {
  const b = bytesOf([enc.unary(0), enc.aluI(0, 1), 0x1234, enc.long(0), 0x100]);
  const out = disassemble(b, 0, 3);
  assert.deepEqual(out.map((x) => x.addr), [0, 2, 6]);
  assert.deepEqual(out.map((x) => x.words), [[0], [enc.aluI(0, 1), 0x1234], [enc.long(0), 0x100]]);
});

test("disassembler: an assembled program with every form disassembles without .word and round-trips", () => {
  const src = [".org $100", "NOP", "STOP", "WAI", "RTS", "RTI", "EI", "DI", "TRAP #3", "NOT R1", "NEG R2", "INC R3",
    "DEC R4", "SXB R5", "ZXB R6", "SWPB R7", "SHL R0,#1", "SHR R1,#16", "ASR R2,#7", "ROL R3,#2", "JMP [R4]",
    "CALL [R5]", "PUSH R6", "POP R7", "MOV R0,SP", "MOV SP,R1", "GETF R2", "SETF R3",
    "MOV R1,R2", "FMUL R3,R4", "MOVW R1,#5", "SHLW R2,#3", "XOR R3,#$F0F0", "MOV R1,#-1", "ADD R1,#100",
    "LD R1,[R2+8]", "ST R1,[R2]", "LDB R1,[R2+63]", "STB R1,[R2+1]", "LD R1,[R2+200]", "LDBX R1,[R2+1]",
    "ST R1,[VDATA]", "LD R1,[R2]+", "STB R1,-[R3]", "LD R0,[SP+4]", "ST R0,[SP+510]",
    "t: BRA t", "BNE t", "BSR t", "JMP t", "CALL t", "PUSHM R0-R7", "POPM R1,R3", "ADD SP,#-256", "JMPT R2,t", "end:"].join("\n");
  const a = asmOk(src);
  const end = a.symbols.get("end")!;
  const lines = [];
  for (let addr = 0x100; addr < end;) {
    const [x] = disassemble(a.rom, addr, 1);
    assert.ok(!x.text.startsWith(".word"), `${addr.toString(16)}: ${x.text}`);
    lines.push(x.text);
    addr += x.words.length * 2;
  }
  const b = asmOk(".org $100\n" + lines.join("\n"));
  assert.deepEqual(b.rom, a.rom);
});

test("round trip: every non-reserved first word (zero extension) disassembles and re-assembles identically", () => {
  const all: number[] = [];
  for (let w = 0; w < 0x10000; w++) if (decode(w).kind !== "reserved") all.push(w);
  const BASE = 0x100, CHUNK = 2048;
  let instructions = 0;
  for (let i = 0; i < all.length; i += CHUNK) {
    const words: number[] = [];
    for (const w of all.slice(i, i + CHUNK)) { words.push(w); if (hasExtension(w)) words.push(0); }
    const image = new Uint8Array(0x4000).fill(0xff);
    image.set(bytesOf(words), BASE);
    const n = Math.min(CHUNK, all.length - i);
    const dis = disassemble(image, BASE, n);
    assert.equal(dis.length, n);
    assert.deepEqual(dis.flatMap((d) => d.words), words, "disassembler consumed the right words");
    const r = assemble("rt.asm", () => `.org $${BASE.toString(16)}\n` + dis.map((d) => d.text).join("\n"));
    assert.deepEqual(r.errors.slice(0, 3), [], `chunk at word index ${i}`);
    const got = r.rom.slice(BASE, BASE + words.length * 2);
    const want = image.slice(BASE, BASE + words.length * 2);
    if (!Buffer.from(got).equals(Buffer.from(want))) {
      for (let k = 0; k < dis.length; k++) {
        const off = dis[k].addr;
        const g = [...r.rom.slice(off, off + dis[k].words.length * 2)];
        const e = [...image.slice(off, off + dis[k].words.length * 2)];
        assert.deepEqual(g, e, `${dis[k].text} @${off.toString(16)}`);
      }
    }
    instructions += n;
  }
  assert.equal(instructions, all.length);
});

test("reserved encodings disassemble to .word", () => {
  for (const w of [0xc000, 0xffff, enc.unary(27), enc.long(6)]) assert.match(text1([w]), /^\.word \$[0-9A-F]{4}$/);
});
