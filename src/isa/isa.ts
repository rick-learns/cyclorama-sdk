// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Tally (AV-1601) instruction set — the single source of truth shared by the
// manual generator, assembler, disassembler and emulator.
//
// Every instruction is one 16-bit word, optionally followed by one 16-bit
// extension word (immediate, absolute address or displacement). The top four
// bits select a major group.

// ALU operation numbers shared by groups 1 (register) and 2 (immediate).
export const ALU_OPS = ["MOV", "ADD", "ADC", "SUB", "SBC", "CMP", "AND", "OR", "XOR", "TST", "SHL", "SHR", "ASR", "ROL", "MUL", "FMUL"] as const;
export type AluOp = (typeof ALU_OPS)[number];

// Unary / system operations in group 0 (layout: LAYOUT.group0).
export const UNARY_OPS = [
  "NOP", "STOP", "WAI", "RTS", "RTI", "EI", "DI", "TRAP",
  "NOT", "NEG", "INC", "DEC", "SXB", "ZXB", "SWPB", "SHLI",
  "SHRI", "ASRI", "ROLI", "JMPR", "CALLR", "PUSH", "POP", "MOVFS",
  "MOVTS", "GETF", "SETF",
] as const;

export const CONDITIONS = ["RA", "EQ", "NE", "LO", "HS", "MI", "PL", "VS", "VC", "HI", "LS", "LT", "GE", "GT", "LE", "SR"] as const;
// Branch mnemonic = "B" + condition: BRA, BEQ, ..., BSR. Aliases: BCS=BLO, BCC=BHS.

export const LONG_OPS = ["JMP", "CALL", "PUSHM", "POPM", "ADDSP", "JMPT"] as const;

/** Instruction layouts, documented in the manual chapter "Instruction encoding". */
export const LAYOUT = {
  group0: "0000 ooooo ddd iiii      o=operation  d=register  i=imm4",
  group1: "0001 oooo ddd sss 00     o=ALU operation  d=destination  s=source",
  group2: "0010 oooo ddd 000 00  + imm16     ALU with 16-bit immediate",
  group3: "0011 ddd q iiiiiiii      q=0 MOVQ, q=1 ADDQ; i=signed 8-bit",
  group4: "01bs ddd sss pppppp      b=byte s=store; p=displacement 0..63 (words: x2)",
  group8: "1000 ddd sss b s mm 00 [+ disp16]   m=00 [Rs+d16], 01 [abs16], 10 [Rs]+, 11 -[Rs]",
  group9: "1001 ddd s pppppppp      SP-relative word load/store, displacement x2 (0..510)",
  groupA: "1010 cccc pppppppp       conditional branch, signed word displacement",
  groupB: "1011 oooo xxxxxxxx [+ ext16]  long control",
} as const;

export const MAJOR = {
  UNARY: 0x0, ALU_R: 0x1, ALU_I: 0x2, QUICK: 0x3,
  LD: 0x4, ST: 0x5, LDB: 0x6, STB: 0x7,
  MEMX: 0x8, SPREL: 0x9, BRANCH: 0xa, LONG: 0xb,
} as const;

/** Extra cycles for ALU operations beyond the base (count = shift amount 0..15). */
export function aluExtraCycles(op: number, count: number): number {
  if (op === 14 || op === 15) return 8;          // MUL, FMUL: 8 extra
  if (op >= 10 && op <= 13) return count;        // shifts/rotate: one per bit
  return 0;
}

/** Cycle counts, used identically by the emulator and the manual. */
export const CYCLES = {
  aluReg: 2, aluImm: 4, quick: 2,
  memShort: 4, memExt: 6, memPostPre: 4, spRel: 4,
  branchNotTaken: 2, branchTaken: 4, bsr: 6,
  jmpAbs: 6, callAbs: 8, pushmBase: 2, perReg: 2, addsp: 2, jmpt: 8,
  unary: {
    NOP: 2, STOP: 2, WAI: 2, RTS: 6, RTI: 8, EI: 2, DI: 2, TRAP: 10,
    NOT: 2, NEG: 2, INC: 2, DEC: 2, SXB: 2, ZXB: 2, SWPB: 2,
    SHLI: 2, SHRI: 2, ASRI: 2, ROLI: 2, // + shift count
    JMPR: 4, CALLR: 6, PUSH: 4, POP: 4, MOVFS: 2, MOVTS: 2, GETF: 2, SETF: 2,
  } as Record<string, number>,
  interruptEntry: 12,
  videoPortWait: 2, // extra cycles for VDATA/OAMDATA/CRAMDATA access during active display
} as const;

export const FLAG = { Z: 1, N: 2, C: 4, V: 8, I: 16 } as const;

