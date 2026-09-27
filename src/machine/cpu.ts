// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Tally (AV-1601) CPU core: a switch-dispatched interpreter.
//
// Behaviour follows docs/spec-notes.md §1 (with the §8/§9 resolutions), encodings and cycle
// counts follow src/isa/isa.ts (CYCLES, aluExtraCycles), flags follow src/isa/reference.ts.
// Hot path rules: no allocation per instruction, integer math only, every word access and
// instruction fetch at an even address, every value handed to the bus already masked.
import type { Bus, CpuCore } from "./types.ts";
import { CYCLES, aluExtraCycles } from "../isa/isa.ts";

// Flag bits (F): Z=1 N=2 C=4 V=8 I=16.
const FZ = 1, FN = 2, FC = 4, FV = 8, FI = 16;
const FNZ_KEEP_CV = FC | FV | FI; // mask kept by MOV-class ops (Z,N recomputed)

// Cycle constants hoisted from the normative tables.
const CY_ALU_R = CYCLES.aluReg, CY_ALU_I = CYCLES.aluImm, CY_QUICK = CYCLES.quick;
const CY_MEM_SHORT = CYCLES.memShort, CY_MEM_EXT = CYCLES.memExt, CY_MEM_PP = CYCLES.memPostPre, CY_SPREL = CYCLES.spRel;
const CY_BR_NT = CYCLES.branchNotTaken, CY_BR_T = CYCLES.branchTaken, CY_BSR = CYCLES.bsr;
const CY_JMP = CYCLES.jmpAbs, CY_CALL = CYCLES.callAbs, CY_PUSHM = CYCLES.pushmBase, CY_PER_REG = CYCLES.perReg;
const CY_ADDSP = CYCLES.addsp, CY_JMPT = CYCLES.jmpt, CY_IRQ = CYCLES.interruptEntry;
const CY_RESERVED = CYCLES.unary.NOP;
// Group 0 base cycles indexed by operation number (UNARY_OPS order).
const UNARY_NAMES = [
  "NOP", "STOP", "WAI", "RTS", "RTI", "EI", "DI", "TRAP",
  "NOT", "NEG", "INC", "DEC", "SXB", "ZXB", "SWPB", "SHLI",
  "SHRI", "ASRI", "ROLI", "JMPR", "CALLR", "PUSH", "POP", "MOVFS",
  "MOVTS", "GETF", "SETF",
];
const CY_UNARY = new Int32Array(32);
for (let i = 0; i < 32; i++) CY_UNARY[i] = i < UNARY_NAMES.length ? CYCLES.unary[UNARY_NAMES[i]] : CY_RESERVED;
// Extra cycles per ALU op for count 0..16 (group 0 shifts use 1..16).
const ALU_EXTRA = new Int32Array(16 * 17);
for (let op = 0; op < 16; op++) for (let n = 0; n <= 16; n++) ALU_EXTRA[op * 17 + n] = aluExtraCycles(op, n);
// Group 0 shift op → ALU op number (SHLI..ROLI → SHL..ROL).
const G0_SHIFT_BASE = 15, ALU_SHL = 10;

const VEC_TRAP = 0x0008;
const MODE_CODES = ["run", "wait", "stop"] as const;
const STATE_VERSION = 1;
const STATE_SIZE = 26;

/** Z and N for a 16-bit result. */
const zn = (v: number) => (v === 0 ? FZ : 0) | ((v >> 14) & FN);

export class Tally implements CpuCore {
  r = new Uint16Array(8);
  sp = 0xc000;
  pc = 0;
  f = 0;
  mode: "run" | "wait" | "stop" = "run";
  /** Set by EI: interrupts are not recognised at the next instruction boundary. */
  eiDelay = false;

  reset(bus: Bus): void {
    this.r.fill(0);
    this.sp = 0xc000;
    this.f = 0;
    this.mode = "run";
    this.eiDelay = false;
    this.pc = bus.read16(0x0000) & 0xfffe;
  }

