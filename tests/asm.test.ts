// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// CYASM assembler (spec-notes §7): golden encodings, directives, expressions,
// header/checksum, bank layout and error reporting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { enc, ALU_OPS, UNARY_OPS, CONDITIONS } from "../src/isa/isa.ts";
import { reg } from "../src/hw/registers.ts";
import { assemble } from "../src/asm/assembler.ts";
import type { AsmError } from "../src/asm/assembler.ts";

type Files = Record<string, string | Uint8Array>;

function run(src: string, files: Files = {}) {
  const all: Files = { "main.asm": src, ...files };
  return assemble("main.asm", (p) => {
    if (!(p in all)) throw new Error(`no such file: ${p}`);
    return all[p];
  });
}
function ok(src: string, files: Files = {}) {
  const r = run(src, files);
  assert.deepEqual(r.errors, [], "unexpected errors");
  return r;
}
const w16 = (rom: Uint8Array, off: number) => rom[off] | (rom[off + 1] << 8);

/** Assemble `src` at bank 0 $0100 and return the emitted words. */
function code(src: string): number[] {
  const r = ok(`.org $100\n${src}\n__end:`);
  const end = r.symbols.get("__end")!;
  const out: number[] = [];
  for (let a = 0x100; a < end; a += 2) out.push(w16(r.rom, a));
  return out;
}
const U = (name: string) => UNARY_OPS.indexOf(name as (typeof UNARY_OPS)[number]);
const A = (name: string) => ALU_OPS.indexOf(name as (typeof ALU_OPS)[number]);

function errs(src: string, files: Files = {}): AsmError[] {
  const r = run(src, files);
  assert.ok(r.errors.length > 0, "expected at least one error");
  return r.errors;
}
function expectError(src: string, line: number, re: RegExp, files: Files = {}) {
  const e = errs(src, files);
  assert.ok(e.some((x) => x.line === line && re.test(x.message)),
    `expected error matching ${re} on line ${line}, got ${JSON.stringify(e)}`);
}

// ---------------------------------------------------------------------------
// Group 0
test("group 0: zero-operand instructions", () => {
  for (const m of ["NOP", "STOP", "WAI", "RTS", "RTI", "EI", "DI"]) assert.deepEqual(code(m), [enc.unary(U(m))], m);
});
test("group 0: TRAP and single-register ops", () => {
  assert.deepEqual(code("TRAP #5"), [enc.unary(U("TRAP"), 0, 5)]);
  assert.deepEqual(code("TRAP #15"), [enc.unary(U("TRAP"), 0, 15)]);
  for (const m of ["NOT", "NEG", "INC", "DEC", "SXB", "ZXB", "SWPB", "PUSH", "POP", "GETF", "SETF"])
    assert.deepEqual(code(`${m} R3`), [enc.unary(U(m), 3)], m);
});
test("group 0: immediate shifts (n = 1..16 -> imm4 = n-1)", () => {
  assert.deepEqual(code("SHL R2, #1"), [enc.unary(U("SHLI"), 2, 0)]);
  assert.deepEqual(code("SHL R2, #16"), [enc.unary(U("SHLI"), 2, 15)]);
  assert.deepEqual(code("SHR R5, #4"), [enc.unary(U("SHRI"), 5, 3)]);
  assert.deepEqual(code("ASR R6, #8"), [enc.unary(U("ASRI"), 6, 7)]);
  assert.deepEqual(code("ROL R7, #3"), [enc.unary(U("ROLI"), 7, 2)]);
  assert.deepEqual(code("SHLI R1, #2"), [enc.unary(U("SHLI"), 1, 1)], "raw mnemonic alias");
});
test("group 0: JMP/CALL [Rd], SP moves", () => {
  assert.deepEqual(code("JMP [R4]"), [enc.unary(U("JMPR"), 4)]);
  assert.deepEqual(code("CALL [R5]"), [enc.unary(U("CALLR"), 5)]);
  assert.deepEqual(code("MOV R1, SP"), [enc.unary(U("MOVFS"), 1)]);
  assert.deepEqual(code("MOV SP, R2"), [enc.unary(U("MOVTS"), 2)]);
});

