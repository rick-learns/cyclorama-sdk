// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Tally disassembler. Output is CYASM source that re-assembles (at the same
// address) to identical bytes. Words the assembler would never emit — reserved
// encodings, and valid encodings with must-be-zero bits set or an odd word
// displacement — are shown as `.word`.
import { decode, enc, UNARY_OPS } from "../isa/isa.ts";

export type DisLine = { addr: number; words: number[]; text: string };

const hex = (v: number) => "$" + (v & 0xffff).toString(16).toUpperCase().padStart(4, "0");
const R = (n: number) => `R${n}`;

function regList(mask: number): string {
  const parts: string[] = [];
  for (let r = 0; r < 8; r++) {
    if (!(mask & (1 << r))) continue;
    let e = r;
    while (e < 7 && mask & (1 << (e + 1))) e++;
    parts.push(e === r ? R(r) : `${R(r)}-${R(e)}`);
    r = e;
  }
  return parts.join(", ");
}

/**
 * Text for one instruction at `addr`; `ext` is its extension word (if any).
 * Returns undefined when the words must be shown as data.
 */
function text(w: number, ext: number, addr: number): string | undefined {
  const d = decode(w);
  switch (d.kind) {
    case "unary": {
      const name = UNARY_OPS[d.op];
      if (d.op <= 6) return enc.unary(d.op) === w ? name : undefined;
      if (name === "TRAP") return enc.unary(d.op, 0, d.imm) === w ? `TRAP #${d.imm}` : undefined;
      if (name === "SHLI" || name === "SHRI" || name === "ASRI" || name === "ROLI")
        return `${name.slice(0, 3)} ${R(d.d)}, #${d.imm + 1}`;
      if (enc.unary(d.op, d.d) !== w) return undefined;
      if (name === "JMPR") return `JMP [${R(d.d)}]`;
      if (name === "CALLR") return `CALL [${R(d.d)}]`;
      if (name === "MOVFS") return `MOV ${R(d.d)}, SP`;
      if (name === "MOVTS") return `MOV SP, ${R(d.d)}`;
      return `${name} ${R(d.d)}`;
    }
    case "aluR": return enc.aluR(d.op, d.d, d.s) === w ? `${d.mnemonic} ${R(d.d)}, ${R(d.s)}` : undefined;
    case "aluI": return enc.aluI(d.op, d.d) === w ? `${d.mnemonic}W ${R(d.d)}, #${hex(ext)}` : undefined;
    case "quick": return `${d.mnemonic === "ADDQ" ? "ADD" : "MOV"} ${R(d.d)}, #${d.imm}`;
    case "mem": return `${d.mnemonic} ${R(d.d)}, [${R(d.s)}${d.disp ? "+" + d.disp : ""}]`;
    case "memx": {
      const byte = d.mnemonic.endsWith("B"), store = d.mnemonic.startsWith("ST");
      if (enc.memx(d.d, d.mode === 1 ? 0 : d.s, byte, store, d.mode) !== w) return undefined;
      if (d.mode === 0) return !byte && ext & 1 ? undefined : `${d.mnemonic}X ${R(d.d)}, [${R(d.s)}+${hex(ext)}]`;
      if (d.mode === 1) return `${d.mnemonic} ${R(d.d)}, [${hex(ext)}]`;
      if (d.mode === 2) return `${d.mnemonic} ${R(d.d)}, [${R(d.s)}]+`;
      return `${d.mnemonic} ${R(d.d)}, -[${R(d.s)}]`;
    }
    case "sprel": return `${d.mnemonic} ${R(d.d)}, [SP${d.disp ? "+" + d.disp : ""}]`;
    case "branch": return `${d.mnemonic} ${hex(addr + 2 + d.disp * 2)}`;
    case "long": {
      switch (d.op) {
        case 0: case 1: return enc.long(d.op) === w ? `${d.mnemonic} ${hex(ext)}` : undefined;
        case 2: case 3: return d.mask ? `${d.mnemonic} ${regList(d.mask)}` : undefined;
        case 4: return `ADD SP, #${d.imm! * 2}`;
        default: return enc.long(5, d.d! << 5) === w ? `JMPT ${R(d.d!)}, ${hex(ext)}` : undefined;
      }
    }
    default: return undefined;
  }
}

/**
 * Disassemble `count` instructions starting at address `start`. `bytes[i]`
 * holds the byte at address `base + i` (default 0, i.e. a whole address space
 * or a bank 0 image). Stops early at the end of `bytes`.
 */
export function disassemble(bytes: Uint8Array, start: number, count: number, base = 0): DisLine[] {
  const out: DisLine[] = [];
  let off = start - base;
  const rd = (o: number) => bytes[o] | (bytes[o + 1] << 8);
  for (let n = 0; n < count && off >= 0 && off + 1 < bytes.length; n++) {
    const addr = (base + off) & 0xffff;
    const w = rd(off);
    const hasExt = decode(w).ext && off + 3 < bytes.length;
    const words = hasExt ? [w, rd(off + 2)] : [w];
    const t = decode(w).ext && !hasExt ? undefined : text(w, words[1] ?? 0, addr);
    out.push({ addr, words, text: t ?? `.word ${words.map(hex).join(", ")}` });
    off += words.length * 2;
  }
  return out;
}
