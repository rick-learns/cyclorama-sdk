// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// cyasm-lite: a deliberately small CYASM subset used only to verify the manual's
// hand-assembled worked examples (docs/manual/examples/*.hex). It is NOT the
// Cyclorama assembler (that is src/asm, built separately); every word it
// produces comes from the enc.* helpers in src/isa/isa.ts.
//
// Supported: labels, local labels, `name = expr` / `.equ`, .org, .word, .byte,
// .fill, .align, every instruction form in docs/spec-notes.md §7, predefined
// I/O register symbols, and the full expression syntax.
import { ALU_OPS, UNARY_OPS, CONDITIONS, enc } from "../../src/isa/isa.ts";
import { REGISTERS } from "../../src/hw/registers.ts";

export class AsmError extends Error {}

export type Statement = { line: number; addr: number; words: number[]; data: boolean; mnemonic: string; firstReg?: number | undefined };
export type Result = { statements: Statement[]; symbols: Map<string, number> };

const REG = /^R([0-7])$/i;
const regNo = (s: string) => { const m = REG.exec(s.trim()); return m ? +m[1] : undefined; };
const ALU = ALU_OPS as readonly string[];
const UNARY = UNARY_OPS as readonly string[];
const COND = CONDITIONS as readonly string[];

// ---------------------------------------------------------------------------
// Expressions (C precedence): unary - ~ < >; * / %; + -; << >>; &; ^; |
type Tok = { t: "num" | "sym" | "op" | "star"; v: string | number };
function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    let m: RegExpExecArray | null;
    const rest = s.slice(i);
    if ((m = /^\$([0-9A-Fa-f]+)/.exec(rest)) || (m = /^0[xX]([0-9A-Fa-f]+)/.exec(rest))) { out.push({ t: "num", v: parseInt(m[1], 16) }); i += m[0].length; continue; }
    if ((m = /^%([01]+)/.exec(rest))) { out.push({ t: "num", v: parseInt(m[1], 2) }); i += m[0].length; continue; }
    if ((m = /^\d+/.exec(rest))) { out.push({ t: "num", v: parseInt(m[0], 10) }); i += m[0].length; continue; }
    if ((m = /^'(.)'/.exec(rest))) { out.push({ t: "num", v: m[1].charCodeAt(0) }); i += 3; continue; }
    if ((m = /^\.?[A-Za-z_][\w.]*/.exec(rest))) { out.push({ t: "sym", v: m[0] }); i += m[0].length; continue; }
    if ((m = /^(<<|>>|[-+*/%&|^~<>()])/.exec(rest))) { out.push({ t: "op", v: m[1] }); i += m[1].length; continue; }
    throw new AsmError(`bad character '${c}' in expression`);
  }
  return out;
}

/** Evaluate; returns undefined if a symbol is not (yet) defined. */
function evaluate(expr: string, lookup: (name: string) => number | undefined, here: number): number | undefined {
  const toks = tokenize(expr);
  let p = 0;
  let unknown = false;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const primary = (): number => {
    const t = toks[p++];
    if (!t) throw new AsmError(`unexpected end of expression '${expr}'`);
    if (t.t === "num") return t.v as number;
    if (t.t === "sym") { const v = lookup(t.v as string); if (v === undefined) { unknown = true; return 0; } return v; }
    if (t.v === "(") { const v = binary(0); if (!(toks[p]?.t === "op" && toks[p].v === ")")) throw new AsmError(`missing ) in '${expr}'`); p++; return v; }
    if (t.v === "*") return here;
    if (t.v === "-") return -unary();
    if (t.v === "~") return ~unary();
    if (t.v === "<") return unary() & 0xff;
    if (t.v === ">") return (unary() >> 8) & 0xff;
    if (t.v === "+") return unary();
    throw new AsmError(`unexpected '${t.v}' in '${expr}'`);
  };
  const unary = () => primary();
  const LEVELS: string[][] = [["|"], ["^"], ["&"], ["<<", ">>"], ["+", "-"], ["*", "/", "%"]];
  const binary = (level: number): number => {
    if (level === LEVELS.length) return unary();
    let v = binary(level + 1);
    while (peek()?.t === "op" && LEVELS[level].includes(peek()!.v as string)) {
      const op = toks[p++].v as string;
      const r = binary(level + 1);
      switch (op) {
        case "|": v |= r; break; case "^": v ^= r; break; case "&": v &= r; break;
        case "<<": v <<= r; break; case ">>": v >>= r; break;
        case "+": v += r; break; case "-": v -= r; break;
        case "*": v *= r; break;
        case "/": if (r === 0) { if (unknown) return 0; throw new AsmError("division by zero"); } v = Math.trunc(v / r); break;
        case "%": if (r === 0) { if (unknown) return 0; throw new AsmError("division by zero"); } v %= r; break;
      }
    }
    return v;
  };
  const v = binary(0);
  if (p !== toks.length || isOp(")")) throw new AsmError(`trailing tokens in '${expr}'`);
  return unknown ? undefined : v;
}

