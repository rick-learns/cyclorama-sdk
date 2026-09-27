// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// CYASM exhaustive rules (docs/spec-notes.md §9.45).
import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble } from "../src/asm/assembler.ts";

const run = (src: string) => assemble("main.asm", p => { if (p !== "main.asm") throw new Error(p); return src; });
const val = (expr: string) => {
  const r = run(`.org $100\nX = ${expr}\n.word X & $FFFF`);
  assert.deepEqual(r.errors, [], expr);
  return r.symbols.get("X")!;
};
const fails = (src: string, re: RegExp) => {
  const r = run(src);
  assert.ok(r.errors.length > 0, `expected an error for: ${src}`);
  assert.match(r.errors.map(e => e.message).join("\n"), re, src);
};

test("32-bit two's complement arithmetic wraps", () => {
  assert.equal(val("$7FFFFFFF + 1") | 0, -2147483648);
  assert.equal(val("$FFFFFFFF") | 0, -1);
});
test("/ truncates toward zero; % takes the dividend's sign; zero divisor is an error", () => {
  assert.equal(val("-7 / 2"), -3);
  assert.equal(val("-7 % 2"), -1);
  assert.equal(val("7 % -2"), 1);
  fails(".org $100\n.word 1 / 0", /zero/i);
  fails(".org $100\n.word 1 % 0", /zero/i);
});
test("shifts use count & 31; >> is arithmetic", () => {
  assert.equal(val("1 << 33"), 2);
  assert.equal(val("-16 >> 2"), -4);
});
test(".byte and .word ranges", () => {
  assert.deepEqual(run(".org $100\n.byte -128, 255\n.word -32768, 65535").errors, []);
  fails(".org $100\n.byte 256", /range/i);
  fails(".org $100\n.byte -129", /range/i);
  fails(".org $100\n.word 65536", /range/i);
  fails(".org $100\n.word -32769", /range/i);
});
test(".align must be a power of two 1..16384", () => {
  fails(".org $100\n.align 3", /power of two/i);
  fails(".org $100\n.align 32768", /align/i);
});
test(".org may go backwards but may not overwrite", () => {
  assert.deepEqual(run(".org $200\nNOP\n.org $100\nNOP").errors, []);
  fails(".org $100\nNOP\nNOP\n.org $102\nNOP", /overlap|already/i);
});
test("string escapes and invalid characters", () => {
  const r = run(".org $100\n" + String.raw`.ascii "a\\b\"c\'d\ne\0f\x41"`);
  assert.deepEqual(r.errors, []);
  assert.deepEqual([...r.rom.subarray(0x100, 0x10c)], [0x61, 0x5c, 0x62, 0x22, 0x63, 0x27, 0x64, 0x0a, 0x65, 0x00, 0x66, 0x41]);
  fails(".org $100\n" + String.raw`.ascii "bad\q"`, /escape/i);
  fails('.org $100\n.ascii "café"', /character|ascii/i);
});
test("duplicate symbols are errors", () => {
  fails(".org $100\nA:\nA:", /duplicate|already defined/i);
  fails(".org $100\nB = 1\nB = 2", /duplicate|already defined/i);
});
test(".rom 1 is legal when only bank 0 is used", () => {
  const r = run(".rom 1\n.org $100\nNOP");
  assert.deepEqual(r.errors, []);
  assert.equal(r.rom.length, 16384);
});