  step(bus: Bus): number {
    if (this.mode !== "run") {
      if (this.mode === "stop") return 1;
      if ((bus.pendingInterrupts() & 7) === 0) return 1;
      this.mode = "run"; // WAI completes; the ordinary boundary check below applies
    }
    if (this.eiDelay) this.eiDelay = false;
    else if ((this.f & FI) !== 0) {
      const p = bus.pendingInterrupts() & 7;
      if (p !== 0) return this.interrupt(bus, p);
    }

    const r = this.r;
    let pc = this.pc & 0xfffe;
    const w = bus.read16(pc);
    pc = (pc + 2) & 0xffff;
    let cyc = 0;

    switch (w >>> 12) {
      case 0x0: { // group 0: system / unary
        const op = (w >> 7) & 31, d = (w >> 4) & 7;
        cyc = CY_UNARY[op];
        switch (op) {
          case 0: break; // NOP
          case 1: this.mode = "stop"; break;
          case 2: if ((bus.pendingInterrupts() & 7) === 0) this.mode = "wait"; break;
          case 3: pc = this.pop(bus) & 0xfffe; break; // RTS
          case 4: this.f = this.pop(bus) & 0x1f; pc = this.pop(bus) & 0xfffe; break; // RTI
          case 5: this.f |= FI; this.eiDelay = true; break;
          case 6: this.f &= ~FI; break;
          case 7: // TRAP
            this.push(bus, pc);
            this.push(bus, this.f);
            this.f &= ~FI;
            pc = bus.read16(VEC_TRAP) & 0xfffe;
            break;
          case 8: { const v = r[d] ^ 0xffff; r[d] = v; this.f = (this.f & FI) | zn(v); break; } // NOT
          case 9: r[d] = this.sub(0, r[d], 0); break;   // NEG
          case 10: r[d] = this.add(r[d], 1, 0); break;  // INC
          case 11: r[d] = this.sub(r[d], 1, 0); break;  // DEC
          case 12: { const v = (((r[d] & 0xff) ^ 0x80) - 0x80) & 0xffff; r[d] = v; this.f = (this.f & FNZ_KEEP_CV) | zn(v); break; } // SXB
          case 13: { const v = r[d] & 0xff; r[d] = v; this.f = (this.f & FNZ_KEEP_CV) | zn(v); break; } // ZXB
          case 14: { const x = r[d]; const v = ((x << 8) | (x >> 8)) & 0xffff; r[d] = v; this.f = (this.f & FNZ_KEEP_CV) | zn(v); break; } // SWPB
          case 15: case 16: case 17: case 18: { // SHLI SHRI ASRI ROLI, n = imm4 + 1
            const n = (w & 15) + 1, aop = op - G0_SHIFT_BASE + ALU_SHL;
            r[d] = this.shift(aop, r[d], n);
            cyc += ALU_EXTRA[aop * 17 + n];
            break;
          }
          case 19: pc = r[d] & 0xfffe; break; // JMPR
          case 20: { const t = r[d] & 0xfffe; this.push(bus, pc); pc = t; break; } // CALLR
          case 21: this.push(bus, r[d]); break; // PUSH
          case 22: r[d] = this.pop(bus); break; // POP
          case 23: r[d] = this.sp; break;       // MOVFS
          case 24: this.sp = r[d] & 0xfffe; break; // MOVTS
          case 25: r[d] = this.f; break;        // GETF
          case 26: this.f = r[d] & 0x1f; break; // SETF
          default: break; // 27-31 reserved: NOP
        }
        break;
      }
      case 0x1: { // ALU Rd, Rs
        const op = (w >> 8) & 15;
        const src = r[(w >> 2) & 7];
        cyc = CY_ALU_R + this.alu(op, (w >> 5) & 7, src);
        break;
      }
      case 0x2: { // ALU Rd, #imm16
        const src = bus.read16(pc);
        pc = (pc + 2) & 0xffff;
        cyc = CY_ALU_I + this.alu((w >> 8) & 15, (w >> 5) & 7, src);
        break;
      }
      case 0x3: { // MOVQ / ADDQ
        const d = (w >> 9) & 7, imm = (((w & 0xff) ^ 0x80) - 0x80) & 0xffff;
        if ((w & 0x100) !== 0) r[d] = this.add(r[d], imm, 0);
        else { r[d] = imm; this.f = (this.f & FNZ_KEEP_CV) | zn(imm); }
        cyc = CY_QUICK;
        break;
      }
      case 0x4: // LD Rd,[Rs+d]
        r[(w >> 9) & 7] = bus.read16((r[(w >> 6) & 7] + ((w & 63) << 1)) & 0xfffe);
        cyc = CY_MEM_SHORT;
        break;
      case 0x5: // ST Rd,[Rs+d]
        bus.write16((r[(w >> 6) & 7] + ((w & 63) << 1)) & 0xfffe, r[(w >> 9) & 7]);
        cyc = CY_MEM_SHORT;
        break;
      case 0x6: // LDB Rd,[Rs+d]
        r[(w >> 9) & 7] = bus.read8((r[(w >> 6) & 7] + (w & 63)) & 0xffff);
        cyc = CY_MEM_SHORT;
        break;
      case 0x7: // STB Rd,[Rs+d]
        bus.write8((r[(w >> 6) & 7] + (w & 63)) & 0xffff, r[(w >> 9) & 7] & 0xff);
        cyc = CY_MEM_SHORT;
        break;
      case 0x8: { // extended memory forms
        const d = (w >> 9) & 7, s = (w >> 6) & 7;
        const byte = (w & 0x20) !== 0, store = (w & 0x10) !== 0, mode = (w >> 2) & 3;
        let addr: number;
        if (mode < 2) {
          const ext = bus.read16(pc);
          pc = (pc + 2) & 0xffff;
          addr = mode === 0 ? (r[s] + ext) & 0xffff : ext;
          cyc = CY_MEM_EXT;
          if (store) {
            if (byte) bus.write8(addr, r[d] & 0xff); else bus.write16(addr & 0xfffe, r[d]);
          } else r[d] = byte ? bus.read8(addr) : bus.read16(addr & 0xfffe);
        } else {
          const size = byte ? 1 : 2;
          const val = r[d]; // value stored (taken before any Rs update, so d = s stores the old value)
          if (mode === 2) { addr = r[s]; r[s] = addr + size; }
          else { addr = (r[s] - size) & 0xffff; r[s] = addr; }
          cyc = CY_MEM_PP;
          if (store) {
            if (byte) bus.write8(addr, val & 0xff); else bus.write16(addr & 0xfffe, val);
          } else r[d] = byte ? bus.read8(addr) : bus.read16(addr & 0xfffe); // load wins when d = s
        }
        break;
      }
      case 0x9: { // SP-relative word load/store
        const addr = (this.sp + ((w & 0xff) << 1)) & 0xfffe;
        if ((w & 0x100) !== 0) bus.write16(addr, r[(w >> 9) & 7]);
        else r[(w >> 9) & 7] = bus.read16(addr);
        cyc = CY_SPREL;
        break;
      }
      case 0xa: { // branches
        const cond = (w >> 8) & 15;
        const target = (pc + ((((w & 0xff) ^ 0x80) - 0x80) << 1)) & 0xffff;
        if (cond === 15) { // BSR
          this.push(bus, pc);
          pc = target;
          cyc = CY_BSR;
        } else if (this.cond(cond)) {
          pc = target;
          cyc = CY_BR_T;
        } else cyc = CY_BR_NT;
        break;
      }
      case 0xb: { // long control
        const op = (w >> 8) & 15;
        switch (op) {
          case 0: pc = bus.read16(pc) & 0xfffe; cyc = CY_JMP; break; // JMP
          case 1: { // CALL
            const t = bus.read16(pc) & 0xfffe;
            this.push(bus, (pc + 2) & 0xffff);
            pc = t;
            cyc = CY_CALL;
            break;
          }
          case 2: { // PUSHM: R7 down to R0
            let n = 0;
            for (let i = 7; i >= 0; i--) if ((w >> i) & 1) { this.push(bus, r[i]); n++; }
            cyc = CY_PUSHM + CY_PER_REG * n;
            break;
          }
          case 3: { // POPM: R0 up to R7
            let n = 0;
            for (let i = 0; i < 8; i++) if ((w >> i) & 1) { r[i] = this.pop(bus); n++; }
            cyc = CY_PUSHM + CY_PER_REG * n;
            break;
          }
          case 4: // ADDSP
            this.sp = (this.sp + ((((w & 0xff) ^ 0x80) - 0x80) << 1)) & 0xfffe;
            cyc = CY_ADDSP;
            break;
          case 5: { // JMPT Rd, table
            const table = bus.read16(pc);
            pc = bus.read16((table + (r[(w >> 5) & 7] << 1)) & 0xfffe) & 0xfffe;
            cyc = CY_JMPT;
            break;
          }
          default: cyc = CY_RESERVED; break; // ops 6-15 reserved: one-word NOP
        }
        break;
      }
      default: // majors C-F reserved: one-word NOP
        cyc = CY_RESERVED;
        break;
    }

    this.pc = pc;
    return cyc + bus.takeExtraCycles();
  }

