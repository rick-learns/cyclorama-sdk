// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Tally (AV-1601) CPU core (spec-notes §1, §8.9, §8.25–27): every mnemonic and addressing
// form with golden machine state, flag edge cases, cycle counts, interrupts, WAI/STOP/EI,
// TRAP, reserved encodings, alignment and serialize/deserialize.
import { test } from "node:test";
import assert from "node:assert/strict";
import { enc, decode, aluExtraCycles, ALU_OPS, UNARY_OPS, CONDITIONS, LONG_OPS, FLAG } from "../src/isa/isa.ts";
import type { Decoded } from "../src/isa/isa.ts";
import { assemble } from "../src/asm/assembler.ts";
import type { Bus } from "../src/machine/types.ts";
import { Tally } from "../src/machine/cpu.ts";

// ---------------------------------------------------------------------------
// Test bus: 64 KiB of RAM, a settable pending-interrupt mask (IE & IF) and a configurable
// extra-cycle source. It is strict: word accesses must be aligned and values in range, so
// the CPU's own masking and alignment are checked on every access. A write to E000
// acknowledges pending bits (write 1 to clear) so assembled handlers can clear their source.
const ACK = 0xe000;
class TestBus implements Bus {
  mem = new Uint8Array(0x10000);
  pending = 0;
  extra = 0;      // one-shot: returned by the next takeExtraCycles()
  extraEach = 0;  // returned by every takeExtraCycles()
  takes = 0;
  read8(a: number): number {
    if (!(a >= 0 && a <= 0xffff)) throw new Error(`read8 address out of range ${a}`);
    return this.mem[a];
  }
  read16(a: number): number {
    if (!(a >= 0 && a <= 0xfffe) || (a & 1)) throw new Error(`unaligned/out-of-range word read ${a.toString(16)}`);
    return this.mem[a] | (this.mem[a + 1] << 8);
  }
  write8(a: number, v: number): void {
    if (!(a >= 0 && a <= 0xffff)) throw new Error(`write8 address out of range ${a}`);
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new Error(`write8 value out of range ${v}`);
    if (a === ACK) { this.pending &= ~v; return; }
    this.mem[a] = v;
  }
  write16(a: number, v: number): void {
    if (!(a >= 0 && a <= 0xfffe) || (a & 1)) throw new Error(`unaligned/out-of-range word write ${a.toString(16)}`);
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new Error(`write16 value out of range ${v}`);
    if (a === ACK) { this.pending &= ~v; return; }
    this.mem[a] = v & 0xff;
    this.mem[a + 1] = v >> 8;
  }
  pendingInterrupts(): number { return this.pending; }
  takeExtraCycles(): number {
    this.takes++;
    const e = this.extra + this.extraEach;
    this.extra = 0;
    return e;
  }
  // test helpers (not part of Bus)
  w16(a: number, v: number) { this.mem[a] = v & 0xff; this.mem[(a + 1) & 0xffff] = (v >> 8) & 0xff; }
  r16(a: number) { return this.mem[a] | (this.mem[(a + 1) & 0xffff] << 8); }
}

// ---------------------------------------------------------------------------
// Opcode helpers
const U = (m: string) => { const i = UNARY_OPS.indexOf(m as (typeof UNARY_OPS)[number]); assert.ok(i >= 0, m); return i; };
const A = (m: string) => { const i = ALU_OPS.indexOf(m as (typeof ALU_OPS)[number]); assert.ok(i >= 0, m); return i; };
const L = (m: string) => { const i = LONG_OPS.indexOf(m as (typeof LONG_OPS)[number]); assert.ok(i >= 0, m); return i; };
const CC = (m: string) => { const i = CONDITIONS.indexOf(m as (typeof CONDITIONS)[number]); assert.ok(i >= 0, m); return i; };
const Z = FLAG.Z, N = FLAG.N, C = FLAG.C, V = FLAG.V, I = FLAG.I;

// Coverage: every decoded form executed by `step` below is recorded.
const seen = new Set<string>();
function formKey(d: Decoded): string {
  switch (d.kind) {
    case "unary": return `U:${d.mnemonic}`;
    case "aluR": return `R:${d.mnemonic}`;
    case "aluI": return `I:${d.mnemonic}`;
    case "quick": return d.mnemonic;
    case "mem": return `M:${d.mnemonic}`;
    case "memx": return `X:${d.mnemonic}:${d.mode}`;
    case "sprel": return `S:${d.mnemonic}`;
    case "branch": return d.mnemonic;
    case "long": return `L:${d.mnemonic}`;
    case "reserved": return "RESERVED";
  }
}
function step(cpu: Tally, bus: TestBus): number {
  if (cpu.mode === "run") seen.add(formKey(decode(bus.r16(cpu.pc & 0xfffe))));
  return cpu.step(bus);
}

const ORG = 0x0100;
type Init = {
  r?: Record<number, number>; sp?: number; f?: number;
  mem?: Record<number, number>;   // words
  bytes?: Record<number, number>;
  pending?: number; at?: number;  // code address (default ORG)
};
function setup(words: number[], init: Init = {}) {
  const bus = new TestBus();
  const at = init.at ?? ORG;
  bus.w16(0x0000, at);
  words.forEach((w, i) => bus.w16(at + 2 * i, w));
  for (const [a, v] of Object.entries(init.mem ?? {})) bus.w16(+a, v);
  for (const [a, v] of Object.entries(init.bytes ?? {})) bus.mem[+a] = v;
  const cpu = new Tally();
  cpu.reset(bus);
  for (const [i, v] of Object.entries(init.r ?? {})) cpu.r[+i] = v;
  if (init.sp !== undefined) cpu.sp = init.sp;
  if (init.f !== undefined) cpu.f = init.f;
  bus.pending = init.pending ?? 0;
  return { cpu, bus };
}
type State = { r: number[]; sp: number; pc: number; f: number; mode: string };
const state = (cpu: Tally): State => ({ r: Array.from(cpu.r), sp: cpu.sp, pc: cpu.pc, f: cpu.f, mode: cpu.mode });
type Expect = { r?: Record<number, number>; sp?: number; pc?: number; f?: number; mode?: string; cycles: number };

/** Execute one instruction and compare the complete machine state with the initial state
 *  overlaid with `exp` (pc defaults to the address after `words`). */
function one(words: number[], init: Init, exp: Expect, msg = "") {
  const { cpu, bus } = setup(words, init);
  const before = state(cpu);
  const cycles = step(cpu, bus);
  const r = before.r.slice();
  for (const [i, v] of Object.entries(exp.r ?? {})) r[+i] = v;
  const want: State = {
    r, sp: exp.sp ?? before.sp, pc: exp.pc ?? (((init.at ?? ORG) + 2 * words.length) & 0xffff),
    f: exp.f ?? before.f, mode: exp.mode ?? before.mode,
  };
  assert.deepEqual({ ...state(cpu), cycles }, { ...want, cycles: exp.cycles }, msg);
  return { cpu, bus };
}
const hex = (v: number) => "$" + v.toString(16).toUpperCase().padStart(4, "0");

// ---------------------------------------------------------------------------
// Reset
test("reset: R=0, SP=C000, F=0, PC=word at 0000, mode run; clears the EI delay", () => {
  const bus = new TestBus();
  bus.w16(0, 0x0234);
  const cpu = new Tally();
  cpu.r.fill(0x5555); cpu.sp = 0x1234; cpu.f = 0x1f; cpu.pc = 0x4444; cpu.mode = "stop";
  cpu.reset(bus);
  assert.deepEqual(state(cpu), { r: [0, 0, 0, 0, 0, 0, 0, 0], sp: 0xc000, pc: 0x0234, f: 0, mode: "run" });
  // An EI delay pending before reset does not survive it.
  const s = setup([enc.unary(U("EI")), enc.unary(U("NOP"))], { pending: 1 });
  step(s.cpu, s.bus);
  s.cpu.reset(s.bus);
  s.cpu.f = I;
  assert.equal(step(s.cpu, s.bus), 12, "interrupt taken at once after reset + I=1");
});