// ---------------------------------------------------------------------------
// Encoding helpers (used by assembler and tests)
export const enc = {
  unary: (op: number, d = 0, imm4 = 0) => ((MAJOR.UNARY << 12) | ((op & 31) << 7) | ((d & 7) << 4) | (imm4 & 15)),
  aluR: (op: number, d: number, s: number) => ((MAJOR.ALU_R << 12) | ((op & 15) << 8) | ((d & 7) << 5) | ((s & 7) << 2)),
  aluI: (op: number, d: number) => ((MAJOR.ALU_I << 12) | ((op & 15) << 8) | ((d & 7) << 5)),
  quick: (add: boolean, d: number, imm8: number) => ((MAJOR.QUICK << 12) | ((d & 7) << 9) | ((add ? 1 : 0) << 8) | (imm8 & 255)),
  mem: (byte: boolean, store: boolean, d: number, s: number, disp6: number) =>
    (((byte ? 6 : 4) + (store ? 1 : 0)) << 12) | ((d & 7) << 9) | ((s & 7) << 6) | (disp6 & 63),
  memx: (d: number, s: number, byte: boolean, store: boolean, mode: number) =>
    ((MAJOR.MEMX << 12) | ((d & 7) << 9) | ((s & 7) << 6) | ((byte ? 1 : 0) << 5) | ((store ? 1 : 0) << 4) | ((mode & 3) << 2)),
  sprel: (d: number, store: boolean, disp8: number) => ((MAJOR.SPREL << 12) | ((d & 7) << 9) | ((store ? 1 : 0) << 8) | (disp8 & 255)),
  branch: (cond: number, disp8: number) => ((MAJOR.BRANCH << 12) | ((cond & 15) << 8) | (disp8 & 255)),
  long: (op: number, low8 = 0) => ((MAJOR.LONG << 12) | ((op & 15) << 8) | (low8 & 255)),
};

/** Does this first word carry an extension word? */
export function hasExtension(w: number): boolean {
  const major = w >>> 12;
  if (major === MAJOR.ALU_I) return true;
  if (major === MAJOR.MEMX) { const mode = (w >> 2) & 3; return mode === 0 || mode === 1; }
  if (major === MAJOR.LONG) { const op = (w >> 8) & 15; return op === 0 || op === 1 || op === 5; }
  return false;
}

// ---------------------------------------------------------------------------
// Decoder: total over all 16-bit words. Displacements are returned in bytes for
// memory forms and in words for branches (as encoded).
export type Decoded =
  | { mnemonic: string; kind: "unary"; op: number; d: number; imm: number; ext: false }
  | { mnemonic: string; kind: "aluR"; op: number; d: number; s: number; ext: false }
  | { mnemonic: string; kind: "aluI"; op: number; d: number; ext: true }
  | { mnemonic: string; kind: "quick"; d: number; imm: number; ext: false }
  | { mnemonic: string; kind: "mem"; d: number; s: number; disp: number; ext: false }
  | { mnemonic: string; kind: "memx"; d: number; s: number; mode: number; ext: boolean }
  | { mnemonic: string; kind: "sprel"; d: number; disp: number; ext: false }
  | { mnemonic: string; kind: "branch"; cond: number; disp: number; ext: false }
  | { mnemonic: string; kind: "long"; op: number; mask?: number; imm?: number; d?: number; ext: boolean }
  | { mnemonic: "RESERVED"; kind: "reserved"; ext: false };

const sx8 = (v: number) => ((v & 255) ^ 128) - 128;
const RESERVED: Decoded = { mnemonic: "RESERVED", kind: "reserved", ext: false };

export function decode(w: number): Decoded {
  const major = (w >>> 12) & 15;
  switch (major) {
    case MAJOR.UNARY: {
      const op = (w >> 7) & 31;
      if (op >= UNARY_OPS.length) return RESERVED;
      return { mnemonic: UNARY_OPS[op], kind: "unary", op, d: (w >> 4) & 7, imm: w & 15, ext: false };
    }
    case MAJOR.ALU_R: {
      const op = (w >> 8) & 15;
      return { mnemonic: ALU_OPS[op], kind: "aluR", op, d: (w >> 5) & 7, s: (w >> 2) & 7, ext: false };
    }
    case MAJOR.ALU_I: {
      const op = (w >> 8) & 15;
      return { mnemonic: ALU_OPS[op], kind: "aluI", op, d: (w >> 5) & 7, ext: true };
    }
    case MAJOR.QUICK:
      return { mnemonic: (w >> 8) & 1 ? "ADDQ" : "MOVQ", kind: "quick", d: (w >> 9) & 7, imm: sx8(w), ext: false };
    case MAJOR.LD: case MAJOR.ST: case MAJOR.LDB: case MAJOR.STB: {
      const byte = major >= MAJOR.LDB, store = (major & 1) === 1;
      return { mnemonic: (store ? "ST" : "LD") + (byte ? "B" : ""), kind: "mem", d: (w >> 9) & 7, s: (w >> 6) & 7, disp: (w & 63) * (byte ? 1 : 2), ext: false };
    }
    case MAJOR.MEMX: {
      const byte = (w >> 5) & 1, store = (w >> 4) & 1, mode = (w >> 2) & 3;
      return { mnemonic: (store ? "ST" : "LD") + (byte ? "B" : ""), kind: "memx", d: (w >> 9) & 7, s: (w >> 6) & 7, mode, ext: mode < 2 };
    }
    case MAJOR.SPREL:
      return { mnemonic: (w >> 8) & 1 ? "ST" : "LD", kind: "sprel", d: (w >> 9) & 7, disp: (w & 255) * 2, ext: false };
    case MAJOR.BRANCH: {
      const cond = (w >> 8) & 15;
      return { mnemonic: "B" + CONDITIONS[cond], kind: "branch", cond, disp: sx8(w), ext: false };
    }
    case MAJOR.LONG: {
      const op = (w >> 8) & 15;
      if (op >= LONG_OPS.length) return RESERVED;
      const mnemonic = LONG_OPS[op];
      if (op === 0 || op === 1) return { mnemonic, kind: "long", op, ext: true };
      if (op === 2 || op === 3) return { mnemonic, kind: "long", op, mask: w & 255, ext: false };
      if (op === 4) return { mnemonic, kind: "long", op, imm: sx8(w), ext: false };
      return { mnemonic, kind: "long", op, d: (w >> 5) & 7, ext: true };
    }
    default:
      return RESERVED;
  }
}