  // -------------------------------------------------------------------------
  private interrupt(bus: Bus, pending: number): number {
    // Priority VBLANK (bit 0) > LINE (bit 1) > TIMER (bit 2); vectors 0002/0004/0006.
    const vector = (pending & 1) !== 0 ? 0x0002 : (pending & 2) !== 0 ? 0x0004 : 0x0006;
    this.push(bus, this.pc & 0xfffe);
    this.push(bus, this.f);
    this.f &= ~FI;
    this.pc = bus.read16(vector) & 0xfffe;
    return CY_IRQ + bus.takeExtraCycles();
  }

  private push(bus: Bus, v: number): void {
    const sp = (this.sp - 2) & 0xfffe;
    this.sp = sp;
    bus.write16(sp, v);
  }

  private pop(bus: Bus): number {
    const sp = this.sp & 0xfffe;
    const v = bus.read16(sp);
    this.sp = (sp + 2) & 0xffff;
    return v;
  }

  /** a + b + cin with ADD flags; returns the 16-bit result. */
  private add(a: number, b: number, cin: number): number {
    const t = a + b + cin, v = t & 0xffff;
    this.f = (this.f & FI) | zn(v) | (t > 0xffff ? FC : 0) | (((a ^ v) & (b ^ v) & 0x8000) >> 12);
    return v;
  }