// ---------------------------------------------------------------------------
// Groups 1 and 2: every ALU operation in both forms, with flag edge cases
type Row = [op: string, a: number, b: number, fin: number, res: number, fout: number];
const ALU_ROWS: Row[] = [
  ["MOV", 0x1111, 0x8000, C | V, 0x8000, N | C | V],
  ["MOV", 0x1111, 0x0000, I, 0x0000, I | Z],
  ["ADD", 0x7fff, 0x0001, 0, 0x8000, N | V],
  ["ADD", 0xffff, 0x0001, 0, 0x0000, Z | C],
  ["ADD", 0x8000, 0x8000, 0, 0x0000, Z | C | V],
  ["ADD", 0x1234, 0x1111, I | Z | N | C | V, 0x2345, I],
  ["ADD", 0x8000, 0xffff, 0, 0x7fff, C | V],
  ["ADC", 0x7fff, 0x0000, C, 0x8000, N | V],
  ["ADC", 0xffff, 0x0000, C, 0x0000, Z | C],
  ["ADC", 0xffff, 0xffff, C, 0xffff, N | C],
  ["ADC", 0x7fff, 0x8000, C, 0x0000, Z | C],
  ["ADC", 0x0001, 0x0002, 0, 0x0003, 0],
  ["SUB", 0x0005, 0x0003, 0, 0x0002, 0],
  ["SUB", 0x0003, 0x0005, 0, 0xfffe, N | C],
  ["SUB", 0x0005, 0x0005, 0, 0x0000, Z],
  ["SUB", 0x8000, 0x0001, 0, 0x7fff, V],
  ["SUB", 0x7fff, 0xffff, 0, 0x8000, N | C | V],
  ["SUB", 0x0000, 0x0000, C, 0x0000, Z],
  ["SBC", 0x0005, 0x0003, C, 0x0001, 0],
  ["SBC", 0x0005, 0x0003, 0, 0x0002, 0],
  ["SBC", 0x0003, 0x0003, C, 0xffff, N | C],
  ["SBC", 0x0000, 0xffff, C, 0x0000, Z | C],
  ["SBC", 0x8000, 0x0000, C, 0x7fff, V],
  ["CMP", 0x0003, 0x0005, 0, 0x0003, N | C],
  ["CMP", 0x0005, 0x0003, C, 0x0005, 0],
  ["CMP", 0x0005, 0x0005, 0, 0x0005, Z],
  ["CMP", 0x8000, 0x0001, 0, 0x8000, V],
  ["CMP", 0x7fff, 0xffff, I, 0x7fff, I | N | C | V],
  ["AND", 0xf0f0, 0x0ff0, C | V, 0x00f0, 0],
  ["AND", 0x00ff, 0xff00, 0, 0x0000, Z],
  ["AND", 0x8001, 0x8000, 0, 0x8000, N],
  ["OR", 0x8000, 0x0001, C | V, 0x8001, N],
  ["OR", 0x0000, 0x0000, 0, 0x0000, Z],
  ["XOR", 0xffff, 0xffff, C | V, 0x0000, Z],
  ["XOR", 0x00ff, 0xffff, 0, 0xff00, N],
  ["TST", 0x8000, 0x8001, C | V, 0x8000, N],
  ["TST", 0x00ff, 0xff00, 0, 0x00ff, Z],
  // shifts: count = src & 15; count 0 leaves the value, C unchanged, V = 0
  ["SHL", 0x8001, 0x0000, C | V, 0x8001, N | C],
  ["SHL", 0x8001, 0x0001, 0, 0x0002, C],
  ["SHL", 0x0003, 0x000f, 0, 0x8000, N | C],
  ["SHL", 0x0001, 0xffff, 0, 0x8000, N],
  ["SHL", 0x8001, 0x0010, C | V, 0x8001, N | C],
  ["SHL", 0x4001, 0x0011, V, 0x8002, N],
  ["SHR", 0x8001, 0x0001, 0, 0x4000, C],
  ["SHR", 0x8000, 0x000f, C, 0x0001, 0],
  ["SHR", 0x0001, 0x0001, 0, 0x0000, Z | C],
  ["SHR", 0x1234, 0x0000, C | V, 0x1234, C],
  ["SHR", 0x8000, 0x0010, V, 0x8000, N],
  ["ASR", 0x8000, 0x0001, 0, 0xc000, N],
  ["ASR", 0xc000, 0x000f, 0, 0xffff, N | C],
  ["ASR", 0x4001, 0x0001, 0, 0x2000, C],
  ["ASR", 0x8000, 0x0010, V, 0x8000, N],
  ["ROL", 0x8001, 0x0001, 0, 0x0003, C],
  ["ROL", 0x8000, 0x0004, C, 0x0008, 0],
  ["ROL", 0x0002, 0x000f, 0, 0x0001, C],
  ["ROL", 0x1234, 0x000f, 0, 0x091a, 0],
  ["ROL", 0x0000, 0x0003, C | V, 0x0000, Z],
  ["ROL", 0x1234, 0x0010, C | V, 0x1234, C],
  // MUL: C = product > FFFF, V = 0
  ["MUL", 0x0100, 0x0100, V, 0x0000, Z | C],
  ["MUL", 0x00ff, 0x0101, 0, 0xffff, N],
  ["MUL", 0xffff, 0xffff, 0, 0x0001, C],
  ["MUL", 0x0003, 0x0004, C | V, 0x000c, 0],
  // FMUL: signed 8.8, C = 0, V = shifted product outside signed 16 bits
  ["FMUL", 0x0180, 0x0200, C, 0x0300, 0],
  ["FMUL", 0xff80, 0x0200, 0, 0xff00, N],
  ["FMUL", 0xff80, 0xff80, 0, 0x0040, 0],
  ["FMUL", 0xffff, 0x0080, C, 0xffff, N],
  ["FMUL", 0x7fff, 0x7fff, 0, 0xff00, N | V],
  ["FMUL", 0x8000, 0x8000, 0, 0x0000, Z | V],
  ["FMUL", 0x8000, 0x0100, 0, 0x8000, N],
  ["FMUL", 0x8000, 0xff00, 0, 0x8000, N | V],
  ["FMUL", 0x0100, 0x0100, V, 0x0100, 0],
];

test("ALU register form (group 1): every operation, golden result, flags and cycles", () => {
  for (const [m, a, b, fin, res, fout] of ALU_ROWS) {
    const op = A(m);
    one([enc.aluR(op, 1, 2)], { r: { 1: a, 2: b }, f: fin },
      { r: { 1: res }, f: fout, cycles: 2 + aluExtraCycles(op, b & 15) },
      `${m} R1,R2 with ${hex(a)},${hex(b)} F=${fin}`);
  }
});

test("ALU immediate form (group 2): every operation, golden result, flags and cycles", () => {
  for (const [m, a, b, fin, res, fout] of ALU_ROWS) {
    const op = A(m);
    one([enc.aluI(op, 3), b], { r: { 3: a }, f: fin },
      { r: { 3: res }, f: fout, cycles: 4 + aluExtraCycles(op, b & 15) },
      `${m} R3,#${hex(b)} with ${hex(a)} F=${fin}`);
  }
});

test("ALU cycle counts written out: shifts per bit, MUL/FMUL +8", () => {
  one([enc.aluR(A("SHL"), 1, 2)], { r: { 1: 1, 2: 15 } }, { r: { 1: 0x8000 }, f: N, cycles: 17 });
  one([enc.aluI(A("SHL"), 1), 15], { r: { 1: 1 } }, { r: { 1: 0x8000 }, f: N, cycles: 19 });
  one([enc.aluR(A("ROL"), 1, 2)], { r: { 1: 1, 2: 16 } }, { f: 0, cycles: 2 });
  one([enc.aluI(A("ASR"), 1), 16], { r: { 1: 1 } }, { f: 0, cycles: 4 });
  one([enc.aluR(A("MUL"), 1, 2)], { r: { 1: 2, 2: 3 } }, { r: { 1: 6 }, cycles: 10 });
  one([enc.aluI(A("MUL"), 1), 3], { r: { 1: 2 } }, { r: { 1: 6 }, cycles: 12 });
  one([enc.aluR(A("FMUL"), 1, 2)], { r: { 1: 0x200, 2: 0x300 } }, { r: { 1: 0x600 }, cycles: 10 });
  one([enc.aluI(A("FMUL"), 1), 0x300], { r: { 1: 0x200 } }, { r: { 1: 0x600 }, cycles: 12 });
});

