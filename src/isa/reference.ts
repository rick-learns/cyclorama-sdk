// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Tally (AV-1601) instruction reference data for the manual generator.
//
// isa.ts is the normative source for encodings and cycles; this file adds the
// prose a programmer needs for every mnemonic and form: CYASM syntax, which bit
// fields vary, the extension word, flag effects, pseudo-code and notes. Base
// words are computed with enc.* and cycle counts are read from CYCLES and
// aluExtraCycles, never typed by hand. Behaviour follows docs/spec-notes.md §1.
import { ALU_OPS, UNARY_OPS, CONDITIONS, LONG_OPS, CYCLES, aluExtraCycles, enc } from "./isa.ts";

/** A variable (or ignored) bit field of the first instruction word. */
export type Field = { name: string; hi: number; lo: number; ignored?: boolean };
/** Cycle cost: base cycles, cycles when a branch is taken, and a variable part. */
export type CycleSpec = { base: number; taken?: number; plus?: string };
export type Form = {
  syntax: string;      // CYASM syntax
  word: number;        // first word with every variable field zero
  fields: Field[];     // fields not fixed by `word`
  ext?: string;        // meaning of the extension word, if present
  cycles: CycleSpec;
  note?: string;
};
/** Effect on Z, N, C, V. Codes: "*" per result, "–" unchanged, "0"/"1" forced; other words defined in notes. */
export type Flags = [z: string, n: string, c: string, v: string];
export type GroupId = "system" | "alu" | "quick" | "memory" | "branch" | "long" | "reserved";
export type Entry = {
  mnemonic: string;    // table mnemonic (ALU_OPS / UNARY_OPS / LONG_OPS / "MOVQ" ... )
  title: string;
  group: GroupId;
  forms: Form[];
  flags: Flags;
  operation: string;   // pseudo-code, one statement per line
  notes: string[];
};

export const GROUPS: { id: GroupId; title: string; intro: string }[] = [
  { id: "system", title: "Group 0: system, unary and register-indirect instructions", intro: "One-word instructions. Bits 11–7 select one of 27 operations; bits 6–4 name a register and bits 3–0 carry a 4-bit immediate where the operation uses them. Fields an operation does not use are ignored (write 0)." },
  { id: "alu", title: "Groups 1 and 2: arithmetic and logic", intro: "Sixteen operations, each with a register form (group 1, one word) and an immediate form (group 2, followed by a 16-bit immediate). The operation number in bits 11–8 is the same in both groups." },
  { id: "quick", title: "Group 3: quick immediates", intro: "One-word MOV and ADD with a sign-extended 8-bit immediate. CYASM chooses these forms automatically." },
  { id: "memory", title: "Groups 4–9: loads and stores", intro: "Word and byte loads and stores. Groups 4–7 are one-word short forms with a small displacement; group 8 adds a 16-bit displacement, absolute addressing, post-increment and pre-decrement; group 9 addresses the stack frame. Loads and stores never change the flags." },
  { id: "branch", title: "Group A: branches", intro: "Conditional branches with a signed 8-bit word displacement: target = address of the next instruction + displacement × 2, a reach of −256 to +254 bytes." },
  { id: "long", title: "Group B: long control", intro: "Absolute jumps and calls, multiple-register push and pop, stack adjustment and table jumps." },
  { id: "reserved", title: "Reserved encodings", intro: "Encodings with no assigned operation." },
];

// ---------------------------------------------------------------------------
// Field shorthands
const f = (name: string, hi: number, lo: number): Field => ({ name, hi, lo });
const x = (hi: number, lo: number): Field => ({ name: "0", hi, lo, ignored: true });
const u = (m: string) => {
  const op = UNARY_OPS.indexOf(m as (typeof UNARY_OPS)[number]);
  if (op < 0) throw new Error(`unknown unary ${m}`);
  return op;
};
const a = (m: string) => {
  const op = ALU_OPS.indexOf(m as (typeof ALU_OPS)[number]);
  if (op < 0) throw new Error(`unknown ALU op ${m}`);
  return op;
};
const lop = (m: string) => LONG_OPS.indexOf(m as (typeof LONG_OPS)[number]);