  /** a − b − bin with SUB flags (C = borrow); returns the 16-bit result. */
  private sub(a: number, b: number, bin: number): number {
    const t = a - b - bin, v = t & 0xffff;
    this.f = (this.f & FI) | zn(v) | (t < 0 ? FC : 0) | (((a ^ b) & (a ^ v) & 0x8000) >> 12);
    return v;
  }

  /** Shift/rotate x by n (0..16) for ALU ops 10-13 with shift flags; returns the result. */
  private shift(op: number, x: number, n: number): number {
    if (n === 0) { this.f = (this.f & (FC | FI)) | zn(x); return x; }
    let v: number, c: number;
    switch (op) {
      case 10: v = (x << n) & 0xffff; c = (x >> (16 - n)) & 1; break;             // SHL
      case 11: v = x >>> n; c = (x >> (n - 1)) & 1; break;                          // SHR
      case 12: { const s = (x << 16) >> 16; v = (s >> n) & 0xffff; c = (s >> (n - 1)) & 1; break; } // ASR
      default: v = ((x << n) | (x >>> (16 - n))) & 0xffff; c = v & 1; break;        // ROL
    }
    this.f = (this.f & FI) | zn(v) | (c << 2);
    return v;
  }

  /** Execute ALU op on Rd with src; returns the extra cycles (shift count / multiply). */
  private alu(op: number, d: number, src: number): number {
    const r = this.r;
    const a = r[d];
    switch (op) {
      case 0: r[d] = src; this.f = (this.f & FNZ_KEEP_CV) | zn(src); return 0;          // MOV
      case 1: r[d] = this.add(a, src, 0); return 0;                                       // ADD
      case 2: r[d] = this.add(a, src, (this.f >> 2) & 1); return 0;                       // ADC
      case 3: r[d] = this.sub(a, src, 0); return 0;                                       // SUB
      case 4: r[d] = this.sub(a, src, (this.f >> 2) & 1); return 0;                       // SBC
      case 5: this.sub(a, src, 0); return 0;                                              // CMP
      case 6: { const v = a & src; r[d] = v; this.f = (this.f & FI) | zn(v); return 0; }  // AND
      case 7: { const v = a | src; r[d] = v; this.f = (this.f & FI) | zn(v); return 0; }  // OR
      case 8: { const v = a ^ src; r[d] = v; this.f = (this.f & FI) | zn(v); return 0; }  // XOR
      case 9: this.f = (this.f & FI) | zn(a & src); return 0;                             // TST
      case 10: case 11: case 12: case 13: {                                               // shifts
        const n = src & 15;
        r[d] = this.shift(op, a, n);
        return ALU_EXTRA[op * 17 + n];
      }
      case 14: { // MUL (unsigned): C = product > FFFF
        const v = Math.imul(a, src) & 0xffff;
        r[d] = v;
        this.f = (this.f & FI) | zn(v) | (a * src > 0xffff ? FC : 0);
        return ALU_EXTRA[14 * 17];
      }
      default: { // FMUL (signed 8.8): q = (s(a) × s(src)) >> 8, V = q outside int16
        const q = (((a << 16) >> 16) * ((src << 16) >> 16)) >> 8;
        const v = q & 0xffff;
        r[d] = v;
        this.f = (this.f & FI) | zn(v) | (q < -0x8000 || q > 0x7fff ? FV : 0);
        return ALU_EXTRA[15 * 17];
      }
    }
  }