test("ALU with Rd = Rs and must-be-zero bits ignored", () => {
  one([enc.aluR(A("ADD"), 4, 4)], { r: { 4: 0x8000 } }, { r: { 4: 0 }, f: Z | C | V, cycles: 2 });
  one([enc.aluR(A("SUB"), 4, 4)], { r: { 4: 0x1234 } }, { r: { 4: 0 }, f: Z, cycles: 2 });
  one([enc.aluR(A("MUL"), 5, 5)], { r: { 5: 0x0100 } }, { r: { 5: 0 }, f: Z | C, cycles: 10 });
  // group 1 bits 1-0, group 2 source field and bits 1-0 set: ignored
  one([enc.aluR(A("ADD"), 1, 2) | 3], { r: { 1: 1, 2: 2 } }, { r: { 1: 3 }, f: 0, cycles: 2 });
  one([enc.aluI(A("ADD"), 1) | 0x1f, 5], { r: { 1: 1, 7: 100 } }, { r: { 1: 6 }, f: 0, cycles: 4 });
});

// ---------------------------------------------------------------------------
// Group 3
test("MOVQ: sign-extended, Z/N from result, C/V preserved", () => {
  one([enc.quick(false, 3, 0xff)], { f: C | V }, { r: { 3: 0xffff }, f: N | C | V, cycles: 2 });
  one([enc.quick(false, 3, 0x7f)], { r: { 3: 0x5555 }, f: Z }, { r: { 3: 0x007f }, f: 0, cycles: 2 });
  one([enc.quick(false, 3, 0x00)], { r: { 3: 0x5555 }, f: I }, { r: { 3: 0 }, f: I | Z, cycles: 2 });
  one([enc.quick(false, 7, 0x80)], {}, { r: { 7: 0xff80 }, f: N, cycles: 2 });
});

test("ADDQ: sign-extended immediate, flags as ADD", () => {
  one([enc.quick(true, 3, 0xff)], { r: { 3: 0 } }, { r: { 3: 0xffff }, f: N, cycles: 2 });
  one([enc.quick(true, 3, 0xff)], { r: { 3: 1 } }, { r: { 3: 0 }, f: Z | C, cycles: 2 });
  one([enc.quick(true, 3, 0x01)], { r: { 3: 0x7fff } }, { r: { 3: 0x8000 }, f: N | V, cycles: 2 });
  one([enc.quick(true, 3, 0x80)], { r: { 3: 0x8000 } }, { r: { 3: 0x7f80 }, f: C | V, cycles: 2 });
});

// ---------------------------------------------------------------------------
// Group 0
test("NOP and NOP with must-be-zero bits set", () => {
  one([enc.unary(U("NOP"))], { f: 0x1f }, { cycles: 2 });
  one([enc.unary(U("NOP"), 7, 15)], { r: { 7: 9 } }, { cycles: 2 });
});

test("NOT: complement, C and V cleared", () => {
  one([enc.unary(U("NOT"), 2)], { r: { 2: 0x00ff }, f: C | V | I }, { r: { 2: 0xff00 }, f: N | I, cycles: 2 });
  one([enc.unary(U("NOT"), 2)], { r: { 2: 0xffff } }, { r: { 2: 0 }, f: Z, cycles: 2 });
});

test("NEG: 0 − Rd, edge cases 0 and 8000", () => {
  one([enc.unary(U("NEG"), 2)], { r: { 2: 0 }, f: C | V }, { r: { 2: 0 }, f: Z, cycles: 2 });
  one([enc.unary(U("NEG"), 2)], { r: { 2: 0x8000 } }, { r: { 2: 0x8000 }, f: N | C | V, cycles: 2 });
  one([enc.unary(U("NEG"), 2)], { r: { 2: 1 } }, { r: { 2: 0xffff }, f: N | C, cycles: 2 });
  one([enc.unary(U("NEG"), 2)], { r: { 2: 0xffff } }, { r: { 2: 1 }, f: C, cycles: 2 });
});

test("INC / DEC: flags as ADD #1 / SUB #1", () => {
  one([enc.unary(U("INC"), 6)], { r: { 6: 0xffff } }, { r: { 6: 0 }, f: Z | C, cycles: 2 });
  one([enc.unary(U("INC"), 6)], { r: { 6: 0x7fff } }, { r: { 6: 0x8000 }, f: N | V, cycles: 2 });
  one([enc.unary(U("INC"), 6)], { r: { 6: 1 }, f: C | V | Z }, { r: { 6: 2 }, f: 0, cycles: 2 });
  one([enc.unary(U("DEC"), 6)], { r: { 6: 0 } }, { r: { 6: 0xffff }, f: N | C, cycles: 2 });
  one([enc.unary(U("DEC"), 6)], { r: { 6: 0x8000 } }, { r: { 6: 0x7fff }, f: V, cycles: 2 });
  one([enc.unary(U("DEC"), 6)], { r: { 6: 1 } }, { r: { 6: 0 }, f: Z, cycles: 2 });
});

test("SXB / ZXB / SWPB: Z,N from result, C,V preserved", () => {
  one([enc.unary(U("SXB"), 1)], { r: { 1: 0x1280 }, f: C | V }, { r: { 1: 0xff80 }, f: N | C | V, cycles: 2 });
  one([enc.unary(U("SXB"), 1)], { r: { 1: 0xff7f }, f: C }, { r: { 1: 0x007f }, f: C, cycles: 2 });
  one([enc.unary(U("SXB"), 1)], { r: { 1: 0xff00 } }, { r: { 1: 0 }, f: Z, cycles: 2 });
  one([enc.unary(U("ZXB"), 1)], { r: { 1: 0xff80 }, f: C | V | N }, { r: { 1: 0x0080 }, f: C | V, cycles: 2 });
  one([enc.unary(U("ZXB"), 1)], { r: { 1: 0x1200 } }, { r: { 1: 0 }, f: Z, cycles: 2 });
  one([enc.unary(U("SWPB"), 1)], { r: { 1: 0x12ab }, f: V }, { r: { 1: 0xab12 }, f: N | V, cycles: 2 });
  one([enc.unary(U("SWPB"), 1)], { r: { 1: 0 } }, { r: { 1: 0 }, f: Z, cycles: 2 });
});

test("group 0 shifts SHLI/SHRI/ASRI/ROLI: n = imm4 + 1, cycles 2 + n, V = 0", () => {
  const sh = (m: string, n: number) => enc.unary(U(m), 1, n - 1);
  one([sh("SHLI", 1)], { r: { 1: 0x8001 }, f: V }, { r: { 1: 0x0002 }, f: C, cycles: 3 });
  one([sh("SHLI", 16)], { r: { 1: 0x8001 } }, { r: { 1: 0 }, f: Z | C, cycles: 18 });
  one([sh("SHLI", 16)], { r: { 1: 0x8000 }, f: C }, { r: { 1: 0 }, f: Z, cycles: 18 });
  one([sh("SHLI", 4)], { r: { 1: 0x1234 } }, { r: { 1: 0x2340 }, f: C, cycles: 6 });
  one([sh("SHRI", 8)], { r: { 1: 0xab80 } }, { r: { 1: 0x00ab }, f: C, cycles: 10 });
  one([sh("SHRI", 16)], { r: { 1: 0x8000 } }, { r: { 1: 0 }, f: Z | C, cycles: 18 });
  one([sh("SHRI", 1)], { r: { 1: 0x8000 }, f: C | V }, { r: { 1: 0x4000 }, f: 0, cycles: 3 });
  one([sh("ASRI", 16)], { r: { 1: 0x8000 } }, { r: { 1: 0xffff }, f: N | C, cycles: 18 });
  one([sh("ASRI", 16)], { r: { 1: 0x7fff } }, { r: { 1: 0 }, f: Z, cycles: 18 });
  one([sh("ASRI", 4)], { r: { 1: 0x8018 } }, { r: { 1: 0xf801 }, f: N | C, cycles: 6 });
  one([sh("ROLI", 16)], { r: { 1: 0x1235 }, f: V }, { r: { 1: 0x1235 }, f: C, cycles: 18 });
  one([sh("ROLI", 4)], { r: { 1: 0x1234 } }, { r: { 1: 0x2341 }, f: C, cycles: 6 });
  one([sh("ROLI", 1)], { r: { 1: 0x8000 } }, { r: { 1: 0x0001 }, f: C, cycles: 3 });
  one([sh("ROLI", 1)], { r: { 1: 0x4000 }, f: C }, { r: { 1: 0x8000 }, f: N, cycles: 3 });
});