// Variable cycle parts, derived from aluExtraCycles so a table change shows up here.
const perBit = aluExtraCycles(a("SHL"), 1) - aluExtraCycles(a("SHL"), 0);
const SHIFT_PLUS = perBit === 1 ? "n" : `${perBit}n`;
const PER_REG = `${CYCLES.perReg} per register`;
const unaryCycles = (m: string): CycleSpec => ({ base: CYCLES.unary[m], ...(/^(SHL|SHR|ASR|ROL)I$/.test(m) ? { plus: SHIFT_PLUS } : {}) });

// ---------------------------------------------------------------------------
// Group 0
const none: Flags = ["–", "–", "–", "–"];
const g0 = (m: string, title: string, syntax: string, fields: Field[], flags: Flags, operation: string, notes: string[] = []): Entry => ({
  mnemonic: m, title, group: "system",
  forms: [{ syntax, word: enc.unary(u(m)), fields, cycles: unaryCycles(m) }],
  flags, operation, notes,
});
const noOperand = [x(6, 0)];
const rdOnly = [f("Rd", 6, 4), x(3, 0)];
const shiftI = [f("Rd", 6, 4), f("n−1", 3, 0)];

const SHIFT_NOTE = "The count n is 1–16 and is encoded as n − 1 in bits 3–0. Shifting by 16 is allowed.";
const shiftFlags: Flags = ["*", "*", "out", "0"];