  private cond(c: number): boolean {
    const f = this.f;
    const z = f & FZ, n = (f >> 1) & 1, cy = f & FC, v = (f >> 3) & 1;
    switch (c) {
      case 0: return true;             // RA
      case 1: return z !== 0;          // EQ
      case 2: return z === 0;          // NE
      case 3: return cy !== 0;         // LO
      case 4: return cy === 0;         // HS
      case 5: return n !== 0;          // MI
      case 6: return n === 0;          // PL
      case 7: return v !== 0;          // VS
      case 8: return v === 0;          // VC
      case 9: return cy === 0 && z === 0;   // HI
      case 10: return cy !== 0 || z !== 0;  // LS
      case 11: return n !== v;         // LT
      case 12: return n === v;         // GE
      case 13: return z === 0 && n === v;   // GT
      default: return z !== 0 || n !== v;   // LE (15 = BSR handled by the caller)
    }
  }

  // -------------------------------------------------------------------------
  // State: [version, mode, eiDelay, 0, R0..R7 (LE words), SP, PC, F]
  serialize(): Uint8Array {
    const b = new Uint8Array(STATE_SIZE);
    b[0] = STATE_VERSION;
    b[1] = MODE_CODES.indexOf(this.mode);
    b[2] = this.eiDelay ? 1 : 0;
    const words = [...this.r, this.sp, this.pc, this.f];
    words.forEach((v, i) => { b[4 + 2 * i] = v & 0xff; b[5 + 2 * i] = (v >> 8) & 0xff; });
    return b;
  }

  deserialize(b: Uint8Array): void {
    if (b.length !== STATE_SIZE || b[0] !== STATE_VERSION || b[1] >= MODE_CODES.length || b[2] > 1)
      throw new Error("Tally.deserialize: not a Tally v1 state");
    const word = (i: number) => b[4 + 2 * i] | (b[5 + 2 * i] << 8);
    for (let i = 0; i < 8; i++) this.r[i] = word(i);
    this.sp = word(8) & 0xfffe;
    this.pc = word(9);
    this.f = word(10) & 0x1f;
    this.mode = MODE_CODES[b[1]];
    this.eiDelay = b[2] === 1;
  }
}