// Groups 1-3
test("group 1: every ALU op register-register", () => {
  ALU_OPS.forEach((m, i) => assert.deepEqual(code(`${m} R1, R2`), [enc.aluR(i, 1, 2)], m));
});
test("group 2: every ALU op with forced 16-bit immediate (opW)", () => {
  // shift/rotate counts must be 0..15 (spec-notes §10.57)
  ALU_OPS.forEach((m, i) => {
    const v = ["SHL", "SHR", "ASR", "ROL"].includes(m) ? 5 : 0x1234;
    assert.deepEqual(code(`${m}W R3, #${v}`), [enc.aluI(i, 3), v], m);
  });
});
test("group 2: plain immediate forms", () => {
  assert.deepEqual(code("CMP R3, #1000"), [enc.aluI(A("CMP"), 3), 1000]);
  assert.deepEqual(code("AND R0, #5"), [enc.aluI(A("AND"), 0), 5]);
  assert.deepEqual(code("MOV R1, #200"), [enc.aluI(A("MOV"), 1), 200]);
  assert.deepEqual(code("ADD R1, #-129"), [enc.aluI(A("ADD"), 1), 0xff7f]);
  assert.deepEqual(code("MOV R1, #$FFFF"), [enc.aluI(A("MOV"), 1), 0xffff]);
});
test("group 3: short form selection for MOV/ADD", () => {
  assert.deepEqual(code("MOV R1, #-5"), [enc.quick(false, 1, -5)]);
  assert.deepEqual(code("MOV R1, #127"), [enc.quick(false, 1, 127)]);
  assert.deepEqual(code("MOV R1, #-128"), [enc.quick(false, 1, -128)]);
  assert.deepEqual(code("MOV R1, #128"), [enc.aluI(0, 1), 128]);
  assert.deepEqual(code("ADD R2, #127"), [enc.quick(true, 2, 127)]);
  assert.deepEqual(code("MOVQ R4, #1"), [enc.quick(false, 4, 1)]);
  assert.deepEqual(code("ADDQ R4, #-1"), [enc.quick(true, 4, -1)]);
  assert.deepEqual(code("MOVW R1, #5"), [enc.aluI(0, 1), 5], "MOVW forces the long form");
  assert.deepEqual(code("ADDW R1, #5"), [enc.aluI(1, 1), 5], "ADDW forces the long form");
});
test("short form needs a value known in pass 1 (forward reference -> long form)", () => {
  assert.deepEqual(code("MOV R1, #FWD\nFWD = 5"), [enc.aluI(0, 1), 5]);
  assert.deepEqual(code("BACK = 5\nMOV R1, #BACK"), [enc.quick(false, 1, 5)]);
  assert.deepEqual(code("LD R1, [R2+OFS]\nOFS = 4"), [enc.memx(1, 2, false, false, 0), 4]);
  assert.deepEqual(code("OFS = 4\nLD R1, [R2+OFS]"), [enc.mem(false, false, 1, 2, 2)]);
});