test("JMPR / CALLR: PC bit 0 cleared, CALLR pushes the next address", () => {
  one([enc.unary(U("JMPR"), 2)], { r: { 2: 0x0300 } }, { pc: 0x0300, cycles: 4 });
  one([enc.unary(U("JMPR"), 2)], { r: { 2: 0x0301 } }, { pc: 0x0300, cycles: 4 });
  const { bus } = one([enc.unary(U("CALLR"), 2)], { r: { 2: 0x0401 }, f: 0x1f }, { pc: 0x0400, sp: 0xbffe, cycles: 6 });
  assert.equal(bus.r16(0xbffe), 0x0102);
});

test("PUSH / POP / MOVFS / MOVTS", () => {
  const p = one([enc.unary(U("PUSH"), 3)], { r: { 3: 0xbeef } }, { sp: 0xbffe, cycles: 4 });
  assert.equal(p.bus.r16(0xbffe), 0xbeef);
  one([enc.unary(U("POP"), 4)], { sp: 0x8100, mem: { 0x8100: 0xcafe }, f: Z }, { r: { 4: 0xcafe }, sp: 0x8102, cycles: 4 });
  // push/pop wrap at 16 bits
  const w = one([enc.unary(U("PUSH"), 3)], { r: { 3: 0x1234 }, sp: 0x0000 }, { sp: 0xfffe, cycles: 4 });
  assert.equal(w.bus.r16(0xfffe), 0x1234);
  one([enc.unary(U("POP"), 3)], { sp: 0xfffe, mem: { 0xfffe: 0x4321 } }, { r: { 3: 0x4321 }, sp: 0x0000, cycles: 4 });
  one([enc.unary(U("MOVFS"), 5)], { f: N }, { r: { 5: 0xc000 }, cycles: 2 });
  one([enc.unary(U("MOVTS"), 5)], { r: { 5: 0x8123 }, f: Z }, { sp: 0x8122, cycles: 2 });
});

test("GETF / SETF: whole F, bits 15-5 read 0", () => {
  one([enc.unary(U("GETF"), 0)], { f: 0x1f, r: { 0: 0xffff } }, { r: { 0: 0x001f }, cycles: 2 });
  one([enc.unary(U("GETF"), 0)], { f: C | I }, { r: { 0: C | I }, cycles: 2 });
  one([enc.unary(U("SETF"), 0)], { r: { 0: 0xffea } }, { f: 0x0a, cycles: 2 });
  one([enc.unary(U("SETF"), 0)], { r: { 0: 0x0000 }, f: 0x1f }, { f: 0, cycles: 2 });
});

test("EI / DI set and clear I; other flags untouched", () => {
  one([enc.unary(U("EI"))], { f: Z | C }, { f: Z | C | I, cycles: 2 });
  one([enc.unary(U("DI"))], { f: 0x1f }, { f: 0x0f, cycles: 2 });
});

test("RTS pops PC; RTI pops F (masked to 5 bits) then PC", () => {
  one([enc.unary(U("RTS"))], { sp: 0xbffe, mem: { 0xbffe: 0x0200 }, f: N }, { pc: 0x0200, sp: 0xc000, cycles: 6 });
  one([enc.unary(U("RTI"))], { sp: 0xbffc, mem: { 0xbffc: 0xffea, 0xbffe: 0x0300 }, f: I }, { f: 0x0a, pc: 0x0300, sp: 0xc000, cycles: 8 });
  one([enc.unary(U("RTI"))], { sp: 0xbffc, mem: { 0xbffc: 0x0014, 0xbffe: 0x0302 } }, { f: C | I, pc: 0x0302, sp: 0xc000, cycles: 8 });
});

test("STOP: mode stop, 2 cycles; afterwards step returns 1 and nothing happens, interrupts do not wake", () => {
  const { cpu, bus } = one([enc.unary(U("STOP")), enc.unary(U("INC"), 1)], { f: I }, { mode: "stop", pc: 0x0102, cycles: 2 });
  bus.pending = 7;
  for (let i = 0; i < 5; i++) assert.equal(step(cpu, bus), 1);
  assert.deepEqual(state(cpu), { r: [0, 0, 0, 0, 0, 0, 0, 0], sp: 0xc000, pc: 0x0102, f: I, mode: "stop" });
  cpu.reset(bus);
  assert.equal(cpu.mode, "run");
});

test("TRAP: push next PC, push F, I = 0, PC = word at 0008, 10 cycles, taken whatever I is", () => {
  const t = one([enc.unary(U("TRAP"), 0, 5)], { f: I | C, mem: { 0x0008: 0x0500 } }, { pc: 0x0500, sp: 0xbffc, f: C, cycles: 10 });
  assert.equal(t.bus.r16(0xbffe), 0x0102);
  assert.equal(t.bus.r16(0xbffc), I | C);
  const u = one([enc.unary(U("TRAP"), 0, 15)], { f: Z, mem: { 0x0008: 0x0600 } }, { pc: 0x0600, sp: 0xbffc, f: Z, cycles: 10 });
  assert.equal(u.bus.r16(0xbffc), Z);
  // RTI after TRAP returns to the next instruction with the old F
  const { cpu, bus } = setup([enc.unary(U("TRAP"), 0, 3), enc.unary(U("INC"), 1)], { f: I, mem: { 0x0008: 0x0200, 0x0200: enc.unary(U("RTI")) } });
  assert.equal(step(cpu, bus), 10);
  assert.equal(step(cpu, bus), 8);
  assert.deepEqual([cpu.pc, cpu.sp, cpu.f], [0x0102, 0xc000, I]);
});

// ---------------------------------------------------------------------------
// Groups 4-7: short loads/stores
test("LD/ST/LDB/STB short forms [Rs+d]: addresses, zero-extension, one-byte stores, no flags", () => {
  one([enc.mem(false, false, 1, 2, 3)], { r: { 2: 0x8000 }, mem: { 0x8006: 0x1234 }, f: Z }, { r: { 1: 0x1234 }, cycles: 4 });
  one([enc.mem(false, false, 1, 2, 0)], { r: { 1: 0x5555, 2: 0x8000 }, f: N }, { r: { 1: 0 }, cycles: 4 }, "LD of 0 keeps flags");
  const st = one([enc.mem(false, true, 1, 2, 63)], { r: { 1: 0xabcd, 2: 0x8000 } }, { cycles: 4 });
  assert.equal(st.bus.r16(0x807e), 0xabcd);
  one([enc.mem(true, false, 1, 2, 63)], { r: { 1: 0xffff, 2: 0x8000 }, bytes: { 0x803f: 0xab, 0x8040: 0x77 } }, { r: { 1: 0x00ab }, cycles: 4 });
  const sb = one([enc.mem(true, true, 1, 2, 1)], { r: { 1: 0x1234, 2: 0x8000 }, bytes: { 0x8000: 0x99, 0x8002: 0x88 } }, { cycles: 4 });
  assert.deepEqual([sb.bus.mem[0x8000], sb.bus.mem[0x8001], sb.bus.mem[0x8002]], [0x99, 0x34, 0x88]);
  // address wraps at 16 bits
  one([enc.mem(false, false, 1, 2, 2)], { r: { 2: 0xfffe }, mem: { 0x0002: 0x4242 } }, { r: { 1: 0x4242 }, cycles: 4 });
});

test("word accesses at odd addresses use the even address below (load, store, stack, JMPT table)", () => {
  one([enc.mem(false, false, 1, 2, 0)], { r: { 2: 0x8001 }, mem: { 0x8000: 0x1234 } }, { r: { 1: 0x1234 }, cycles: 4 });
  const s = one([enc.mem(false, true, 1, 2, 2)], { r: { 1: 0xbeef, 2: 0x8001 } }, { cycles: 4 });
  assert.equal(s.bus.r16(0x8004), 0xbeef, "0x8001 + 4 = 0x8005 → word at 0x8004");
  // byte accesses at odd addresses are exact
  one([enc.mem(true, false, 1, 2, 0)], { r: { 2: 0x8001 }, bytes: { 0x8000: 0x11, 0x8001: 0x22 } }, { r: { 1: 0x22 }, cycles: 4 });
  // JMPT with an odd table address
  one([enc.long(L("JMPT"), 1 << 5), 0x0301], { r: { 1: 1 }, mem: { 0x0302: 0x0444 } }, { pc: 0x0444, cycles: 8 });
});