// ---- spec-notes §10 (outsider review) --------------------------------------
const words = (src: string) => {
  const r = run(`.org $100\n${src}\n__e:`);
  assert.deepEqual(r.errors, [], src);
  const end = r.symbols.get("__e")!, out: number[] = [];
  for (let a = 0x100; a < end; a += 2) out.push(r.rom[a] | (r.rom[a + 1] << 8));
  return out;
};
test("MOV #$FFFF takes the long form, MOV #-1 the quick form (§10.56)", () => {
  assert.deepEqual(words("MOV R0, #$FFFF"), [0x2000, 0xffff]);
  assert.deepEqual(words("MOV R0, #-1"), [0x30ff]);
  assert.deepEqual(words("MOV R0, #127"), [0x307f]);
  assert.deepEqual(words("MOV R0, #128"), [0x2000, 0x0080]);
  fails(".org $100\nMOV R0, #65536", /range/i);
  fails(".org $100\nMOV R0, #-32769", /range/i);
  fails(".org $100\n.fill 2, 256", /range/i);
});
test("a constant using a forward label is not known in pass 1 (§10.55)", () => {
  const r = run(".org $100\nX = Later + 1\nMOV R0, #X\nLater: NOP");
  assert.deepEqual(r.errors, []);
  assert.equal(r.rom[0x101] >> 4, 0x2); // group 2 long form
});
test("odd-address rules (§10.53)", () => {
  fails(".org $100\n.byte 1\nNOP", /odd/i);
  const r = run(".org $100\n.byte 1\n.word $1234");
  assert.deepEqual(r.errors, []);
  assert.deepEqual([...r.rom.subarray(0x101, 0x103)], [0x34, 0x12]);
});
test(".org and .bank rules (§10.54)", () => {
  fails(".org $4000\nNOP", /range|window|bank/i);
  fails(".bank 1\n.org $100\nNOP", /range|window|bank/i);
  const r = run(".org $100\nNOP\n.bank 1\nA1: NOP\n.bank 0\nB0: NOP\n.bank 1\nA2: NOP");
  assert.deepEqual(r.errors, []);
  assert.equal(r.symbols.get("A1"), 0x4000);
  assert.equal(r.symbols.get("B0"), 0x102);
  assert.equal(r.symbols.get("A2"), 0x4002);
});
test("SHLW..ROLW take 0..15; SHL #n takes 1..16 (§10.57)", () => {
  assert.equal(words("SHLW R1, #15").length, 2);
  fails(".org $100\nSHLW R1, #16", /range/i);
  fails(".org $100\nSHL R1, #0", /range/i);
  assert.equal(words("SHL R1, #16").length, 1);
});
test(".header defaults and title length (§10.58)", () => {
  const r = run('.header title="X"\n.org $100\nNOP');
  assert.deepEqual(r.errors, []);
  assert.equal(String.fromCharCode(...r.rom.subarray(0x18, 0x30)), "X" + " ".repeat(23));
  assert.deepEqual([...r.rom.subarray(0x30, 0x38)], [0, 0, 0, 0, 0, 0, 0, 0]);
  fails('.header title="ABCDEFGHIJKLMNOPQRSTUVWXY"', /24|long/i);
  fails(".rom 3\n.org $100\nNOP", /power of two/i);
});

test("only the documented escapes are accepted: backslash-r and backslash-t are errors (§9.45)", () => {
  fails(".org $100\n" + String.raw`.ascii "a\rb"`, /escape/i);
  fails(".org $100\n" + String.raw`.ascii "a\tb"`, /escape/i);
});

// ---- spec-notes §11 (M1 re-check) -------------------------------------------
test("odd word displacement is an error in every form (§11.74)", () => {
  fails(".org $100\nLD R0, [R1+3]", /odd/i);
  fails(".org $100\nLD R0, [R1+301]", /odd/i);
  fails(".org $100\nLD R0, [SP+3]", /odd/i);
});
test("emitting past the end of a bank window is an error (§11.76)", () => {
  fails(".org $3FFE\nNOP\nNOP", /bank|window|end|range/i);
  fails(".org $3FF0\n.fill 32, 0", /bank|window|end|range/i);
});
test("16-bit fields accept -32768..65535 (§11.77)", () => {
  assert.deepEqual(run(".org $100\n.word -32768, 65535\nJMP $FFFF").errors.length, 0);
  fails(".org $100\nJMP $10000", /range/i);
  fails(".org $100\nLD R0, [70000]", /range/i);
});
test("label on a .org/.align/.bank line takes the address after the directive (§11.79)", () => {
  const r = run(".org $100\nNOP\nA: .org $200\nB: .align 16\nNOP\nC: .bank 1\nNOP");
  assert.deepEqual(r.errors, []);
  assert.equal(r.symbols.get("A"), 0x200);
  assert.equal(r.symbols.get("C"), 0x4000);
});
test("register and I/O register names are case-insensitive (§11.80)", () => {
  const r = run(".org $100\nST r0, [vctrl]\nmov R1, sp");
  assert.deepEqual(r.errors, []);
});
test("numeric literals beyond 32 bits are errors (§11.81)", () => {
  fails(".org $100\n.word $100000000", /range|32/i);
});
test("titles must be printable ASCII; reserved header bytes are 0; .bank alone counts as used (§11.73)", () => {
  fails('.header title="A' + String.raw`\x80` + '"', /ascii|printable|character/i);
  const r = run('.header title="T"\n.org $100\nNOP');
  assert.deepEqual([...r.rom.subarray(0x3a, 0x40)], [0, 0, 0, 0, 0, 0]);
  const b = run(".org $100\nNOP\n.bank 5");
  assert.equal(b.rom.length, 8 * 16384);
});