// Groups 4-9: addressing modes
test("groups 4-7: short displacement forms", () => {
  assert.deepEqual(code("LD R1, [R2]"), [enc.mem(false, false, 1, 2, 0)]);
  assert.deepEqual(code("LD R1, [R2+126]"), [enc.mem(false, false, 1, 2, 63)]);
  assert.deepEqual(code("ST R3, [R4+6]"), [enc.mem(false, true, 3, 4, 3)]);
  assert.deepEqual(code("LDB R1, [R2+63]"), [enc.mem(true, false, 1, 2, 63)]);
  assert.deepEqual(code("STB R7, [R0+1]"), [enc.mem(true, true, 7, 0, 1)]);
});
test("group 8: all four modes", () => {
  assert.deepEqual(code("LD R1, [R2+128]"), [enc.memx(1, 2, false, false, 0), 128]);
  assert.deepEqual(code("LDB R1, [R2+64]"), [enc.memx(1, 2, true, false, 0), 64]);
  assert.deepEqual(code("ST R1, [R2-2]"), [enc.memx(1, 2, false, true, 0), 0xfffe]);
  assert.deepEqual(code("STB R1, [R2+$1000]"), [enc.memx(1, 2, true, true, 0), 0x1000]);
  assert.deepEqual(code("LDX R1, [R2+4]"), [enc.memx(1, 2, false, false, 0), 4], "LDX forces mode 00");
  assert.deepEqual(code("STBX R1, [R2]"), [enc.memx(1, 2, true, true, 0), 0]);
  assert.deepEqual(code("LD R1, [$8000]"), [enc.memx(1, 0, false, false, 1), 0x8000]);
  assert.deepEqual(code("ST R1, [VDATA]"), [enc.memx(1, 0, false, true, 1), reg("VDATA").addr]);
  assert.deepEqual(code("LDB R3, [$8001]"), [enc.memx(3, 0, true, false, 1), 0x8001]);
  assert.deepEqual(code("STB R3, [PAD1+1]"), [enc.memx(3, 0, true, true, 1), 0xf0c1]);
  assert.deepEqual(code("LD R1, [R2]+"), [enc.memx(1, 2, false, false, 2)]);
  assert.deepEqual(code("ST R1, [R2]+"), [enc.memx(1, 2, false, true, 2)]);
  assert.deepEqual(code("LDB R1, -[R2]"), [enc.memx(1, 2, true, false, 3)]);
  assert.deepEqual(code("STB R1, -[R2]"), [enc.memx(1, 2, true, true, 3)]);
});
test("group 9: SP-relative", () => {
  assert.deepEqual(code("LD R1, [SP+10]"), [enc.sprel(1, false, 5)]);
  assert.deepEqual(code("ST R6, [SP+510]"), [enc.sprel(6, true, 255)]);
  assert.deepEqual(code("LD R0, [SP]"), [enc.sprel(0, false, 0)]);
});

// Groups A-B
test("group A: every condition, forward and backward, aliases", () => {
  CONDITIONS.forEach((c, i) => {
    assert.deepEqual(code(`B${c} t\nNOP\nt:`), [enc.branch(i, 1), enc.unary(0)], `B${c} fwd`);
    assert.deepEqual(code(`t: B${c} t`), [enc.branch(i, -1)], `B${c} self`);
  });
  assert.deepEqual(code("BCS t\nt:"), [enc.branch(CONDITIONS.indexOf("LO"), 0)]);
  assert.deepEqual(code("BCC t\nt:"), [enc.branch(CONDITIONS.indexOf("HS"), 0)]);
  assert.deepEqual(code("BRA *"), [enc.branch(0, -1)]);
});
test("group A: branch range edges", () => {
  // +127 words: target = next + 254
  assert.deepEqual(code("BRA t\n.fill 254\nt:")[0], enc.branch(0, 127));
  // -128 words: target = next - 256
  const c = code("t: .fill 254\nBRA t");
  assert.equal(c[c.length - 1], enc.branch(0, -128));
});
test("group B: long control", () => {
  assert.deepEqual(code("JMP $1234"), [enc.long(0), 0x1234]);
  assert.deepEqual(code("CALL t\nt:"), [enc.long(1), 0x104]);
  assert.deepEqual(code("PUSHM R0, R3-R5"), [enc.long(2, 0b0011_1001)]);
  assert.deepEqual(code("POPM R7"), [enc.long(3, 0x80)]);
  assert.deepEqual(code("PUSHM {R0,R7}"), [enc.long(2, 0x81)]);
  assert.deepEqual(code("ADD SP, #-4"), [enc.long(4, -2)]);
  assert.deepEqual(code("ADD SP, #254"), [enc.long(4, 127)]);
  assert.deepEqual(code("ADD SP, #-256"), [enc.long(4, -128)]);
  assert.deepEqual(code("JMPT R3, $2000"), [enc.long(5, 3 << 5), 0x2000]);
});

test("case-insensitive mnemonics, registers and directives; case-sensitive symbols", () => {
  assert.deepEqual(code("mov r1, r2\nld r1, [sp+2]\n.WORD 7"), [enc.aluR(0, 1, 2), enc.sprel(1, false, 1), 7]);
  assert.deepEqual(code("foo = 1\nFoo = 2\n.word foo, Foo"), [1, 2]);
});