test("instruction fetch ignores PC bit 0", () => {
  const { cpu, bus } = setup([enc.quick(false, 1, 7), enc.quick(false, 2, 8)]);
  cpu.pc = 0x0101;
  assert.equal(step(cpu, bus), 2);
  assert.deepEqual([cpu.r[1], cpu.pc], [7, 0x0102]);
  // extension words are fetched aligned too
  const s = setup([enc.aluI(A("MOV"), 3), 0x5a5a]);
  s.cpu.pc = 0x0101;
  assert.equal(step(s.cpu, s.bus), 4);
  assert.deepEqual([s.cpu.r[3], s.cpu.pc], [0x5a5a, 0x0104]);
});

// ---------------------------------------------------------------------------
// Group 8
test("group 8 mode 00 [Rs+d16] with 16-bit wraparound, all four access kinds", () => {
  one([enc.memx(1, 2, false, false, 0), 0x8010], { r: { 2: 0xfff0 }, mem: { 0x8000: 0x1234 } }, { r: { 1: 0x1234 }, cycles: 6 });
  const st = one([enc.memx(1, 2, false, true, 0), 0x0200], { r: { 1: 0x7777, 2: 0x8000 } }, { cycles: 6 });
  assert.equal(st.bus.r16(0x8200), 0x7777);
  one([enc.memx(1, 2, true, false, 0), 0xffff], { r: { 1: 0xffff, 2: 0x8001 }, bytes: { 0x8000: 0xfe } }, { r: { 1: 0x00fe }, cycles: 6 });
  const sb = one([enc.memx(1, 2, true, true, 0), 0x0003], { r: { 1: 0xa5c3, 2: 0x8000 } }, { cycles: 6 });
  assert.deepEqual([sb.bus.mem[0x8002], sb.bus.mem[0x8003], sb.bus.mem[0x8004]], [0, 0xc3, 0]);
});

test("group 8 mode 01 [abs16]: Rs field ignored", () => {
  one([enc.memx(1, 3, false, false, 1), 0x9000], { r: { 3: 0x1111 }, mem: { 0x9000: 0x2468 } }, { r: { 1: 0x2468 }, cycles: 6 });
  one([enc.memx(1, 3, false, false, 1), 0x9001], { mem: { 0x9000: 0x2469 } }, { r: { 1: 0x2469 }, cycles: 6 });
  const st = one([enc.memx(4, 3, false, true, 1), 0x9002], { r: { 3: 0x1111, 4: 0x1357 } }, { cycles: 6 });
  assert.equal(st.bus.r16(0x9002), 0x1357);
  one([enc.memx(1, 0, true, false, 1), 0x9003], { bytes: { 0x9003: 0x80 } }, { r: { 1: 0x0080 }, cycles: 6 });
  const sb = one([enc.memx(4, 0, true, true, 1), 0x9005], { r: { 4: 0xff42 } }, { cycles: 6 });
  assert.deepEqual([sb.bus.mem[0x9004], sb.bus.mem[0x9005], sb.bus.mem[0x9006]], [0, 0x42, 0]);
});

test("group 8 mode 10 [Rs]+ post-increment (word +2, byte +1)", () => {
  one([enc.memx(1, 2, false, false, 2)], { r: { 2: 0x8000 }, mem: { 0x8000: 0x1234 } }, { r: { 1: 0x1234, 2: 0x8002 }, cycles: 4 });
  one([enc.memx(1, 2, true, false, 2)], { r: { 2: 0x8001 }, bytes: { 0x8001: 0x56 } }, { r: { 1: 0x56, 2: 0x8002 }, cycles: 4 });
  const st = one([enc.memx(1, 2, false, true, 2)], { r: { 1: 0x4444, 2: 0x8000 } }, { r: { 2: 0x8002 }, cycles: 4 });
  assert.equal(st.bus.r16(0x8000), 0x4444);
  const sb = one([enc.memx(1, 2, true, true, 2)], { r: { 1: 0x4455, 2: 0x8000 } }, { r: { 2: 0x8001 }, cycles: 4 });
  assert.deepEqual([sb.bus.mem[0x8000], sb.bus.mem[0x8001]], [0x55, 0]);
  // wraparound and odd base for word access (access aligned, Rs still += 2)
  one([enc.memx(1, 2, false, false, 2)], { r: { 2: 0xfffe }, mem: { 0xfffe: 0x9999 } }, { r: { 1: 0x9999, 2: 0x0000 }, cycles: 4 });
  one([enc.memx(1, 2, false, false, 2)], { r: { 2: 0x8001 }, mem: { 0x8000: 0x3333 } }, { r: { 1: 0x3333, 2: 0x8003 }, cycles: 4 });
});

test("group 8 mode 11 -[Rs] pre-decrement (word −2, byte −1)", () => {
  one([enc.memx(1, 2, false, false, 3)], { r: { 2: 0x8002 }, mem: { 0x8000: 0x1234 } }, { r: { 1: 0x1234, 2: 0x8000 }, cycles: 4 });
  one([enc.memx(1, 2, true, false, 3)], { r: { 2: 0x8002 }, bytes: { 0x8001: 0x56 } }, { r: { 1: 0x56, 2: 0x8001 }, cycles: 4 });
  const st = one([enc.memx(1, 2, false, true, 3)], { r: { 1: 0x4444, 2: 0x8002 } }, { r: { 2: 0x8000 }, cycles: 4 });
  assert.equal(st.bus.r16(0x8000), 0x4444);
  const sb = one([enc.memx(1, 2, true, true, 3)], { r: { 1: 0x4455, 2: 0x8002 } }, { r: { 2: 0x8001 }, cycles: 4 });
  assert.deepEqual([sb.bus.mem[0x8000], sb.bus.mem[0x8001], sb.bus.mem[0x8002]], [0, 0x55, 0]);
  one([enc.memx(1, 2, false, false, 3)], { r: { 2: 0x0000 }, mem: { 0xfffe: 0x7777 } }, { r: { 1: 0x7777, 2: 0xfffe }, cycles: 4 });
});

test("post-increment / pre-decrement with d = s", () => {
  // loads: the loaded value is what remains
  one([enc.memx(2, 2, false, false, 2)], { r: { 2: 0x8000 }, mem: { 0x8000: 0x1234 } }, { r: { 2: 0x1234 }, cycles: 4 });
  one([enc.memx(2, 2, false, false, 3)], { r: { 2: 0x8002 }, mem: { 0x8000: 0x5678 } }, { r: { 2: 0x5678 }, cycles: 4 });
  one([enc.memx(2, 2, true, false, 2)], { r: { 2: 0x8010 }, bytes: { 0x8010: 0xcd } }, { r: { 2: 0x00cd }, cycles: 4 });
  one([enc.memx(2, 2, true, false, 3)], { r: { 2: 0x8011 }, bytes: { 0x8010: 0xef } }, { r: { 2: 0x00ef }, cycles: 4 });
  // stores: the value before the increment/decrement is stored
  const a = one([enc.memx(2, 2, false, true, 2)], { r: { 2: 0x8000 } }, { r: { 2: 0x8002 }, cycles: 4 });
  assert.equal(a.bus.r16(0x8000), 0x8000);
  const b = one([enc.memx(2, 2, false, true, 3)], { r: { 2: 0x8002 } }, { r: { 2: 0x8000 }, cycles: 4 });
  assert.equal(b.bus.r16(0x8000), 0x8002);
  const c = one([enc.memx(2, 2, true, true, 2)], { r: { 2: 0x8010 } }, { r: { 2: 0x8011 }, cycles: 4 });
  assert.equal(c.bus.mem[0x8010], 0x10);
  const d = one([enc.memx(2, 2, true, true, 3)], { r: { 2: 0x8011 } }, { r: { 2: 0x8010 }, cycles: 4 });
  assert.equal(d.bus.mem[0x8010], 0x11);
});

// ---------------------------------------------------------------------------
// Group 9
test("SP-relative LD/ST [SP+d], d = 0..510, wraps at 16 bits", () => {
  one([enc.sprel(1, false, 255)], { sp: 0x8000, mem: { 0x81fe: 0xaaaa }, f: Z }, { r: { 1: 0xaaaa }, cycles: 4 });
  one([enc.sprel(1, false, 0)], { sp: 0x8000, mem: { 0x8000: 0xbbbb } }, { r: { 1: 0xbbbb }, cycles: 4 });
  const st = one([enc.sprel(6, true, 2)], { sp: 0x8000, r: { 6: 0xcccc } }, { cycles: 4 });
  assert.equal(st.bus.r16(0x8004), 0xcccc);
  one([enc.sprel(1, false, 255)], { sp: 0xff00, mem: { 0x00fe: 0xdddd } }, { r: { 1: 0xdddd }, cycles: 4 });
});