const system: Entry[] = [
  g0("NOP", "No operation", "NOP", noOperand, none, "(none)"),
  g0("STOP", "Stop until reset", "STOP", noOperand, none, "halt: no further instructions are fetched until RESET", [
    "STOP halts only the processor: the timer, video, audio and controller sampling keep running and IF bits go on being set. Interrupts do not wake a stopped processor; only RESET does. Conformance and test cartridges end with STOP, and the reference emulator reports it to the host.",
  ]),
  g0("WAI", "Wait for interrupt", "WAI", noOperand, none,
    "while (IE & IF) = 0: fetch nothing; time passes\n(then the ordinary interrupt check between instructions applies)", [
      "WAI completes at the first CPU-cycle boundary at or after the moment IE & IF becomes non-zero. CPU-cycle boundaries are the master cycles that are multiples of 6 counted from power-on: a LINE request, made at dot 256, 1024 master cycles into its line and so 4 past a boundary, ends the wait 2 master cycles later. The cycle count is the minimum; the processor then waits.",
      "If an enabled interrupt is already pending when WAI is reached and I = 1, the interrupt is taken before WAI executes, and the pushed return address is that of the WAI itself. Directly after EI, WAI executes first, completes at once, and the interrupt is taken at the next boundary. With I = 0, WAI completes at once.",
      "When WAI completes with I = 1 the interrupt is taken, and the pushed return address is that of the instruction after WAI. If I = 0 no interrupt is taken and the next instruction follows immediately; IF is not cleared.",
      "EI followed by WAI is the recommended idle loop: the one-instruction EI delay has expired by the time WAI completes.",
    ]),
  g0("RTS", "Return from subroutine", "RTS", noOperand, none, "PC ← pop()"),
  g0("RTI", "Return from interrupt", "RTI", noOperand, ["pop", "pop", "pop", "pop"], "F ← pop() & 001F\nPC ← pop()", [
    "All of F, including I, is restored from the stack; interrupts enabled by the restored I may be taken at the very next instruction boundary.",
  ]),
  g0("EI", "Enable interrupts", "EI", noOperand, none, "I ← 1 (acceptance delayed by one instruction)", [
    "An interrupt is not accepted at the boundary immediately after EI, only after the instruction that follows it. So `EI` then `RTS` returns before any pending interrupt is taken.",
    "The delay applies every time EI executes, even when I is already 1.",
  ]),
  g0("DI", "Disable interrupts", "DI", noOperand, none, "I ← 0 (immediately)"),
  g0("TRAP", "Software trap", "TRAP #n", [x(6, 4), f("n", 3, 0)], none,
    "push(next)\npush(F)\nI ← 0\nPC ← mem16[0008]", [
      "n (0–15) is not used by the processor. A handler that needs it reads the TRAP word at (return address − 2) and masks bits 3–0.",
      "TRAP is taken whatever the state of I. Return with RTI.",
    ]),
  g0("NOT", "Complement", "NOT Rd", rdOnly, ["*", "*", "0", "0"], "Rd ← Rd XOR FFFF"),
  g0("NEG", "Negate", "NEG Rd", rdOnly, ["*", "*", "borrow", "ovf"], "Rd ← 0 − Rd", [
    "Flags as SUB with minuend 0: C = 1 unless Rd was 0; V = 1 only when Rd was 8000.",
  ]),
  g0("INC", "Increment", "INC Rd", rdOnly, ["*", "*", "carry", "ovf"], "Rd ← Rd + 1", ["Flags as ADD Rd,#1: C = 1 only when Rd was FFFF; V = 1 only when Rd was 7FFF."]),
  g0("DEC", "Decrement", "DEC Rd", rdOnly, ["*", "*", "borrow", "ovf"], "Rd ← Rd − 1", ["Flags as SUB Rd,#1: C = 1 only when Rd was 0; V = 1 only when Rd was 8000."]),
  g0("SXB", "Sign-extend byte", "SXB Rd", rdOnly, ["*", "*", "–", "–"], "Rd ← sx8(Rd & 00FF)"),
  g0("ZXB", "Zero-extend byte", "ZXB Rd", rdOnly, ["*", "*", "–", "–"], "Rd ← Rd & 00FF"),
  g0("SWPB", "Swap bytes", "SWPB Rd", rdOnly, ["*", "*", "–", "–"], "Rd ← (Rd << 8 | Rd >> 8) & FFFF"),
  g0("SHLI", "Shift left by immediate", "SHL Rd, #n", shiftI, shiftFlags, "C ← bit (16 − n) of Rd\nRd ← (Rd << n) & FFFF", [SHIFT_NOTE, "SHL Rd,#16 gives 0 with C = old bit 0."]),
  g0("SHRI", "Logical shift right by immediate", "SHR Rd, #n", shiftI, shiftFlags, "C ← bit (n − 1) of Rd\nRd ← Rd >> n (zeros enter at bit 15)", [SHIFT_NOTE, "SHR Rd,#16 gives 0 with C = old bit 15."]),
  g0("ASRI", "Arithmetic shift right by immediate", "ASR Rd, #n", shiftI, shiftFlags, "C ← bit (n − 1) of s(Rd), where bit 16 and above equal bit 15\nRd ← s(Rd) >> n (copies of bit 15 enter)", [SHIFT_NOTE, "ASR Rd,#16 gives 0000 or FFFF with C = old bit 15."]),
  g0("ROLI", "Rotate left by immediate", "ROL Rd, #n", shiftI, shiftFlags, "Rd ← (Rd << n | Rd >> (16 − n)) & FFFF\nC ← bit 0 of the result", [SHIFT_NOTE, "ROL Rd,#16 leaves Rd unchanged and sets C to its bit 0. There is no rotate right: ROL by 16 − n rotates right by n."]),
  g0("JMPR", "Jump to register", "JMP [Rd]", rdOnly, none, "PC ← Rd & FFFE", ["Every load of PC clears bit 0, so an odd target runs from the even address below it."]),
  g0("CALLR", "Call through register", "CALL [Rd]", rdOnly, none, "push(next)\nPC ← Rd & FFFE", ["Every load of PC clears bit 0, so an odd target runs from the even address below it; the pushed return address is always even."]),
  g0("PUSH", "Push register", "PUSH Rd", rdOnly, none, "SP ← SP − 2\nmem16[SP] ← Rd"),
  g0("POP", "Pop register", "POP Rd", rdOnly, none, "Rd ← mem16[SP]\nSP ← SP + 2"),
  g0("MOVFS", "Move from stack pointer", "MOV Rd, SP", rdOnly, none, "Rd ← SP"),
  g0("MOVTS", "Move to stack pointer", "MOV SP, Rd", rdOnly, none, "SP ← Rd & FFFE", ["Bit 0 of SP is always 0."]),
  g0("GETF", "Get flags", "GETF Rd", rdOnly, none, "Rd ← F (bits 15–5 are 0)", ["F layout: bit 0 Z, bit 1 N, bit 2 C, bit 3 V, bit 4 I."]),
  g0("SETF", "Set flags", "SETF Rd", rdOnly, ["Rd", "Rd", "Rd", "Rd"], "F ← Rd & 001F", ["Sets Z, N, C, V and I from bits 0–4 of Rd."]),
];