// ---------------------------------------------------------------------------
function splitOperands(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", q = false;
  for (const c of s) {
    if (c === "'" ) q = !q;
    if (!q && (c === "[" || c === "(")) depth++;
    if (!q && (c === "]" || c === ")")) depth--;
    if (!q && c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function stripComment(line: string): string {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "'" || line[i] === '"') q = !q;
    if (!q && line[i] === ";") return line.slice(0, i);
  }
  return line;
}

type Parsed = { line: number; label?: string; constant?: [string, string]; op?: string; args: string[] };

function parse(source: string): Parsed[] {
  const out: Parsed[] = [];
  source.split(/\r?\n/).forEach((raw, i) => {
    let s = stripComment(raw).trim();
    if (!s) return;
    const p: Parsed = { line: i + 1, args: [] };
    const lab = /^(\.?[A-Za-z_][\w]*):/.exec(s);
    if (lab) { p.label = lab[1]; s = s.slice(lab[0].length).trim(); }
    const k = /^([A-Za-z_][\w]*)\s*(?:=|\.equ\b)\s*(.+)$/i.exec(s);
    if (k) p.constant = [k[1], k[2].trim()];
    else if (s) {
      const m = /^(\.?[A-Za-z]+)\s*(.*)$/.exec(s);
      if (!m) throw new AsmError(`line ${i + 1}: cannot parse '${s}'`);
      p.op = m[1].toUpperCase();
      p.args = splitOperands(m[2]);
    }
    out.push(p);
  });
  return out;
}

// ---------------------------------------------------------------------------
export function assemble(source: string): Result {
  const program = parse(source);
  const predefined = new Map(REGISTERS.map(r => [r.name, r.addr]));
  let symbols = new Map<string, number>();
  // Size decisions from pass 1 (MOVQ vs MOV, short vs long displacement) are kept for pass 2.
  const decisions = new Map<number, boolean>();
  let statements: Statement[] = [];

  for (const pass of [1, 2]) {
    const defined = new Map<string, number>();
    let pc = 0, scope = "";
    statements = [];
    const full = (name: string) => (name.startsWith(".") ? scope + name : name);
    const lookup = (name: string) => defined.get(full(name)) ?? (pass === 2 ? symbols.get(full(name)) : undefined) ?? predefined.get(name);
    for (const [idx, st] of program.entries()) {
      const L = st.line;
      const fail = (msg: string): never => { throw new AsmError(`line ${L}: ${msg}`); };
      const val = (e: string): number | undefined => {
        try { return evaluate(e, lookup, pc); } catch (err) { return fail((err as Error).message); }
      };
      const need = (e: string): number => {
        const v = val(e);
        if (v === undefined) { if (pass === 1) return 0; fail(`undefined symbol in '${e}'`); }
        return v!;
      };
      if (st.label) {
        if (!st.label.startsWith(".")) scope = st.label;
        const name = full(st.label);
        if (defined.has(name)) fail(`duplicate label ${name}`);
        defined.set(name, pc);
      }
      if (st.constant) { const v = val(st.constant[1]); if (v !== undefined) defined.set(st.constant[0], v); else if (pass === 2) fail(`undefined constant ${st.constant[0]}`); continue; }
      if (!st.op) continue;
      const op = st.op, args = st.args;
      const emit = (words: number[], data = false, firstReg?: number) => {
        if (!data && pc & 1) fail("instruction at an odd address");
        statements.push({ line: L, addr: pc, words: words.map(w => w & 0xffff), data, mnemonic: op, firstReg });
        pc += words.length * 2;
      };

      // Directives
      if (op === ".ORG") { pc = need(args[0]); continue; }
      if (op === ".BANK") { pc = need(args[0]) === 0 ? 0 : 0x4000; continue; }
      if (op === ".ALIGN") { const n = need(args[0]); pc = Math.ceil(pc / n) * n; continue; }
      if (op === ".WORD") { emit(args.map(need), true); continue; }
      if (op === ".BYTE" || op === ".FILL") {
        const bytes = op === ".BYTE" ? args.map(need) : new Array(need(args[0])).fill(args[1] ? need(args[1]) : 0);
        if (bytes.length === 0) continue;
        const words: number[] = [];
        for (let i = 0; i < bytes.length; i += 2) words.push((bytes[i] & 0xff) | ((bytes[i + 1] ?? 0) & 0xff) << 8);
        if (bytes.length & 1) fail(`${op} must emit an even number of bytes in cyasm-lite`);
        emit(words, true);
        continue;
      }
      if (op.startsWith(".")) fail(`directive ${op} not supported by cyasm-lite`);

      const R = (i: number) => { const r = regNo(args[i] ?? ""); if (r === undefined) fail(`${op}: operand ${i + 1} must be R0-R7, got '${args[i]}'`); return r!; };
      const imm = (i: number) => { const s = args[i] ?? ""; if (!s.startsWith("#")) fail(`${op}: operand ${i + 1} must be #immediate`); return s.slice(1); };
      const argc = (n: number) => { if (args.length !== n) fail(`${op} takes ${n} operand(s)`); };
      const branchDisp = (target: number) => {
        const d = (target - (pc + 2)) / 2;
        if (pass === 2 && (d < -128 || d > 127 || !Number.isInteger(d))) fail(`branch target out of range (${d} words)`);
        return d;
      };
      const isSP = (s: string | undefined) => /^SP$/i.test(s ?? "");

      // Zero-operand and single-register group 0
      if (["NOP", "STOP", "WAI", "RTS", "RTI", "EI", "DI"].includes(op)) { argc(0); emit([enc.unary(UNARY.indexOf(op))]); continue; }
      if (["NOT", "NEG", "INC", "DEC", "SXB", "ZXB", "SWPB", "PUSH", "POP", "GETF", "SETF"].includes(op)) { argc(1); const d = R(0); emit([enc.unary(UNARY.indexOf(op), d)], false, d); continue; }
      if (op === "TRAP") { argc(1); const n = need(imm(0)); if (n < 0 || n > 15) fail("TRAP #n: n must be 0-15"); emit([enc.unary(UNARY.indexOf("TRAP"), 0, n)]); continue; }

      // Branches
      const bc = op === "BCS" ? "LO" : op === "BCC" ? "HS" : op.startsWith("B") ? op.slice(1) : "";
      if (bc && COND.includes(bc)) { argc(1); emit([enc.branch(COND.indexOf(bc), branchDisp(need(args[0])))]); continue; }

      // Jumps and calls
      if (op === "JMP" || op === "CALL") {
        argc(1);
        const ind = /^\[\s*(R[0-7])\s*\]$/i.exec(args[0]);
        if (ind) { const d = regNo(ind[1])!; emit([enc.unary(UNARY.indexOf(op === "JMP" ? "JMPR" : "CALLR"), d)], false, d); }
        else emit([enc.long(op === "JMP" ? 0 : 1), need(args[0])]);
        continue;
      }
      if (op === "JMPT") { argc(2); const d = R(0); emit([enc.long(5, d << 5), need(args[1])], false, d); continue; }
      if (op === "PUSHM" || op === "POPM") {
        let mask = 0;
        for (const a of args) {
          const range = /^R([0-7])\s*-\s*R([0-7])$/i.exec(a);
          if (range) { for (let r = +range[1]; r <= +range[2]; r++) mask |= 1 << r; continue; }
          mask |= 1 << R(args.indexOf(a));
        }
        emit([enc.long(op === "PUSHM" ? 2 : 3, mask)]);
        continue;
      }

      // Stack-pointer forms of MOV/ADD
      if (op === "MOV" && isSP(args[1])) { argc(2); const d = R(0); emit([enc.unary(UNARY.indexOf("MOVFS"), d)], false, d); continue; }
      if (op === "MOV" && isSP(args[0])) { argc(2); const d = R(1); emit([enc.unary(UNARY.indexOf("MOVTS"), d)], false, d); continue; }
      if (op === "ADD" && isSP(args[0])) {
        argc(2); const n = need(imm(1));
        if (pass === 2 && (n & 1 || n < -256 || n > 254)) fail("ADD SP,#n: n must be even, -256..254");
        emit([enc.long(4, n >> 1)]);
        continue;
      }

      // ALU
      const base = op === "MOVW" ? "MOV" : op === "ADDW" ? "ADD" : op === "MOVQ" ? "MOV" : op === "ADDQ" ? "ADD" : op;
      if (ALU.includes(base)) {
        argc(2);
        const d = R(0), aop = ALU.indexOf(base);
        const rs = regNo(args[1]);
        if (rs !== undefined) { if (op !== base) fail(`${op} needs an immediate`); emit([enc.aluR(aop, d, rs)], false, d); continue; }
        const e = imm(1);
        if (["SHL", "SHR", "ASR", "ROL"].includes(op)) {
          const n = need(e);
          if (pass === 2 && (n < 1 || n > 16)) fail(`${op} Rd,#n: n must be 1-16`);
          emit([enc.unary(UNARY.indexOf(op + "I"), d, n - 1)], false, d);
          continue;
        }
        if (base === "MOV" || base === "ADD") {
          if (pass === 1) { const v = val(e); decisions.set(idx, op === "MOVQ" || op === "ADDQ" || (op === base && v !== undefined && v >= -128 && v <= 127)); }
          if (decisions.get(idx)) {
            const v = need(e);
            if (pass === 2 && (v < -128 || v > 127)) fail(`${op}: quick immediate out of range`);
            emit([enc.quick(base === "ADD", d, v)], false, d);
            continue;
          }
        }
        emit([enc.aluI(aop, d), need(e)], false, d);
        continue;
      }

      // Loads and stores
      if (["LD", "ST", "LDB", "STB"].includes(op)) {
        argc(2);
        const d = R(0), byte = op.endsWith("B"), store = op.startsWith("ST"), size = byte ? 1 : 2;
        const m = args[1];
        let mm: RegExpExecArray | null;
        if ((mm = /^\[\s*SP\s*(?:\+\s*(.+))?\]$/i.exec(m))) {
          if (byte) fail("no byte form of [SP+d]");
          const off = mm[1] ? need(mm[1]) : 0;
          if (pass === 2 && (off & 1 || off < 0 || off > 510)) fail("[SP+d]: d must be even, 0..510");
          emit([enc.sprel(d, store, off >> 1)], false, d);
        } else if ((mm = /^\[\s*(R[0-7])\s*\]\+$/i.exec(m))) emit([enc.memx(d, regNo(mm[1])!, byte, store, 2)], false, d);
        else if ((mm = /^-\[\s*(R[0-7])\s*\]$/i.exec(m))) emit([enc.memx(d, regNo(mm[1])!, byte, store, 3)], false, d);
        else if ((mm = /^\[\s*(R[0-7])\s*(?:\+\s*(.+))?\]$/i.exec(m))) {
          const s = regNo(mm[1])!;
          const e = mm[2] ?? "0";
          if (pass === 1) { const v = val(e); decisions.set(idx, v !== undefined && v >= 0 && v <= 63 * size && v % size === 0); }
          if (decisions.get(idx)) emit([enc.mem(byte, store, d, s, need(e) / size)], false, d);
          else emit([enc.memx(d, s, byte, store, 0), need(e)], false, d);
        } else if ((mm = /^\[(.+)\]$/.exec(m))) emit([enc.memx(d, 0, byte, store, 1), need(mm[1])], false, d);
        else fail(`bad memory operand '${m}'`);
        continue;
      }
      fail(`unknown mnemonic ${op}`);
    }
    symbols = defined;
  }
  return { statements, symbols };
}

/** Parse a .hex listing: `AAAA: WWWW WWWW` per line; `;` comments and blank lines ignored. */
export function parseHex(text: string): { addr: number; words: number[] }[] {
  const out: { addr: number; words: number[] }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const s = raw.replace(/;.*$/, "").trim();
    if (!s) return;
    const m = /^([0-9A-F]{4}):((?:\s+[0-9A-F]{4})+)$/.exec(s);
    if (!m) throw new AsmError(`hex line ${i + 1}: expected 'AAAA: WWWW ...' in upper-case hex, got '${raw}'`);
    out.push({ addr: parseInt(m[1], 16), words: m[2].trim().split(/\s+/).map(w => parseInt(w, 16)) });
  });
  return out;
}