// ---------------------------------------------------------------------------
// Group A
const condHolds = (c: string, f: number): boolean => {
  const z = !!(f & Z), n = !!(f & N), cy = !!(f & C), v = !!(f & V);
  switch (c) {
    case "RA": case "SR": return true;
    case "EQ": return z; case "NE": return !z;
    case "LO": return cy; case "HS": return !cy;
    case "MI": return n; case "PL": return !n;
    case "VS": return v; case "VC": return !v;
    case "HI": return !cy && !z; case "LS": return cy || z;
    case "LT": return n !== v; case "GE": return n === v;
    case "GT": return !z && n === v; case "LE": return z || n !== v;
  }
  throw new Error(c);
};

test("all 15 branch conditions over all 16 Z/N/C/V combinations: taken 4 cycles, not taken 2", () => {
  for (const c of CONDITIONS.slice(0, 15)) {
    const outcomes = new Set<boolean>();
    for (let f = 0; f < 16; f++) {
      const taken = condHolds(c, f);
      outcomes.add(taken);
      one([enc.branch(CC(c), 5)], { f: f | I }, taken ? { pc: 0x010c, cycles: 4 } : { pc: 0x0102, cycles: 2 }, `B${c} F=${f}`);
    }
    assert.equal(outcomes.size, c === "RA" ? 1 : 2, `B${c} both outcomes exercised`);
  }
});

test("branch displacement: backwards −128, forwards +127, wrap", () => {
  one([enc.branch(CC("RA"), 0x80)], { at: 0x0200 }, { pc: 0x0102, cycles: 4 });
  one([enc.branch(CC("RA"), 0x7f)], { at: 0x0200 }, { pc: 0x0300, cycles: 4 });
  one([enc.branch(CC("RA"), 0xff)], {}, { pc: 0x0100, cycles: 4 });
  one([enc.branch(CC("EQ"), 0x80)], { at: 0x0010, f: Z }, { pc: 0xff12, cycles: 4 });
});

test("BSR: push next, branch, 6 cycles, flags kept", () => {
  const b = one([enc.branch(CC("SR"), 0x10)], { f: 0x1f }, { pc: 0x0122, sp: 0xbffe, cycles: 6 });
  assert.equal(b.bus.r16(0xbffe), 0x0102);
  const c = one([enc.branch(CC("SR"), 0xfe)], { at: 0x0200 }, { pc: 0x01fe, sp: 0xbffe, cycles: 6 });
  assert.equal(c.bus.r16(0xbffe), 0x0202);
});

// ---------------------------------------------------------------------------
// Group B
test("JMP abs16: 6 cycles", () => {
  one([enc.long(L("JMP")), 0x1234], { f: 0x1f }, { pc: 0x1234, cycles: 6 });
  one([enc.long(L("JMP"), 0xff), 0x1234], {}, { pc: 0x1234, cycles: 6 }, "ignored low byte");
});

test("CALL abs16: pushes the address after the extension word, 8 cycles", () => {
  const c = one([enc.long(L("CALL")), 0x0400], {}, { pc: 0x0400, sp: 0xbffe, cycles: 8 });
  assert.equal(c.bus.r16(0xbffe), 0x0104);
});

test("CALL / RTS round trip and BSR / RTS stack layout", () => {
  const { cpu, bus } = setup([enc.long(L("CALL")), 0x0200, enc.branch(CC("SR"), 0x7f)], {
    mem: { 0x0200: enc.unary(U("RTS")) },
  });
  assert.equal(step(cpu, bus), 8);
  assert.deepEqual([cpu.pc, cpu.sp, bus.r16(0xbffe)], [0x0200, 0xbffe, 0x0104]);
  assert.equal(step(cpu, bus), 6);
  assert.deepEqual([cpu.pc, cpu.sp], [0x0104, 0xc000]);
  assert.equal(step(cpu, bus), 6);  // BSR +127 → 0x0106 + 254 = 0x0204
  assert.deepEqual([cpu.pc, cpu.sp, bus.r16(0xbffe)], [0x0204, 0xbffe, 0x0106]);
});

test("PUSHM pushes R7 down to R0 (R0 lowest); POPM pops R0 up; 2 + 2 per register", () => {
  const r = { 0: 0x1000, 1: 0x1001, 2: 0x1002, 3: 0x1003, 4: 0x1004, 5: 0x1005, 6: 0x1006, 7: 0x1007 };
  const p = one([enc.long(L("PUSHM"), 0b10100101)], { r, f: 0x1f }, { sp: 0xbff8, cycles: 10 });
  assert.deepEqual([0xbff8, 0xbffa, 0xbffc, 0xbffe].map((a) => p.bus.r16(a)), [0x1000, 0x1002, 0x1005, 0x1007]);
  const all = one([enc.long(L("PUSHM"), 0xff)], { r }, { sp: 0xbff0, cycles: 18 });
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => all.bus.r16(0xbff0 + 2 * i)), [0x1000, 0x1001, 0x1002, 0x1003, 0x1004, 0x1005, 0x1006, 0x1007]);
  one([enc.long(L("POPM"), 0b10100101)], { sp: 0xbff8, mem: { 0xbff8: 0xa0, 0xbffa: 0xa2, 0xbffc: 0xa5, 0xbffe: 0xa7 } },
    { r: { 0: 0xa0, 2: 0xa2, 5: 0xa5, 7: 0xa7 }, sp: 0xc000, cycles: 10 });
  one([enc.long(L("POPM"), 0)], {}, { cycles: 2 });
  one([enc.long(L("PUSHM"), 0)], {}, { cycles: 2 });
  // PUSHM then POPM with the same mask restores every register
  const { cpu, bus } = setup([enc.long(L("PUSHM"), 0x5a), enc.quick(false, 1, 0), enc.quick(false, 3, 0), enc.quick(false, 4, 0), enc.quick(false, 6, 0), enc.long(L("POPM"), 0x5a)], { r });
  for (let i = 0; i < 6; i++) step(cpu, bus);
  assert.deepEqual([Array.from(cpu.r), cpu.sp], [[0x1000, 0x1001, 0x1002, 0x1003, 0x1004, 0x1005, 0x1006, 0x1007], 0xc000]);
});

test("ADDSP: SP += s8 × 2, 2 cycles, no flags", () => {
  one([enc.long(L("ADDSP"), 0x80)], { f: 0x0f }, { sp: 0xbf00, cycles: 2 });
  one([enc.long(L("ADDSP"), 0x7f)], {}, { sp: 0xc0fe, cycles: 2 });
  one([enc.long(L("ADDSP"), 0xff)], {}, { sp: 0xbffe, cycles: 2 });
  one([enc.long(L("ADDSP"), 0x01)], { sp: 0xfffe }, { sp: 0x0000, cycles: 2 });
});

test("JMPT Rd, table: PC = word at table + Rd × 2, 8 cycles", () => {
  one([enc.long(L("JMPT"), 3 << 5), 0x0300], { r: { 3: 2 }, mem: { 0x0304: 0x0880 }, f: 0x1f }, { pc: 0x0880, cycles: 8 });
  one([enc.long(L("JMPT"), 3 << 5), 0xfffe], { r: { 3: 2 }, mem: { 0x0002: 0x0990 } }, { pc: 0x0990, cycles: 8 });
  one([enc.long(L("JMPT"), (3 << 5) | 0x1f), 0x0300], { r: { 3: 0 }, mem: { 0x0300: 0x0770 } }, { pc: 0x0770, cycles: 8 });
});

// ---------------------------------------------------------------------------
// Reserved encodings
test("reserved encodings: one-word 2-cycle NOP (group 0 ops 27-31, group B ops 6-15, majors C-F)", () => {
  const words: number[] = [];
  for (let op = 27; op < 32; op++) words.push(enc.unary(op), enc.unary(op, 7, 15));
  for (let op = 6; op < 16; op++) words.push(enc.long(op), enc.long(op, 0xff));
  for (const major of [0xc, 0xd, 0xe, 0xf]) words.push(major << 12, (major << 12) | 0x0fff, (major << 12) | 0x0123);
  const init = { r: { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8 }, f: 0x1f, sp: 0x8888 };
  for (const w of words) {
    assert.equal(decode(w).kind, "reserved", hex(w));
    const { bus } = one([w, 0xffff], init, { pc: 0x0102, cycles: 2 }, hex(w));
    assert.equal(bus.r16(0x8886), 0, "no stack writes");
  }
});