// ---------------------------------------------------------------------------
// Expressions
test("expressions: numbers and C precedence", () => {
  assert.deepEqual(code(".word 10, $1F, 0x1F, %1010, 'A'"), [10, 0x1f, 0x1f, 10, 65]);
  assert.deepEqual(code(".word 2+3*4, (2+3)*4, 1+2<<3, 1<<4|1, 6&3^1, 10-2-3"), [14, 20, 24, 17, 3, 5]);
  assert.deepEqual(code(".word 7%3, 100/7, -7/2, -3*2, ~0&$FF, 3|4&1"), [1, 14, 0xfffd, 0xfffa, 255, 3]);
  assert.deepEqual(code(".word 1<<2+1, 256>>4, 5^3, -(1+2)"), [8, 16, 6, 0xfffd]);
  assert.deepEqual(code(".byte <$1234, >$1234, '\\n', ';'\n.align 2"), [0x1234, 0x3b0a]);
});
test("expressions: * is current address or multiplication by position", () => {
  assert.deepEqual(code(".word *, * * 2, *+2"), [0x100, 0x200, 0x102], "* is the address of the statement");
});

// ---------------------------------------------------------------------------
// Labels and symbols
test("local labels are scoped to the last non-local label", () => {
  const r = ok(".org $100\na: NOP\n.loop: BRA .loop\nb: NOP\n.loop: BRA .loop\nBRA a.loop");
  assert.equal(r.symbols.get("a.loop"), 0x102);
  assert.equal(r.symbols.get("b.loop"), 0x106);
  assert.equal(w16(r.rom, 0x102), enc.branch(0, -1));
  assert.equal(w16(r.rom, 0x106), enc.branch(0, -1));
  assert.equal(w16(r.rom, 0x108), enc.branch(0, -4));
});
test("forward references and constants (= and .equ)", () => {
  const r = ok(".org $100\nJMP later\nK = later + 2\nJ .equ K * 2\n.word K, J\nlater: NOP");
  assert.equal(w16(r.rom, 0x102), 0x108);
  assert.equal(w16(r.rom, 0x104), 0x10a);
  assert.equal(w16(r.rom, 0x106), 0x214);
  assert.equal(r.symbols.get("K"), 0x10a);
  assert.equal(r.symbols.get("later"), 0x108);
});
test("predefined I/O register symbols", () => {
  assert.deepEqual(code(".word VADDR, IE, IF, BANK, DMACTL, L3F"), [0xf000, 0xf0d8, 0xf0da, 0xe000, 0xf0e6, reg("L3F").addr]);
});