// ---------------------------------------------------------------------------
// Groups 1 and 2
const src = "src";
type AluDef = [m: string, title: string, flags: Flags, operation: string, notes: string[]];
const shiftNote = (op: string) => `n = src & 15: the register form uses the low four bits of Rs, the immediate form the low four bits of the immediate. For counts of 1–16 CYASM writes the group 0 form ${op} Rd,#n (see ${op}I); ${op}W Rd,#n (n = 0–15) forces the group 2 form.`;
const ZERO_COUNT = "When n = 0, Rd is unchanged, Z and N reflect it, C is unchanged and V = 0.";
const aluDefs: AluDef[] = [
  ["MOV", "Move", ["*", "*", "–", "–"], `Rd ← ${src}`, []],
  ["ADD", "Add", ["*", "*", "carry", "ovf"], `r ← Rd + ${src}\nC ← 1 if r > FFFF\nV ← 1 if s(Rd) + s(${src}) is outside −32768…32767\nRd ← r & FFFF`, []],
  ["ADC", "Add with carry", ["*", "*", "carry", "ovf"], `r ← Rd + ${src} + C\nC ← 1 if r > FFFF\nV ← 1 if s(Rd) + s(${src}) + C is outside −32768…32767\nRd ← r & FFFF`, ["Chain ADD then ADC for 32-bit addition."]],
  ["SUB", "Subtract", ["*", "*", "borrow", "ovf"], `C ← 1 if ${src} > Rd (unsigned borrow)\nV ← 1 if s(Rd) − s(${src}) is outside −32768…32767\nRd ← (Rd − ${src}) & FFFF`, ["C is a borrow, not an inverted carry: after SUB, C = 1 means the unsigned result went below zero."]],
  ["SBC", "Subtract with borrow", ["*", "*", "borrow", "ovf"], `C ← 1 if ${src} + C > Rd (unsigned borrow)\nV ← 1 if s(Rd) − s(${src}) − C is outside −32768…32767\nRd ← (Rd − ${src} − C) & FFFF`, ["Chain SUB then SBC for 32-bit subtraction."]],
  ["CMP", "Compare", ["*", "*", "borrow", "ovf"], `flags as SUB Rd, ${src}\nRd is not written`, ["After CMP a,b: BLO/BCS branch if a < b unsigned, BLT if a < b signed, BEQ if equal."]],
  ["AND", "Logical AND", ["*", "*", "0", "0"], `Rd ← Rd AND ${src}`, []],
  ["OR", "Logical OR", ["*", "*", "0", "0"], `Rd ← Rd OR ${src}`, []],
  ["XOR", "Logical exclusive OR", ["*", "*", "0", "0"], `Rd ← Rd XOR ${src}`, []],
  ["TST", "Test bits", ["*", "*", "0", "0"], `flags from Rd AND ${src}\nRd is not written`, []],
  ["SHL", "Shift left", ["*", "*", "out", "0"], `n ← ${src} & 15\nif n ≠ 0: C ← bit (16 − n) of Rd; Rd ← (Rd << n) & FFFF`, [shiftNote("SHL"), ZERO_COUNT]],
  ["SHR", "Logical shift right", ["*", "*", "out", "0"], `n ← ${src} & 15\nif n ≠ 0: C ← bit (n − 1) of Rd; Rd ← Rd >> n`, [shiftNote("SHR"), ZERO_COUNT]],
  ["ASR", "Arithmetic shift right", ["*", "*", "out", "0"], `n ← ${src} & 15\nif n ≠ 0: C ← bit (n − 1) of Rd; Rd ← s(Rd) >> n`, [shiftNote("ASR"), ZERO_COUNT]],
  ["ROL", "Rotate left", ["*", "*", "out", "0"], `n ← ${src} & 15\nif n ≠ 0: Rd ← (Rd << n | Rd >> (16 − n)) & FFFF; C ← bit 0 of Rd`, [shiftNote("ROL"), ZERO_COUNT]],
  ["MUL", "Multiply (unsigned)", ["*", "*", ">FFFF", "0"], `p ← Rd × ${src} (unsigned, 32-bit)\nC ← 1 if p > FFFF\nRd ← p & FFFF`, ["Only the low 16 bits of the product are kept; C reports whether any were lost."]],
  ["FMUL", "Fixed-point multiply (signed 8.8)", ["*", "*", "0", "ovf"], `p ← s(Rd) × s(${src}) (signed, 32-bit)\nq ← p >> 8 (arithmetic)\nV ← 1 if q is outside −32768…32767\nRd ← q & FFFF`, ["Both operands and the result are signed 8.8 fixed point (0100 = 1.0, FF80 = −0.5). The shift truncates toward minus infinity."]],
];