// ---------------------------------------------------------------------------
// Extra cycles from the bus
test("bus.takeExtraCycles() is added after every instruction and consumed", () => {
  const { cpu, bus } = setup([enc.unary(U("NOP")), enc.mem(false, false, 1, 2, 0), enc.aluR(A("SHL"), 1, 2)], { r: { 2: 3 } });
  bus.extra = 7;
  assert.equal(step(cpu, bus), 9);
  assert.equal(bus.extra, 0);
  bus.extraEach = 3;
  assert.equal(step(cpu, bus), 7);
  assert.equal(step(cpu, bus), 2 + 3 + 3);
  assert.equal(bus.takes, 3, "one take per instruction");
});

// ---------------------------------------------------------------------------
// Interrupts
function irqMachine(pending: number, f: number = I) {
  return setup([enc.unary(U("NOP")), enc.unary(U("NOP")), enc.unary(U("NOP"))], {
    f, pending, mem: { 0x0002: 0x0a00, 0x0004: 0x0b00, 0x0006: 0x0c00, 0x0008: 0x0d00 },
  });
}

test("interrupt entry: push PC, push F, I = 0, PC = vector, 12 cycles, IF not cleared", () => {
  const { cpu, bus } = irqMachine(1, I | C | Z);
  assert.equal(step(cpu, bus), 12);
  assert.deepEqual(state(cpu), { r: [0, 0, 0, 0, 0, 0, 0, 0], sp: 0xbffc, pc: 0x0a00, f: C | Z, mode: "run" });
  assert.equal(bus.r16(0xbffe), 0x0100);
  assert.equal(bus.r16(0xbffc), I | C | Z);
  assert.equal(bus.pending, 1, "IF not cleared by the CPU");
  // with I = 0 now, the handler's first instruction runs
  bus.w16(0x0a00, enc.quick(false, 1, 9));
  assert.equal(step(cpu, bus), 2);
  assert.equal(cpu.r[1], 9);
});

test("interrupt priority VBLANK > LINE > TIMER", () => {
  const cases: [number, number][] = [[1, 0x0a00], [2, 0x0b00], [4, 0x0c00], [3, 0x0a00], [6, 0x0b00], [5, 0x0a00], [7, 0x0a00]];
  for (const [p, vec] of cases) {
    const { cpu, bus } = irqMachine(p);
    assert.equal(step(cpu, bus), 12, `pending ${p}`);
    assert.equal(cpu.pc, vec, `pending ${p}`);
  }
});

test("no interrupt with I = 0 or with nothing pending", () => {
  const a = irqMachine(7, 0);
  assert.equal(step(a.cpu, a.bus), 2);
  assert.equal(a.cpu.pc, 0x0102);
  const b = irqMachine(0, I);
  assert.equal(step(b.cpu, b.bus), 2);
  assert.equal(b.cpu.pc, 0x0102);
});

test("interrupt handler + RTI returns to the interrupted instruction with F restored", () => {
  const { cpu, bus } = setup([enc.unary(U("NOP")), enc.quick(false, 2, 2)], {
    f: I | N, mem: { 0x0002: 0x0a00, 0x0a00: enc.quick(false, 0, 1), 0x0a02: enc.mem(false, true, 0, 7, 0), 0x0a04: enc.unary(U("RTI")) },
    r: { 7: ACK },
  });
  assert.equal(step(cpu, bus), 2); // NOP (nothing pending)
  bus.pending = 1;
  assert.equal(step(cpu, bus), 12);
  assert.equal(step(cpu, bus), 2);  // MOVQ R0,#1 — MOVQ sets flags, F = 0 now
  assert.equal(cpu.f, 0);
  assert.equal(step(cpu, bus), 4);  // ST R0,[R7] acknowledges
  assert.equal(bus.pending, 0);
  assert.equal(step(cpu, bus), 8);  // RTI
  assert.deepEqual([cpu.pc, cpu.sp, cpu.f], [0x0102, 0xc000, I | N]);
  assert.equal(step(cpu, bus), 2);
  assert.equal(cpu.r[2], 2);
});

test("EI has a one-instruction delay; GETF right after EI reads I = 1", () => {
  const { cpu, bus } = setup([enc.unary(U("EI")), enc.unary(U("GETF"), 3), enc.unary(U("NOP"))], {
    pending: 1, mem: { 0x0002: 0x0a00 },
  });
  assert.equal(step(cpu, bus), 2);   // EI
  assert.equal(step(cpu, bus), 2);   // GETF runs: no interrupt at the boundary right after EI
  assert.equal(cpu.r[3], I);
  assert.equal(cpu.pc, 0x0104);
  assert.equal(step(cpu, bus), 12);  // now taken
  assert.equal(bus.r16(0xbffe), 0x0104);
});

test("EI; RTS returns before a pending interrupt is taken", () => {
  const { cpu, bus } = setup([enc.unary(U("EI")), enc.unary(U("RTS"))], {
    pending: 4, sp: 0xbffe, mem: { 0xbffe: 0x0300, 0x0006: 0x0c00 },
  });
  step(cpu, bus);
  assert.equal(step(cpu, bus), 6);
  assert.deepEqual([cpu.pc, cpu.sp], [0x0300, 0xc000]);
  assert.equal(step(cpu, bus), 12);
  assert.deepEqual([cpu.pc, bus.r16(0xbffe)], [0x0c00, 0x0300]);
});

test("EI; DI: no interrupt", () => {
  const { cpu, bus } = setup([enc.unary(U("EI")), enc.unary(U("DI")), enc.unary(U("NOP"))], { pending: 1 });
  step(cpu, bus); step(cpu, bus);
  assert.equal(step(cpu, bus), 2);
  assert.equal(cpu.pc, 0x0106);
});

test("SETF and RTI loading I = 1 allow an interrupt at the very next boundary", () => {
  const s = setup([enc.unary(U("SETF"), 0), enc.unary(U("NOP"))], { r: { 0: I }, pending: 2, mem: { 0x0004: 0x0b00 } });
  assert.equal(step(s.cpu, s.bus), 2);
  assert.equal(step(s.cpu, s.bus), 12);
  assert.equal(s.bus.r16(0xbffe), 0x0102);
  const r = setup([enc.unary(U("RTI"))], { sp: 0xbffc, mem: { 0xbffc: I, 0xbffe: 0x0300, 0x0004: 0x0b00 }, pending: 2 });
  assert.equal(step(r.cpu, r.bus), 8);
  assert.equal(step(r.cpu, r.bus), 12);
  assert.deepEqual([r.cpu.pc, r.bus.r16(0xbffe)], [0x0b00, 0x0300]);
});

test("WAI with I = 1: idles 1 cycle per step, then takes the interrupt returning after WAI", () => {
  const { cpu, bus } = setup([enc.unary(U("EI")), enc.unary(U("WAI")), enc.quick(false, 1, 5)], { mem: { 0x0002: 0x0a00, 0x0004: 0x0b00 } });
  assert.equal(step(cpu, bus), 2);
  assert.equal(step(cpu, bus), 2);
  assert.equal(cpu.mode, "wait");
  assert.equal(cpu.pc, 0x0104);
  for (let i = 0; i < 4; i++) assert.equal(step(cpu, bus), 1);
  assert.deepEqual([cpu.pc, cpu.mode, cpu.sp], [0x0104, "wait", 0xc000]);
  bus.pending = 6;
  assert.equal(step(cpu, bus), 12);
  assert.deepEqual([cpu.pc, cpu.mode, cpu.sp, cpu.f, bus.r16(0xbffe), bus.r16(0xbffc)], [0x0b00, "run", 0xbffc, 0, 0x0104, I]);
});

test("WAI with I = 0: wakes on a pending interrupt and continues with the next instruction", () => {
  const { cpu, bus } = setup([enc.unary(U("WAI")), enc.quick(false, 1, 5), enc.quick(false, 2, 6)]);
  assert.equal(step(cpu, bus), 2);
  assert.equal(cpu.mode, "wait");
  assert.equal(step(cpu, bus), 1);
  bus.pending = 4;
  assert.equal(step(cpu, bus), 2);   // wakes and executes MOVQ R1,#5 in the same step
  assert.deepEqual([cpu.mode, cpu.r[1], cpu.pc, cpu.sp], ["run", 5, 0x0104, 0xc000]);
  assert.equal(bus.pending, 4);
});