// ---------------------------------------------------------------------------
// Directives
test(".byte .word .ascii .asciz .fill .align", () => {
  const r = ok('.org $200\n.byte 1, $FF, -1, "hi"\n.word -1, $ABCD\n.ascii "AB"\n.asciz "C"\n.fill 3, $EE\n.byte 9\n.align 4\n.fill 2');
  assert.deepEqual([...r.rom.slice(0x200, 0x219)],
    [1, 0xff, 0xff, 0x68, 0x69, 0xff, 0xff, 0xcd, 0xab, 0x41, 0x42, 0x43, 0, 0xee, 0xee, 0xee,
      9, 0xff, 0xff, 0xff, 0, 0, 0xff, 0xff, 0xff]);
});
test(".org sets the address and unused bytes are $FF", () => {
  const r = ok(".org $20\n.byte 1\n.org $10\n.byte 2");
  assert.equal(r.rom[0x20], 1);
  assert.equal(r.rom[0x10], 2);
  assert.equal(r.rom[0x00], 0xff);
  assert.equal(r.rom[0x21], 0xff);
});
test(".include (relative to the including file) and .incbin", () => {
  const r = ok('.org $100\n.include "lib/a.asm"\n.incbin "data.bin"\nend:', {
    "lib/a.asm": 'x: .word 1\n.include "b.asm"',
    "lib/b.asm": "y: .word 2",
    "data.bin": new Uint8Array([9, 8, 7]),
  });
  assert.deepEqual([...r.rom.slice(0x100, 0x107)], [1, 0, 2, 0, 9, 8, 7]);
  assert.equal(r.symbols.get("y"), 0x102);
  assert.equal(r.symbols.get("end"), 0x107);
});
test(".rom and default size (highest bank + 1, power of two, min 2)", () => {
  assert.equal(ok("NOP").rom.length, 2 * 16384);
  assert.equal(ok(".bank 2\nNOP").rom.length, 4 * 16384);
  assert.equal(ok(".bank 4\nNOP").rom.length, 8 * 16384);
  assert.equal(ok(".rom 1\nNOP").rom.length, 16384);
  assert.equal(ok(".rom 16\nNOP").rom.length, 16 * 16384);
  assert.ok(ok(".rom 4").rom.every((b) => b === 0xff));
});
test("multi-bank layout: bank 0 at 0000, others at 4000 with bank-local labels", () => {
  const r = ok(".org 0\n.word start\nstart: NOP\n.bank 1\nb1: .word b1\n.bank 3\n.org $7FFE\nb3: .word $1234\n.bank 1\nafter1: .word 5");
  assert.equal(r.rom.length, 4 * 16384);
  assert.equal(w16(r.rom, 0), 2);
  assert.equal(r.symbols.get("b1"), 0x4000);
  assert.equal(w16(r.rom, 0x4000), 0x4000);
  assert.equal(r.symbols.get("b3"), 0x7ffe);
  assert.equal(w16(r.rom, 3 * 0x4000 + 0x3ffe), 0x1234);
  assert.equal(r.symbols.get("after1"), 0x4002, ".bank resumes where the bank left off");
  assert.equal(w16(r.rom, 0x4002), 5);
  assert.equal(r.rom[2 * 0x4000], 0xff, "unused bank is padding");
});
test(".header: magic, fields, size byte and checksum", () => {
  const r = ok('.header title="LANTERN", dev=$4A21, date=$19910412, version=$0102, ram=1, generation=1\n.rom 4\n.org 0\n.word $100\n.org $100\nSTOP');
  const rom = r.rom;
  assert.equal(String.fromCharCode(...rom.slice(0x10, 0x14)), "CYCL");
  assert.equal(rom[0x14], 1);
  assert.equal(rom[0x15], 3);
  assert.equal(rom[0x16], 1);
  assert.equal(rom[0x17], 1);
  assert.equal(String.fromCharCode(...rom.slice(0x18, 0x30)), "LANTERN".padEnd(24, " "));
  assert.equal(w16(rom, 0x30), 0x4a21);
  assert.deepEqual([...rom.slice(0x32, 0x36)], [0x12, 0x04, 0x91, 0x19]);
  assert.equal(w16(rom, 0x36), 0x0102);
  assert.deepEqual([...rom.slice(0x3a, 0x40)], [0, 0, 0, 0, 0, 0]);
  let sum = 0;
  for (let i = 0; i < rom.length; i += 2) if (i !== 0x38) sum = (sum + w16(rom, i)) & 0xffff;
  assert.equal(w16(rom, 0x38), sum);
});
test(".header defaults and size byte from default ROM size", () => {
  const r = ok(".header\n.bank 5\nNOP");
  assert.equal(r.rom.length, 8 * 16384);
  assert.equal(r.rom[0x15], 7);
  assert.equal(String.fromCharCode(...r.rom.slice(0x18, 0x30)), " ".repeat(24));
});