const isShift = (m: string) => ["SHL", "SHR", "ASR", "ROL"].includes(m);
const alu: Entry[] = aluDefs.map(([m, title, flags, operation, notes]) => {
  const op = a(m);
  const plus = isShift(m) ? { plus: SHIFT_PLUS } : {};
  const forms: Form[] = [
    { syntax: `${m} Rd, Rs`, word: enc.aluR(op, 0, 0), fields: [f("Rd", 7, 5), f("Rs", 4, 2), x(1, 0)], cycles: { base: CYCLES.aluReg + aluExtraCycles(op, 0), ...plus }, note: "src = Rs" },
    {
      syntax: isShift(m) ? `${m} Rd, #imm16 (see note)` : m === "MOV" ? "MOV Rd, #imm16 · MOVW Rd, #imm16" : m === "ADD" ? "ADD Rd, #imm16 · ADDW Rd, #imm16" : `${m} Rd, #imm16`,
      word: enc.aluI(op, 0), fields: [f("Rd", 7, 5), x(4, 0)], ext: "imm16", cycles: { base: CYCLES.aluImm + aluExtraCycles(op, 0), ...plus }, note: "src = imm16",
    },
  ];
  const extra = m === "MOV" || m === "ADD"
    ? [`CYASM writes ${m} Rd,#n as the one-word ${m}Q form when n is known in pass 1 and fits −128…127; ${m}W forces the two-word form.`]
    : isShift(m) ? [`In CYASM the group 2 form is written ${m}W Rd,#n with n = 0–15; any other count is an error.`] : [];
  return { mnemonic: m, title, group: "alu", forms, flags, operation, notes: [...notes, ...extra] };
});