test("WAI with an interrupt already pending completes at once", () => {
  const a = setup([enc.unary(U("WAI")), enc.quick(false, 1, 5)], { f: I, pending: 1, mem: { 0x0002: 0x0a00 } });
  // I = 1 and pending: the interrupt is taken before WAI even runs
  assert.equal(step(a.cpu, a.bus), 12);
  const b = setup([enc.unary(U("EI")), enc.unary(U("WAI")), enc.quick(false, 1, 5)], { pending: 1, mem: { 0x0002: 0x0a00 } });
  step(b.cpu, b.bus);
  assert.equal(step(b.cpu, b.bus), 2);  // WAI (delay slot of EI)
  assert.equal(b.cpu.mode, "run");
  assert.equal(step(b.cpu, b.bus), 12);
  assert.equal(b.bus.r16(0xbffe), 0x0104);
  const c = setup([enc.unary(U("WAI")), enc.quick(false, 1, 5)], { pending: 1 });
  assert.equal(step(c.cpu, c.bus), 2);
  assert.equal(c.cpu.mode, "run");
  assert.equal(step(c.cpu, c.bus), 2);
  assert.equal(c.cpu.r[1], 5);
});

// ---------------------------------------------------------------------------
// Serialization
function snapshotEq(a: Tally, b: Tally, msg: string) {
  assert.deepEqual(state(a), state(b), msg);
  assert.deepEqual(Array.from(a.serialize()), Array.from(b.serialize()), msg);
}

test("serialize/deserialize preserves the EI delay and wait mode", () => {
  const s = setup([enc.unary(U("EI")), enc.unary(U("NOP")), enc.unary(U("NOP"))], { pending: 1, mem: { 0x0002: 0x0a00 } });
  step(s.cpu, s.bus);
  const copy = new Tally();
  copy.deserialize(s.cpu.serialize());
  snapshotEq(copy, s.cpu, "after EI");
  assert.equal(step(copy, s.bus), 2, "delay survives the round trip");
  assert.equal(step(copy, s.bus), 12);

  const w = setup([enc.unary(U("WAI"))]);
  step(w.cpu, w.bus);
  const wc = new Tally();
  wc.deserialize(w.cpu.serialize());
  assert.equal(wc.mode, "wait");
  const st = setup([enc.unary(U("STOP"))]);
  step(st.cpu, st.bus);
  const sc = new Tally();
  sc.deserialize(st.cpu.serialize());
  assert.equal(sc.mode, "stop");
  assert.throws(() => new Tally().deserialize(new Uint8Array(3)));
});

const ROUND_TRIP_SRC = `
        .org 0
        .word start, vbl, line, timer, trapper
        .org $100
start:  MOV R0,#$8000
        MOV R1,#10
        EI
.loop:  ST R1,[R0]+
        BSR sub
        ADD R2,R1
        DEC R1
        BNE .loop
        TRAP #3
        MOV R1,#10
        MOV R0,#$8000
        CMP R2,#$4000
        BLO .loop
        MOV R2,#0
        BRA .loop
sub:    PUSHM R0,R1
        MUL R1,R1
        ADC R3,R1
        FMUL R3,R1
        ROL R3,#3
        MOV R0,SP
        LD R1,[R0+2]
        ST R1,[SP+2]
        POPM R0,R1
        RTS
vbl:    PUSH R0
        MOV R0,#1
        ST R0,[$E000]
        INC R4
        POP R0
        RTI
line:   PUSH R0
        MOV R0,#2
        ST R0,[$E000]
        ADD R5,#3
        POP R0
        EI
        RTI
timer:  PUSH R0
        MOV R0,#4
        ST R0,[$E000]
        GETF R6
        POP R0
        RTI
trapper:
        INC R7
        RTI
`;

test("serialize → deserialize mid-program continues identically (with interrupts)", () => {
  const res = assemble("main.asm", (p) => { if (p !== "main.asm") throw new Error(p); return ROUND_TRIP_SRC; });
  assert.deepEqual(res.errors, []);
  const bus = new TestBus();
  bus.mem.set(res.rom.subarray(0, 0x4000), 0);
  const cpu = new Tally();
  cpu.reset(bus);
  // Deterministic interrupt schedule by global step number.
  const schedule = (n: number, b: TestBus) => {
    if (n % 97 === 0) b.pending |= 1;
    if (n % 61 === 0) b.pending |= 2;
    if (n % 43 === 0) b.pending |= 4;
  };
  let n = 0;
  for (; n < 1500; n++) { schedule(n, bus); step(cpu, bus); }
  const saved = cpu.serialize();
  const bus2 = new TestBus();
  bus2.mem.set(bus.mem);
  bus2.pending = bus.pending;
  const cpu2 = new Tally();
  cpu2.deserialize(saved);
  snapshotEq(cpu2, cpu, "restored");
  let total1 = 0, total2 = 0;
  for (let k = 0; k < 5000; k++, n++) {
    schedule(n, bus); schedule(n, bus2);
    total1 += cpu.step(bus);
    total2 += cpu2.step(bus2);
    if (k % 250 === 0) snapshotEq(cpu2, cpu, `step ${n}`);
  }
  assert.equal(total1, total2);
  snapshotEq(cpu2, cpu, "end");
  assert.deepEqual(bus2.mem, bus.mem);
  // the program really exercised interrupts and the trap
  assert.ok(cpu.r[4] > 0 && cpu.r[5] > 0 && cpu.r[7] > 0, `R4=${cpu.r[4]} R5=${cpu.r[5]} R7=${cpu.r[7]}`);
});

// ---------------------------------------------------------------------------
// Coverage: must stay the last test in this file.
test("coverage: every mnemonic and addressing form was executed", () => {
  const want = new Set<string>();
  for (const m of UNARY_OPS) want.add(`U:${m}`);
  for (const m of ALU_OPS) { want.add(`R:${m}`); want.add(`I:${m}`); }
  want.add("MOVQ"); want.add("ADDQ");
  for (const m of ["LD", "ST", "LDB", "STB"]) {
    want.add(`M:${m}`);
    for (let mode = 0; mode < 4; mode++) want.add(`X:${m}:${mode}`);
  }
  want.add("S:LD"); want.add("S:ST");
  for (const c of CONDITIONS) want.add(`B${c}`);
  for (const m of LONG_OPS) want.add(`L:${m}`);
  want.add("RESERVED");
  const missing = [...want].filter((k) => !seen.has(k));
  assert.deepEqual(missing, []);
});

// spec-notes §66: EI's delay applies even when I is already 1.
import { Tally as TallyEI } from "../src/machine/cpu.ts";
import { enc as encEI, UNARY_OPS as UOPS } from "../src/isa/isa.ts";
test("EI delay applies even when interrupts are already enabled (§66)", () => {
  const mem = new Uint8Array(65536);
  const w = (a: number, v: number) => { mem[a] = v & 255; mem[a + 1] = v >> 8; };
  w(0, 0x100); w(2, 0x200);                       // reset, VBLANK vectors
  const u = (n: string) => UOPS.indexOf(n as any);
  w(0x100, encEI.unary(u("EI"))); w(0x102, encEI.unary(u("EI"))); w(0x104, encEI.unary(u("NOP"))); w(0x106, encEI.unary(u("STOP")));
  w(0x200, encEI.unary(u("STOP")));
  let pending = 0;
  const bus = { read8: (a: number) => mem[a & 0xffff], read16: (a: number) => mem[a & 0xfffe] | (mem[(a & 0xfffe) + 1] << 8),
    write8: (a: number, v: number) => { mem[a & 0xffff] = v; }, write16: (a: number, v: number) => { mem[a & 0xfffe] = v & 255; mem[(a & 0xfffe) + 1] = v >> 8; },
    pendingInterrupts: () => pending, takeExtraCycles: () => 0 };
  const c = new TallyEI(); c.reset(bus);
  c.step(bus);                 // first EI: I = 1
  pending = 1;
  c.step(bus);                 // second EI: delay again, no interrupt yet
  assert.equal(c.pc, 0x104);
  c.step(bus);                 // NOP executes: the second EI's delay still holds
  assert.equal(c.pc, 0x106);
  c.step(bus);                 // interrupt entry
  assert.equal(c.pc, 0x200);
  c.step(bus);                 // STOP at the vector
  assert.equal(c.mode, "stop");
});