test("listing and symbol table", () => {
  const r = ok(".org $100\nstart: MOV R1, #$1234 ; load\nK = 3");
  assert.match(r.listing, /0100\s+2020 1234/i);
  assert.match(r.listing, /MOV R1, #\$1234/);
  assert.equal(r.symbols.get("start"), 0x100);
  assert.equal(r.symbols.get("K"), 3);
  assert.equal(r.symbols.has("VDATA"), false, "predefined symbols are not exported");
});

test("determinism: assembling twice gives identical output", () => {
  const src = '.header title="X"\n.org 0\n.word s\n.org $40\ns: MOV R1,#t\n BRA s\nt: .asciz "abc"\n.bank 3\n.word 1';
  const a = ok(src), b = ok(src);
  assert.deepEqual(a.rom, b.rom);
  assert.equal(a.listing, b.listing);
  assert.deepEqual([...a.symbols], [...b.symbols]);
});

// ---------------------------------------------------------------------------
// Errors
test("error: unknown mnemonic", () => expectError("NOP\nFROB R1", 2, /unknown (mnemonic|instruction).*FROB/i));
test("error: undefined symbol", () => expectError("NOP\nNOP\nJMP nowhere", 3, /undefined symbol.*nowhere/i));
test("error: out-of-range immediates", () => {
  expectError("MOVQ R1, #200", 1, /range/i);
  expectError("TRAP #16", 1, /range/i);
  expectError("SHL R1, #0", 1, /range|1\.\.16/i);
  expectError("SHL R1, #17", 1, /range|1\.\.16/i);
  expectError("MOV R1, #70000", 1, /range/i);
  expectError(".byte 256", 1, /range/i);
  expectError("ADD SP, #3", 1, /even/i);
  expectError("ADD SP, #256", 1, /range/i);
});
test("error: branch out of range and misaligned target", () => {
  expectError("BRA t\n.fill 256\nt:", 1, /out of range/i);
  expectError("NOP\nBEQ t\n.byte 1\nt:", 2, /odd|align/i);
});
test("error: odd word displacements and bad SP displacements", () => {
  expectError("LD R1, [R2+3]", 1, /odd/i);
  expectError("ST R1, [R2+301]", 1, /odd/i);
  expectError("LD R1, [SP+3]", 1, /odd|even/i);
  expectError("LD R1, [SP+512]", 1, /range/i);
  expectError("LDB R1, [SP+2]", 1, /SP/i);
});
test("error: overlapping .org", () => expectError(".org $100\n.word 1,2\n.org $102\n.byte 3", 4, /overlap/i));
test("error: duplicate symbol", () => expectError("a: NOP\na: NOP", 2, /already defined|duplicate/i));
test("error: missing include file reports the including line", () => expectError("NOP\n.include \"nope.asm\"", 2, /nope\.asm/));
test("error: errors inside included files report that file", () => {
  const e = errs('NOP\n.include "x.asm"', { "x.asm": "NOP\nBOGUS" });
  assert.ok(e.some((x) => x.file === "x.asm" && x.line === 2), JSON.stringify(e));
});
test("error: bad operands and syntax", () => {
  expectError("ADD R1", 1, /operand/i);
  expectError("MOV R8, R1", 1, /.+/);
  expectError(".word (1+2", 1, /\)|paren|expression/i);
  expectError(".word 1/0", 1, /division by zero/i);
  expectError(".loop: NOP", 1, /local label/i);
  expectError("R1 = 5", 1, /register|reserved/i);
  expectError("PUSHM R3-R1", 1, /range|list/i);
});
test("error: layout problems", () => {
  expectError(".byte 1\nNOP", 2, /odd address/i);
  expectError(".org $4000", 1, /bank 0|range/i);
  expectError(".bank 1\n.org $100", 2, /range|4000/i);
  expectError(".org $3FFF\n.word 1", 2, /overflow|bank|range/i);
  expectError(".fill later\nlater:", 1, /pass 1|forward|defined before/i);
  expectError(".rom 3", 1, /power of two/i);
  expectError(".bank 2\nNOP\n.rom 2", 3, /bank|small/i);
  expectError(".header\n.header", 2, /header/i);
  expectError('.header title="' + "x".repeat(25) + '"', 1, /title|24/i);
  expectError(".org $10\n.byte 1\n.header", 3, /overlap/i);
});
test("errors carry the line number and do not stop assembly", () => {
  const r = run("FROB\nNOP\nJMP nowhere\n.word 5");
  assert.deepEqual(r.errors.map((e) => e.line), [1, 3]);
  assert.ok(r.errors.every((e) => e.file === "main.asm"));
});