// ---------------------------------------------------------------------------
// Group 3
const quick: Entry[] = [
  {
    mnemonic: "MOVQ", title: "Move quick", group: "quick", flags: ["*", "*", "–", "–"],
    forms: [{ syntax: "MOV Rd, #n (n = −128…127)", word: enc.quick(false, 0, 0), fields: [f("Rd", 11, 9), f("imm8", 7, 0)], cycles: { base: CYCLES.quick } }],
    operation: "Rd ← sx8(imm8)", notes: ["Flags as MOV."],
  },
  {
    mnemonic: "ADDQ", title: "Add quick", group: "quick", flags: ["*", "*", "carry", "ovf"],
    forms: [{ syntax: "ADD Rd, #n (n = −128…127)", word: enc.quick(true, 0, 0), fields: [f("Rd", 11, 9), f("imm8", 7, 0)], cycles: { base: CYCLES.quick } }],
    operation: "Rd ← Rd + sx8(imm8), flags as ADD", notes: ["The immediate is sign-extended to 16 bits first, so ADD Rd,#−1 sets C unless Rd was 0 (a carry out of the 16-bit addition of FFFF)."],
  },
];

// ---------------------------------------------------------------------------
// Groups 4-9
const memEntry = (m: "LD" | "ST" | "LDB" | "STB"): Entry => {
  const byte = m.endsWith("B"), store = m.startsWith("ST");
  const size = byte ? 1 : 2;
  const r = "Rd";
  const acc = byte ? "mem8" : "mem16";
  const opLine = store ? `${acc}[a] ← ${byte ? "Rd & 00FF" : "Rd"}` : `Rd ← ${acc}[a]${byte ? " (zero-extended)" : ""}`;
  const dField = byte ? f("d", 5, 0) : f("d/2", 5, 0);
  const forms: Form[] = [
    { syntax: `${m} ${r}, [Rs+d] (d = ${byte ? "0…63" : "0…126, even"})`, word: enc.mem(byte, store, 0, 0, 0), fields: [f("Rd", 11, 9), f("Rs", 8, 6), dField], cycles: { base: CYCLES.memShort }, note: `a = (Rs + d) & FFFF; ${m} ${r},[Rs] is d = 0` },
    { syntax: `${m} ${r}, [Rs+d16]`, word: enc.memx(0, 0, byte, store, 0), fields: [f("Rd", 11, 9), f("Rs", 8, 6), x(1, 0)], ext: "d16", cycles: { base: CYCLES.memExt }, note: "a = (Rs + d16) & FFFF" },
    { syntax: `${m} ${r}, [addr]`, word: enc.memx(0, 0, byte, store, 1), fields: [f("Rd", 11, 9), x(8, 6), x(1, 0)], ext: "addr", cycles: { base: CYCLES.memExt }, note: "a = addr" },
    { syntax: `${m} ${r}, [Rs]+`, word: enc.memx(0, 0, byte, store, 2), fields: [f("Rd", 11, 9), f("Rs", 8, 6), x(1, 0)], cycles: { base: CYCLES.memPostPre }, note: `a = Rs, then Rs ← Rs + ${size}` },
    { syntax: `${m} ${r}, -[Rs]`, word: enc.memx(0, 0, byte, store, 3), fields: [f("Rd", 11, 9), f("Rs", 8, 6), x(1, 0)], cycles: { base: CYCLES.memPostPre }, note: `Rs ← Rs − ${size}, then a = Rs` },
  ];
  if (!byte) forms.push({ syntax: `${m} ${r}, [SP+d] (d = 0…510, even)`, word: enc.sprel(0, store, 0), fields: [f("Rd", 11, 9), f("d/2", 7, 0)], cycles: { base: CYCLES.spRel }, note: "a = (SP + d) & FFFF" });
  const titles = { LD: "Load word", ST: "Store word", LDB: "Load byte", STB: "Store byte" };
  const notes = [
    store ? "The register named first (field Rd) is the value stored; Rs is the base address register." : "Rd receives the value; Rs is the base address register.",
    byte ? (store ? "Only the addressed byte changes. A byte store to an I/O register writes that half of the register and leaves the other half unchanged, except for the command registers DMACTL, V0CTRL–V3CTRL and IF, which act only on a store to their low byte (even address) and ignore a store to their high byte (see byte access to I/O registers in the system chapter)." : "The byte is zero-extended into Rd. A byte read of an I/O register returns the addressed half (even address = low byte).")
      : "Word accesses ignore address bit 0: the word at an odd address a is the word at a & FFFE. Words are little-endian (low byte at the even address). A word post-increment or pre-decrement with an odd register value accesses the aligned word but adds or subtracts exactly 2, so the register stays odd.",
    store
      ? `Post-increment/pre-decrement with Rd = Rs stores the value of the register before it is ${byte ? "incremented or decremented" : "incremented or decremented"}.`
      : "Post-increment/pre-decrement with Rd = Rs: the loaded value is what remains in the register.",
    byte
      ? "CYASM chooses the one-word short form when d is known in pass 1 and lies in 0…63; otherwise it writes the [Rs+d16] form."
      : "CYASM chooses the one-word short form when d is known in pass 1 and lies in 0…126; otherwise it writes the [Rs+d16] form. An odd d is an error in every form (short, [Rs+d16] and [SP+d]), even when d is not known until pass 2: it never selects the [Rs+d16] form.",
  ];
  return { mnemonic: m, title: titles[m], group: "memory", forms, flags: none, operation: `a ← effective address (see forms)\n${opLine}`, notes };
};

// ---------------------------------------------------------------------------
// Group A
export const CONDITION_TESTS: Record<string, [meaning: string, test: string]> = {
  RA: ["always", "true"], EQ: ["equal / zero", "Z = 1"], NE: ["not equal / non-zero", "Z = 0"],
  LO: ["unsigned lower (carry/borrow set)", "C = 1"], HS: ["unsigned higher or same", "C = 0"],
  MI: ["minus", "N = 1"], PL: ["plus", "N = 0"], VS: ["overflow set", "V = 1"], VC: ["overflow clear", "V = 0"],
  HI: ["unsigned higher", "C = 0 and Z = 0"], LS: ["unsigned lower or same", "C = 1 or Z = 1"],
  LT: ["signed less than", "N ≠ V"], GE: ["signed greater or equal", "N = V"],
  GT: ["signed greater than", "Z = 0 and N = V"], LE: ["signed less or equal", "Z = 1 or N ≠ V"],
  SR: ["subroutine (always, with push)", "true"],
};
const branchForms: Form[] = CONDITIONS.slice(0, 15).map((c, i) => ({
  syntax: `B${c} label${c === "LO" ? " · BCS label" : c === "HS" ? " · BCC label" : ""}`,
  word: enc.branch(i, 0), fields: [f("disp8", 7, 0)],
  cycles: i === 0 ? { base: CYCLES.branchTaken } : { base: CYCLES.branchNotTaken, taken: CYCLES.branchTaken },
  note: `cond ${c}: ${CONDITION_TESTS[c][1]}`,
}));
const branch: Entry[] = [
  {
    mnemonic: "Bcc", title: "Branch on condition", group: "branch", forms: branchForms, flags: none,
    operation: "if condition: PC ← next + sx8(disp8) × 2",
    notes: ["next is the address of the instruction after the branch. CYASM reports an error if the target is out of range.", "BCS and BCC are CYASM aliases for BLO and BHS: C is the carry after addition and the borrow after subtraction."],
  },
  {
    mnemonic: "BSR", title: "Branch to subroutine", group: "branch", flags: none,
    forms: [{ syntax: "BSR label", word: enc.branch(15, 0), fields: [f("disp8", 7, 0)], cycles: { base: CYCLES.bsr }, note: "cond SR: always" }],
    operation: "push(next)\nPC ← next + sx8(disp8) × 2", notes: ["Return with RTS."],
  },
];

// ---------------------------------------------------------------------------
// Group B
const long: Entry[] = [
  {
    mnemonic: "JMP", title: "Jump absolute", group: "long", flags: none, operation: "PC ← addr",
    forms: [{ syntax: "JMP addr", word: enc.long(lop("JMP")), fields: [x(7, 0)], ext: "addr", cycles: { base: CYCLES.jmpAbs } }],
    notes: ["JMP [Rd] is a different instruction: see JMPR."],
  },
  {
    mnemonic: "CALL", title: "Call absolute", group: "long", flags: none, operation: "push(next)\nPC ← addr",
    forms: [{ syntax: "CALL addr", word: enc.long(lop("CALL")), fields: [x(7, 0)], ext: "addr", cycles: { base: CYCLES.callAbs } }],
    notes: ["next is the address after the extension word. CALL [Rd] is CALLR."],
  },
  {
    mnemonic: "PUSHM", title: "Push multiple registers", group: "long", flags: none,
    operation: "for r = 7 down to 0: if mask bit r = 1: push(Rr)",
    forms: [{ syntax: "PUSHM list (e.g. PUSHM R0, R3-R5)", word: enc.long(lop("PUSHM")), fields: [f("mask", 7, 0)], cycles: { base: CYCLES.pushmBase, plus: PER_REG } }],
    notes: ["Mask bit r selects Rr. R0 ends at the lowest address, so POPM with the same list restores every register. SP cannot be in the list."],
  },
  {
    mnemonic: "POPM", title: "Pop multiple registers", group: "long", flags: none,
    operation: "for r = 0 up to 7: if mask bit r = 1: Rr ← pop()",
    forms: [{ syntax: "POPM list", word: enc.long(lop("POPM")), fields: [f("mask", 7, 0)], cycles: { base: CYCLES.pushmBase, plus: PER_REG } }],
    notes: ["A mask of 0 is legal and only costs the base cycles."],
  },
  {
    mnemonic: "ADDSP", title: "Adjust stack pointer", group: "long", flags: none, operation: "SP ← (SP + sx8(s8) × 2) & FFFF",
    forms: [{ syntax: "ADD SP, #n (n even, −256…254)", word: enc.long(lop("ADDSP")), fields: [f("s8", 7, 0)], cycles: { base: CYCLES.addsp } }],
    notes: ["The encoded field s8 is half the adjustment: CYASM writes ADD SP, #n with s8 = n ÷ 2, and SP changes by s8 × 2.", "Allocates (negative n) or releases (positive n) stack frame space. The flags are not changed."],
  },
  {
    mnemonic: "JMPT", title: "Jump through table", group: "long", flags: none, operation: "PC ← mem16[(table + Rd × 2) & FFFF]",
    forms: [{ syntax: "JMPT Rd, table", word: enc.long(lop("JMPT")), fields: [f("Rd", 7, 5), x(4, 0)], ext: "table", cycles: { base: CYCLES.jmpt } }],
    notes: ["Rd is an index, not a byte offset. The processor does not check the index against the table length."],
  },
];

// ---------------------------------------------------------------------------
const reserved: Entry[] = [{
  mnemonic: "RESERVED", title: "Reserved encodings", group: "reserved", flags: none, operation: "(none): a no-operation",
  forms: [
    { syntax: "(group 0, operations 27–31)", word: enc.unary(27), fields: [f("x", 6, 0)], cycles: { base: CYCLES.unary.NOP }, note: "bits 11–7 = 11011 … 11111" },
    { syntax: "(group B, operations 6–15)", word: enc.long(6), fields: [f("x", 7, 0)], cycles: { base: CYCLES.unary.NOP }, note: "bits 11–8 = 0110 … 1111" },
    { syntax: "(majors C, D, E, F)", word: 0xc000, fields: [f("x", 11, 0)], cycles: { base: CYCLES.unary.NOP }, note: "bits 15–12 = 1100 … 1111; applies to all four majors" },
  ],
  notes: [
    "Every reserved encoding executes as a one-word, two-cycle no-operation on every Cyclorama console and has no extension word. Must-be-zero bits in otherwise valid encodings are ignored.",
    "CYASM never emits a reserved encoding. Avenell reserves them for future use: do not rely on them.",
  ],
}];

export const REFERENCE: readonly Entry[] = [
  ...system, ...alu, ...quick,
  memEntry("LD"), memEntry("ST"), memEntry("LDB"), memEntry("STB"),
  ...branch, ...long, ...reserved,
];
