// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// CYASM: the Avenell assembler for the Tally CPU (docs/spec-notes.md §7).
//
// Two passes over a statement list built once from the source files (with
// .include expanded and .incbin data read up front, so the passes are pure):
//   pass 1 defines symbols and fixes every statement's size and form
//          (short/long choices use only values known at that point);
//   pass 2 re-evaluates everything with the complete symbol table and emits.
// All encodings come from `enc` in src/isa/isa.ts.
import { enc, ALU_OPS, UNARY_OPS, CONDITIONS } from "../isa/isa.ts";
import { REGISTERS } from "../hw/registers.ts";

export type AsmError = { file: string; line: number; message: string };
export type AsmResult = {
  rom: Uint8Array; symbols: Map<string, number>; listing: string; errors: AsmError[];
  /** The bank of every label (constants have none), for the symbol table (manual ch. 8). */
  labelBanks: Map<string, number>;
  /** Source file and line of each listing line (includes expanded in place). */
  listingSource?: { file: string; line: number }[];
};
export type ReadFile = (path: string) => string | Uint8Array;

const BANK_BYTES = 0x4000;
const MAX_BANKS = 256;
const HEADER_START = 0x10, HEADER_END = 0x40, CHECKSUM_AT = 0x38;

/** Error that aborts the current statement. */
class Fail extends Error {}

type Stmt = {
  seq: number; file: string; line: number; text: string;
  label?: string | undefined;                          // (cleared when the statement fails)
  equ?: { name: string; expr: string } | undefined;
  op?: string | undefined;          // upper-cased mnemonic or directive
  args: string;         // raw operand text
  data?: Uint8Array;    // .incbin contents
  // Decisions fixed in pass 1:
  size: number;         // bytes emitted
  long?: boolean;       // long form chosen (MOV/ADD #n, LD/ST [Rs+d])
  layout?: number | null; // pass-1 value of .org/.bank/.fill/.align/.rom
};

// ---------------------------------------------------------------------------
// Lexical helpers

const REG_RE = /^R([0-7])$/i;
const isRegisterName = (s: string) => REG_RE.test(s) || /^SP$/i.test(s);

/** Remove a `;` comment, respecting string and character literals. */
function stripComment(s: string): string {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "'") {
      const m = /^'(\\.|[^\\'])'/.exec(s.slice(i));
      if (m) i += m[0].length - 1;
    } else if (c === ";") return s.slice(0, i);
  }
  return s;
}

/** Split at top-level commas (outside quotes, (), [] and {}). */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, inStr = false, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === "\\" && i + 1 < s.length) cur += s[++i];
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === "'") {
      const m = /^'(\\.|[^\\'])'/.exec(s.slice(i));
      if (m) { cur += m[0]; i += m[0].length - 1; continue; }
    }
    if (c === '"') inStr = true;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() !== "" || out.length > 0) out.push(cur.trim());
  return out;
}

// The documented escapes only (spec-notes §9.45); \xHH is handled separately.
const ESCAPES: Record<string, number> = { n: 10, "0": 0, "\\": 92, '"': 34, "'": 39 };

/** Decode the body of a string or char literal (without quotes) to byte values. */
function unescape(body: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    let c = body.charCodeAt(i);
    if (body[i] === "\\") {
      const e = body[++i];
      if (e === "x" && /^[0-9A-Fa-f]{2}/.test(body.slice(i + 1, i + 3))) { c = parseInt(body.slice(i + 1, i + 3), 16); i += 2; }
      else if (e !== undefined && e in ESCAPES) c = ESCAPES[e];
      else throw new Fail(`unknown escape sequence '\\${e ?? ""}'`);
    } else if (c < 0x20 || c > 0x7e) throw new Fail(`character '${body[i]}' is not printable ASCII (use an escape)`);
    out.push(c);
  }
  return out;
}

function parseString(s: string): number[] | undefined {
  const m = /^"((?:\\.|[^\\"])*)"$/.exec(s.trim());
  return m ? unescape(m[1]) : undefined;
}

const hex = (v: number, n = 4) => (v >>> 0).toString(16).toUpperCase().padStart(n, "0");

// ---------------------------------------------------------------------------
// Expressions: C precedence, 32-bit signed integer arithmetic.

type Val = { v: number; known: boolean; missing?: string | undefined };
type Ctx = { lookup: (name: string) => number | undefined; here: number; scope: string | null; strict: boolean };

const BIN_PREC: Record<string, number> = { "*": 10, "/": 10, "%": 10, "+": 9, "-": 9, "<<": 8, ">>": 8, "&": 7, "^": 6, "|": 5 };

class ExprParser {
  s: string; i = 0; ctx: Ctx;
  constructor(s: string, ctx: Ctx) { this.s = s; this.ctx = ctx; }

  ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  fail(msg: string): never { throw new Fail(`${msg} in expression '${this.s.trim()}'`); }

  parse(): Val {
    this.ws();
    if (this.i >= this.s.length) this.fail("missing value");
    const v = this.binary(0);
    this.ws();
    if (this.i < this.s.length) this.fail(`unexpected '${this.s[this.i]}'`);
    return v;
  }

  peekBinOp(): string | undefined {
    this.ws();
    const two = this.s.slice(this.i, this.i + 2);
    if (two === "<<" || two === ">>") return two;
    const one = this.s[this.i];
    return one !== undefined && one in BIN_PREC ? one : undefined;
  }

  binary(minPrec: number): Val {
    let left = this.unary();
    for (;;) {
      const op = this.peekBinOp();
      if (op === undefined || BIN_PREC[op] < minPrec) return left;
      this.i += op.length;
      const right = this.binary(BIN_PREC[op] + 1);
      left = this.apply(op, left, right);
    }
  }

  apply(op: string, a: Val, b: Val): Val {
    const known = a.known && b.known, missing = a.missing ?? b.missing;
    const x = a.v, y = b.v;
    let v: number;
    switch (op) {
      case "*": v = Math.imul(x, y); break;
      case "/": case "%":
        if (y === 0) {
          if (known && this.ctx.strict) this.fail("division by zero");
          return { v: 0, known: false, missing };
        }
        v = op === "/" ? Math.trunc(x / y) : x % y; break;
      case "+": v = x + y; break;
      case "-": v = x - y; break;
      case "<<": v = x << (y & 31); break;   // count & 31 (spec-notes §9.45)
      case ">>": v = x >> (y & 31); break;
      case "&": v = x & y; break;
      case "^": v = x ^ y; break;
      default: v = x | y;
    }
    return { v: v | 0, known, missing };
  }

  unary(): Val {
    this.ws();
    const c = this.s[this.i];
    if (c === "-" || c === "+" || c === "~" || c === "<" || c === ">") {
      this.i++;
      const a = this.unary();
      const v = c === "-" ? -a.v : c === "+" ? a.v : c === "~" ? ~a.v : c === "<" ? a.v & 0xff : (a.v >> 8) & 0xff;
      return { v: v | 0, known: a.known, missing: a.missing };
    }
    return this.primary();
  }

  primary(): Val {
    this.ws();
    const rest = this.s.slice(this.i);
    let m: RegExpExecArray | null;
    const num = (text: string, v: number): Val => {
      // A literal must fit in 32 bits, unsigned (spec-notes §11.81); it is never wrapped.
      if (v > 0xffffffff) this.fail(`numeric literal ${text} does not fit in 32 bits`);
      this.i += text.length;
      return { v: v | 0, known: true };
    };
    if (rest[0] === "(") {
      this.i++;
      const v = this.binary(0);
      this.ws();
      if (this.s[this.i] !== ")") this.fail("missing ')'");
      this.i++;
      return v;
    }
    if ((m = /^\$([0-9A-Fa-f]+)/.exec(rest))) return num(m[0], parseInt(m[1], 16));
    if ((m = /^0[xX]([0-9A-Fa-f]+)/.exec(rest))) return num(m[0], parseInt(m[1], 16));
    if ((m = /^%([01]+)/.exec(rest))) return num(m[0], parseInt(m[1], 2));
    if ((m = /^\d+/.exec(rest))) {
      if (/^\d+[A-Za-z_]/.test(rest)) this.fail("malformed number");
      return num(m[0], parseInt(m[0], 10));
    }
    if ((m = /^'(\\.|[^\\'])'/.exec(rest))) return num(m[0], unescape(m[1])[0]);
    if (rest[0] === "*") return num("*", this.ctx.here);
    if ((m = /^\.?[A-Za-z_][\w.]*/.exec(rest))) {
      this.i += m[0].length;
      const name = m[0];
      if (isRegisterName(name)) this.fail(`register ${name} cannot be used as a value`);
      const full = qualify(name, this.ctx.scope);
      const v = this.ctx.lookup(full);
      return v === undefined ? { v: 0, known: false, missing: full } : { v, known: true };
    }
    if (rest.length === 0) this.fail("missing value");
    this.fail(`unexpected '${rest[0]}'`);
  }
}

function qualify(name: string, scope: string | null): string {
  if (!name.startsWith(".")) return name;
  if (scope === null) throw new Fail(`local label '${name}' used before any non-local label`);
  return scope + name;
}

// ---------------------------------------------------------------------------
// Operands

type Operand =
  | { k: "reg"; n: number }
  | { k: "sp" }
  | { k: "imm"; e: string }
  | { k: "ind"; r: number; e: string | null }   // [Rs] / [Rs+e]
  | { k: "spind"; e: string | null }            // [SP] / [SP+e]
  | { k: "abs"; e: string }                     // [e]
  | { k: "post"; r: number }                    // [Rs]+
  | { k: "pre"; r: number }                     // -[Rs]
  | { k: "expr"; e: string };

function parseOperand(text: string): Operand {
  const t = text.trim();
  let m: RegExpExecArray | null;
  if ((m = REG_RE.exec(t))) return { k: "reg", n: +m[1] };
  if (/^SP$/i.test(t)) return { k: "sp" };
  if (t.startsWith("#")) return { k: "imm", e: t.slice(1) };
  if ((m = /^-\s*\[\s*R([0-7])\s*\]$/i.exec(t))) return { k: "pre", r: +m[1] };
  if ((m = /^\[\s*R([0-7])\s*\]\s*\+$/i.exec(t))) return { k: "post", r: +m[1] };
  if ((m = /^\[(.*)\]$/s.exec(t))) {
    const inner = m[1].trim();
    let r: RegExpExecArray | null;
    if ((r = /^(R[0-7]|SP)$/i.exec(inner))) return /^SP$/i.test(r[1]) ? { k: "spind", e: null } : { k: "ind", r: +r[1][1], e: null };
    if ((r = /^(R[0-7]|SP)\s*([+-].*)$/is.exec(inner)))
      return /^SP$/i.test(r[1]) ? { k: "spind", e: r[2] } : { k: "ind", r: +r[1][1], e: r[2] };
    return { k: "abs", e: inner };
  }
  return { k: "expr", e: t };
}

const describe = (o: Operand) => ({ reg: "a register", sp: "SP", imm: "an immediate", ind: "[Rs+d]", spind: "[SP+d]", abs: "[address]", post: "[Rs]+", pre: "-[Rs]", expr: "an expression" })[o.k];

// ---------------------------------------------------------------------------
// Instruction tables

const U = (name: string) => UNARY_OPS.indexOf(name as (typeof UNARY_OPS)[number]);
const ALU = new Map<string, number>(ALU_OPS.map((m, i) => [m, i]));
const ZERO_OPS = new Set(["NOP", "STOP", "WAI", "RTS", "RTI", "EI", "DI"]);
const REG_OPS = new Set(["NOT", "NEG", "INC", "DEC", "SXB", "ZXB", "SWPB", "PUSH", "POP", "GETF", "SETF", "MOVFS", "MOVTS"]);
const SHIFT_IMM: Record<string, string> = { SHL: "SHLI", SHR: "SHRI", ASR: "ASRI", ROL: "ROLI" };
const SHIFT_RAW = new Set(Object.values(SHIFT_IMM));
const BRANCHES = new Map<string, number>([...CONDITIONS.map((c, i): [string, number] => ["B" + c, i]), ["BCS", 3], ["BCC", 4]]);
const MEM_OPS: Record<string, { byte: boolean; store: boolean; forceX: boolean }> = {};
for (const byte of [false, true]) for (const store of [false, true]) for (const forceX of [false, true])
  MEM_OPS[(store ? "ST" : "LD") + (byte ? "B" : "") + (forceX ? "X" : "")] = { byte, store, forceX };

// Predefined I/O register names are case-insensitive (spec-notes §11.80), so they are keyed upper case.
const PREDEFINED = new Map<string, number>(REGISTERS.map((r) => [r.name.toUpperCase(), r.addr]));

function isPow2(n: number) { return n > 0 && (n & (n - 1)) === 0; }

// ---------------------------------------------------------------------------
// Source loading

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? "" : p.slice(0, i + 1);
}
function resolvePath(from: string, name: string): string {
  if (/^([A-Za-z]:)?[\\/]/.test(name)) return name;
  const parts: string[] = [];
  for (const seg of (dirname(from) + name).split(/[\\/]/)) {
    if (seg === "." ) continue;
    if (seg === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}
function toText(content: string | Uint8Array): string {
  const s = typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

// ---------------------------------------------------------------------------

type Sym = { value: number | undefined; kind: "label" | "const"; seq: number; bank?: number };
type Bank = { data: Uint8Array; used: Uint8Array };
type HeaderInfo = { seq: number };

class Assembler {
  readFile: ReadFile;
  stmts: Stmt[] = [];
  errors: { seq: number; e: AsmError }[] = [];
  syms = new Map<string, Sym>();
  pass = 1;
  cur!: Stmt;
  // location
  bank = 0;
  pc = 0;
  locs = new Map<number, number>();
  scope: string | null = null;
  // output
  banks = new Map<number, Bank>();
  highestBank = 0;
  romBanks: { n: number; st: Stmt } | null = null;
  header: HeaderInfo | null = null;
  listing: string[] = [];
  emitted: number[] = [];

  constructor(readFile: ReadFile) { this.readFile = readFile; }

  // -- errors ---------------------------------------------------------------
  report(st: { seq: number; file: string; line: number }, message: string) {
    this.errors.push({ seq: st.seq, e: { file: st.file, line: st.line, message } });
  }
  /** Error found while encoding: reported in pass 2 only (pass 1 may lack symbols). */
  err(message: string) { if (this.pass === 2) this.report(this.cur, message); }
  /** Layout error: reported in pass 1 only. */
  err1(message: string) { if (this.pass === 1) this.report(this.cur, message); }

  // -- loading --------------------------------------------------------------
  load(file: string, text: string, stack: string[]) {
    const lines = text.split(/\r?\n/);
    lines.forEach((raw, idx) => {
      const st: Stmt = { seq: this.stmts.length, file, line: idx + 1, text: raw.replace(/\s+$/, ""), args: "", size: 0 };
      this.stmts.push(st);
      this.cur = st;
      try {
        this.parseLine(st);
        if (st.op === ".INCLUDE" || st.op === ".INCBIN") {
          const name = parseString(st.args);
          if (name === undefined) throw new Fail(`${st.op.toLowerCase()} needs a quoted file name`);
          const path = resolvePath(file, String.fromCharCode(...name));
          if (st.op === ".INCLUDE" && stack.includes(path)) throw new Fail(`recursive .include of '${path}'`);
          if (stack.length > 32) throw new Fail("includes nested too deeply");
          let content: string | Uint8Array;
          try { content = this.readFile(path); }
          catch (e) { throw new Fail(`cannot read file '${path}': ${e instanceof Error ? e.message : String(e)}`); }
          if (st.op === ".INCBIN") st.data = toBytes(content);
          else this.load(path, toText(content), [...stack, path]);
        }
      } catch (e) {
        if (!(e instanceof Fail)) throw e;
        this.report(st, e.message);
        st.op = undefined; st.label = undefined; st.equ = undefined;
      }
    });
  }

  parseLine(st: Stmt) {
    let rest = stripComment(st.text);
    const lm = /^\s*(\.?[A-Za-z_][\w.]*)\s*:/.exec(rest);
    if (lm) { st.label = lm[1]; rest = rest.slice(lm[0].length); }
    rest = rest.trim();
    if (rest === "") return;
    let m: RegExpExecArray | null;
    if ((m = /^(\.?[A-Za-z_][\w.]*)\s*=\s*(.*)$/s.exec(rest)) || (m = /^(\.?[A-Za-z_][\w.]*)\s+\.equ\b\s*(.*)$/is.exec(rest))) {
      if (st.label) throw new Fail("a constant definition cannot also have a label");
      st.equ = { name: m[1], expr: m[2] };
      return;
    }
    if ((m = /^(\.?[A-Za-z_][\w.]*)\s*(.*)$/s.exec(rest))) { st.op = m[1].toUpperCase(); st.args = m[2].trim(); return; }
    throw new Fail(`cannot parse '${rest}'`);
  }

  // -- symbols --------------------------------------------------------------
  lookup = (name: string): number | undefined => {
    const s = this.syms.get(name);
    if (s) return s.value;
    return PREDEFINED.get(name.toUpperCase());
  };

  define(rawName: string, value: number | undefined, kind: "label" | "const") {
    if (isRegisterName(rawName)) throw new Fail(`'${rawName}' is a register name and cannot be defined as a symbol`);
    const name = qualify(rawName, this.scope);
    if (PREDEFINED.has(name.toUpperCase())) throw new Fail(`'${name}' is a predefined I/O register symbol (register names are not case-sensitive)`);
    const prev = this.syms.get(name);
    if (prev && prev.seq !== this.cur.seq) {
      const where = this.stmts[prev.seq];
      this.err1(`symbol '${name}' already defined at ${where.file}:${where.line}`);
      return;
    }
    if (this.pass === 2 && kind === "label" && prev && prev.value !== value)
      throw new Fail(`internal phase error: '${name}' moved from $${hex(prev.value ?? 0)} to $${hex(value ?? 0)}`);
    this.syms.set(name, kind === "label" ? { value, kind, seq: this.cur.seq, bank: this.bank } : { value, kind, seq: this.cur.seq });
  }

  defineLabel(label: string) {
    this.define(label, this.pc, "label");
    if (!label.startsWith(".")) this.scope = label;
  }

  // -- expressions ----------------------------------------------------------
  evalRaw(e: string, here: number): Val {
    return new ExprParser(e, { lookup: this.lookup, here, scope: this.scope, strict: this.pass === 2 }).parse();
  }
  /** Evaluate; in pass 2 an undefined symbol is an error. */
  value(e: string): Val {
    const v = this.evalRaw(e, this.here);
    if (!v.known && this.pass === 2) throw new Fail(`undefined symbol '${v.missing ?? "?"}'`);
    return v;
  }
  /** A value that must be known in pass 1 (it affects layout). */
  layoutValue(e: string, what: string): number | null {
    const st = this.cur;
    if (this.pass === 2) return st.layout ?? null;
    let v: Val;
    try { v = this.evalRaw(e, this.here); }
    catch (x) {
      // Pass 2 does not re-evaluate layout values, so a malformed one is reported now.
      if (!(x instanceof Fail)) throw x;
      this.err1(x.message);
      st.layout = null;
      return null;
    }
    if (!v.known) {
      this.err1(`${what} must be defined before use (value needed in pass 1; '${v.missing ?? "?"}' is not yet defined)`);
      st.layout = null;
    } else st.layout = v.v;
    return st.layout;
  }
  here = 0;

  // -- range checks (record error, keep going) ------------------------------
  range(v: number, lo: number, hi: number, what: string): number {
    if (v < lo || v > hi) this.err(`${what} ${v} out of range (${lo}..${hi})`);
    return v;
  }
  imm16(v: number, what = "immediate"): number { return this.range(v, -32768, 65535, what) & 0xffff; }
  /** Every 16-bit field accepts -32768..65535 and stores the value mod 65536 (spec-notes §11.77). */
  addr16(v: number, what = "address"): number { return this.imm16(v, what); }

  // -- output ---------------------------------------------------------------
  bankBase(n: number) { return n === 0 ? 0 : 0x4000; }
  getBank(n: number): Bank {
    let b = this.banks.get(n);
    if (!b) { b = { data: new Uint8Array(BANK_BYTES).fill(0xff), used: new Uint8Array(BANK_BYTES) }; this.banks.set(n, b); }
    return b;
  }

  /** Write bytes at a bank-local address (pass 2), checking range and overlap. */
  writeAt(bankNo: number, addr: number, bytes: ArrayLike<number>) {
    if (this.pass !== 2 || bytes.length === 0) return;
    const base = this.bankBase(bankNo);
    const b = this.getBank(bankNo);
    this.highestBank = Math.max(this.highestBank, bankNo);
    let rangeReported = false, overlapReported = false;
    for (let i = 0; i < bytes.length; i++) {
      const a = addr + i, off = a - base;
      if (off < 0 || off >= BANK_BYTES) {
        if (!rangeReported) this.err(`bank ${bankNo} overflow: address $${hex(a)} is outside $${hex(base)}-$${hex(base + BANK_BYTES - 1)}`);
        rangeReported = true;
        continue;
      }
      if (b.used[off]) {
        if (!overlapReported) this.err(`overlaps previously emitted bytes at $${hex(a)} (bank ${bankNo})`);
        overlapReported = true;
        continue;
      }
      b.used[off] = 1;
      b.data[off] = bytes[i] & 0xff;
    }
  }

  emitBytes(bytes: number[]) {
    this.writeAt(this.bank, this.pc, bytes);
    if (this.pass === 2) this.emitted.push(...bytes);
    this.pc += bytes.length;
  }

  // -- passes ---------------------------------------------------------------
  runPass(pass: number) {
    this.pass = pass;
    this.bank = 0; this.pc = 0; this.scope = null; this.locs.clear();
    for (const st of this.stmts) {
      this.cur = st;
      this.here = this.pc;
      this.emitted = [];
      const startBank = this.bank, startPc = this.pc;
      let isCode = false;
      try {
        // A label on a .org/.align/.bank line takes the address after the directive (spec-notes §11.79).
        const labelAfter = st.op === ".ORG" || st.op === ".ALIGN" || st.op === ".BANK";
        if (st.label !== undefined && !labelAfter) this.defineLabel(st.label);
        if (st.equ) {
          const v = this.evalRaw(st.equ.expr, this.here);
          if (!v.known && pass === 2) throw new Fail(`undefined symbol '${v.missing ?? "?"}'`);
          this.define(st.equ.name, v.known ? v.v : undefined, "const");
        }
        if (st.op !== undefined) {
          if (labelAfter) {
            let failure: unknown;
            try { this.directive(st); } catch (e) { failure = e; }
            if (st.label !== undefined) this.defineLabel(st.label);
            if (failure !== undefined) throw failure;
          } else if (st.op.startsWith(".")) this.directive(st);
          else {
            isCode = true;
            if (pass === 2 && (this.pc & 1)) this.err(`instruction at odd address $${hex(this.pc)}`);
            const words = this.instruction(st);
            const bytes = words.flatMap((w) => [w & 0xff, (w >> 8) & 0xff]);
            if (pass === 1) st.size = bytes.length;
            else if (bytes.length !== st.size) throw new Fail("internal phase error: instruction size changed between passes");
            this.emitBytes(bytes);
          }
        }
      } catch (e) {
        if (!(e instanceof Fail)) throw e;
        // Reported in pass 2 only, where every symbol is known.
        if (pass === 2) this.report(st, e.message);
        if (pass === 1 && isCode && st.size === 0) st.size = 2;
        // Keep the layout identical to pass 1 (no directive throws after moving the location).
        this.pc = startPc + st.size;
      }
      if (pass === 2) this.listLine(st, startBank, startPc, isCode);
    }
  }

  listLine(st: Stmt, bank: number, pc: number, isCode: boolean) {
    let codeText: string;
    const b = this.emitted;
    if (isCode) {
      const words: string[] = [];
      for (let i = 0; i + 1 < b.length; i += 2) words.push(hex(b[i] | (b[i + 1] << 8)));
      codeText = words.join(" ");
    } else if (st.equ) {
      let v: number | undefined;
      try { v = this.syms.get(qualify(st.equ.name, this.scope))?.value; } catch { v = undefined; }
      codeText = v === undefined ? "" : `= $${hex(v)}`;
    } else {
      codeText = b.slice(0, 8).map((x) => hex(x, 2)).join(" ") + (b.length > 8 ? " ..." : "");
    }
    const loc = st.op !== undefined || st.label !== undefined ? `${hex(bank, 2)}:${hex(pc)}` : "       ";
    this.listing.push(`${loc}  ${codeText.padEnd(24)}${st.text}`);
  }

  // -- directives -----------------------------------------------------------
  directive(st: Stmt) {
    const args = st.args === "" ? [] : splitArgs(st.args);
    const need = (n: number) => { if (args.length !== n) throw new Fail(`${st.op!.toLowerCase()} expects ${n} operand${n === 1 ? "" : "s"}`); };
    switch (st.op) {
      case ".ORG": {
        need(1);
        const v = this.layoutValue(args[0], ".org address");
        if (v === null) return;
        const base = this.bankBase(this.bank);
        if (v < base || v >= base + BANK_BYTES) {
          this.err1(`.org $${hex(v)} is outside bank ${this.bank} ($${hex(base)}-$${hex(base + BANK_BYTES - 1)})`);
          return;
        }
        this.pc = v;
        return;
      }
      case ".BANK": {
        need(1);
        const v = this.layoutValue(args[0], ".bank number");
        if (v === null) return;
        if (v < 0 || v >= MAX_BANKS) { this.err1(`bank ${v} out of range (0..${MAX_BANKS - 1})`); return; }
        this.locs.set(this.bank, this.pc);
        this.bank = v;
        this.highestBank = Math.max(this.highestBank, v);
        this.pc = this.locs.get(v) ?? this.bankBase(v);
        return;
      }
      case ".WORD": {
        if (args.length === 0) throw new Fail(".word needs at least one value");
        const out: number[] = [];
        for (const a of args) {
          const v = this.pass === 2 ? this.imm16(this.value(a).v, "word value") : 0;
          out.push(v & 0xff, v >> 8);
        }
        this.data(st, out);
        return;
      }
      case ".BYTE": case ".ASCII": case ".ASCIZ": {
        if (args.length === 0) throw new Fail(`${st.op.toLowerCase()} needs at least one value`);
        const out: number[] = [];
        for (const a of args) {
          const s = parseString(a);
          if (s) out.push(...s);
          else if (st.op !== ".BYTE") throw new Fail(`${st.op.toLowerCase()} expects a quoted string`);
          else out.push(this.pass === 2 ? this.range(this.value(a).v, -128, 255, "byte value") & 0xff : 0);
        }
        if (st.op === ".ASCIZ") out.push(0);
        this.data(st, out);
        return;
      }
      case ".FILL": {
        if (args.length < 1 || args.length > 2) throw new Fail(".fill expects count[, value]");
        const n = this.layoutValue(args[0], ".fill count");
        if (n === null) return;
        if (n < 0 || n > BANK_BYTES) { this.err1(`.fill count ${n} out of range (0..${BANK_BYTES})`); return; }
        const v = args.length > 1 && this.pass === 2 ? this.range(this.value(args[1]).v, -128, 255, "fill value") & 0xff : 0;
        this.data(st, new Array<number>(n).fill(v));
        return;
      }
      case ".ALIGN": {
        need(1);
        const n = this.layoutValue(args[0], ".align boundary");
        if (n === null) return;
        if (!isPow2(n) || n > BANK_BYTES) { this.err1(`.align ${n}: boundary must be a power of two (1..${BANK_BYTES})`); return; }
        this.pc = Math.ceil(this.pc / n) * n;
        return;
      }
      case ".INCLUDE": return; // expanded while loading
      case ".INCBIN": this.data(st, Array.from(st.data ?? [])); return;
      case ".HEADER": this.headerDirective(args); return;
      case ".ROM": {
        need(1);
        const n = this.layoutValue(args[0], ".rom size");
        if (n === null || this.pass === 2) return;
        if (this.romBanks) { this.err1(".rom given more than once"); return; }
        if (!isPow2(n) || n > MAX_BANKS) { this.err1(`.rom ${n}: ROM size in banks must be a power of two (1..${MAX_BANKS})`); return; }
        this.romBanks = { n, st };
        return;
      }
      case ".EQU": throw new Fail(".equ needs a name: write 'name .equ value'");
      default: throw new Fail(`unknown directive '${st.op!.toLowerCase()}'`);
    }
  }

  data(st: Stmt, bytes: number[]) {
    if (this.pass === 1) st.size = bytes.length;
    this.emitBytes(bytes);
  }

  headerDirective(args: string[]) {
    if (this.pass === 1) return;
    if (this.header) throw new Fail(`.header given more than once`);
    this.header = { seq: this.cur.seq };
    const f = { title: [] as number[], dev: 0, date: 0, version: 0, ram: 0, generation: 0 };
    const seen = new Set<string>();
    for (const a of args) {
      const m = /^([A-Za-z]+)\s*=\s*(.*)$/s.exec(a);
      if (!m) throw new Fail(`.header: expected key=value, got '${a}'`);
      const key = m[1].toLowerCase();
      if (seen.has(key)) throw new Fail(`.header: '${key}' given twice`);
      seen.add(key);
      const num = () => this.value(m[2]).v;
      const bcd = (v: number, digits: number, what: string) => {
        for (let i = 0; i < digits; i++) if (((v >>> (i * 4)) & 15) > 9) { this.err(`.header: ${what} $${hex(v, digits)} is not valid BCD`); break; }
      };
      switch (key) {
        case "title": {
          const s = parseString(m[2]);
          if (!s) throw new Fail(".header: title must be a quoted string");
          // Printable ASCII after escape processing (spec-notes §11.73): "\x80" or "\0" is an error.
          const bad = s.find((c) => c < 0x20 || c > 0x7e);
          if (bad !== undefined) throw new Fail(`.header: title character $${hex(bad, 2)} is not printable ASCII ($20-$7E)`);
          if (s.length > 24) this.err(`.header: title is ${s.length} characters; at most 24 allowed`);
          f.title = s.slice(0, 24);
          break;
        }
        case "dev": f.dev = this.range(num(), 0, 0xffff, ".header dev"); break;
        case "date": { const v = num() >>> 0; bcd(v, 8, "date"); f.date = v; break; }
        case "version": f.version = this.range(num(), 0, 0xffff, ".header version"); bcd(f.version, 4, "version"); break;
        case "ram": f.ram = this.range(num(), 0, 1, ".header ram"); break;
        case "generation": f.generation = this.range(num(), 0, 1, ".header generation"); break;
        default: throw new Fail(`.header: unknown field '${key}' (title, dev, date, version, ram, generation)`);
      }
    }
    // Every header byte not set below, including the reserved 003A-003F, is written as 0 (spec-notes §11.73).
    const h = new Array<number>(HEADER_END - HEADER_START).fill(0);
    const put = (at: number, ...bytes: number[]) => bytes.forEach((b, i) => { h[at - HEADER_START + i] = b & 0xff; });
    put(0x10, ...[..."CYCL"].map((c) => c.charCodeAt(0)));
    put(0x14, 1);
    put(0x15, 0); // size: filled in at the end
    put(0x16, f.ram);
    put(0x17, f.generation);
    put(0x18, ...f.title, ...new Array<number>(24 - f.title.length).fill(0x20));
    put(0x30, f.dev, f.dev >> 8);
    put(0x32, f.date, f.date >>> 8, f.date >>> 16, f.date >>> 24);
    put(0x36, f.version, f.version >> 8);
    this.writeAt(0, HEADER_START, h);
  }

  // -- instructions ---------------------------------------------------------
  instruction(st: Stmt): number[] {
    const op = st.op!;
    const argText = st.args;
    const raw = argText === "" ? [] : splitArgs(argText);
    const ops = () => raw.map(parseOperand);
    const count = (n: number) => {
      if (raw.length !== n) throw new Fail(`${op} expects ${n} operand${n === 1 ? "" : "s"}, got ${raw.length}`);
      return ops();
    };
    const regOf = (o: Operand): number => {
      if (o.k !== "reg") throw new Fail(`${op}: expected a register R0-R7, got ${describe(o)}`);
      return o.n;
    };
    const immOf = (o: Operand): Val => {
      if (o.k !== "imm") throw new Fail(`${op}: expected an immediate '#value', got ${describe(o)}`);
      return this.value(o.e);
    };
    const exprOf = (o: Operand): Val => {
      if (o.k !== "expr") throw new Fail(`${op}: expected an address expression, got ${describe(o)}`);
      return this.value(o.e);
    };

    if (ZERO_OPS.has(op)) { count(0); return [enc.unary(U(op))]; }
    if (op === "TRAP") { const [a] = count(1); return [enc.unary(U("TRAP"), 0, this.range(immOf(a).v, 0, 15, "TRAP number"))]; }
    if (REG_OPS.has(op)) { const [a] = count(1); return [enc.unary(U(op), regOf(a))]; }
    if (SHIFT_RAW.has(op)) { const [a, b] = count(2); return [this.shiftImm(op, regOf(a), immOf(b))]; }
    if (op === "JMPR" || op === "CALLR") {
      const [a] = count(1);
      const r = a.k === "ind" && a.e === null ? a.r : regOf(a);
      return [enc.unary(U(op), r)];
    }
    if (op === "MOVQ" || op === "ADDQ") {
      const [a, b] = count(2);
      return [enc.quick(op === "ADDQ", regOf(a), this.range(immOf(b).v, -128, 127, `${op} immediate`))];
    }
    if (op === "ADDSP") { const [a] = count(1); return [this.addsp(immOf(a))]; }

    // ALU: op / opW
    const forcedW = op.endsWith("W") && ALU.has(op.slice(0, -1));
    if (ALU.has(op) || forcedW) {
      const base = forcedW ? op.slice(0, -1) : op;
      const aluOp = ALU.get(base)!;
      const [a, b] = count(2);
      if (!forcedW) {
        if (base === "MOV" && a.k === "reg" && b.k === "sp") return [enc.unary(U("MOVFS"), a.n)];
        if (base === "MOV" && a.k === "sp" && b.k === "reg") return [enc.unary(U("MOVTS"), b.n)];
        if (base === "ADD" && a.k === "sp") return [this.addsp(immOf(b))];
      }
      const d = regOf(a);
      if (b.k === "reg") {
        if (forcedW) throw new Fail(`${op} takes an immediate operand; use ${base} Rd, Rs for registers`);
        return [enc.aluR(aluOp, d, b.n)];
      }
      const v = immOf(b);
      if (forcedW && base in SHIFT_IMM && v.known && (v.v < 0 || v.v > 15))
        throw new Fail(`${op} count ${v.v} out of range 0..15 (spec-notes §10.57)`);
      if (forcedW) return [enc.aluI(aluOp, d), this.imm16(v.v)];
      if (base in SHIFT_IMM) return [this.shiftImm(SHIFT_IMM[base], d, v)];
      if (base === "MOV" || base === "ADD") {
        if (this.pass === 1) st.long = !(v.known && v.v >= -128 && v.v <= 127);
        if (!st.long) return [enc.quick(base === "ADD", d, v.v)];
      }
      return [enc.aluI(aluOp, d), this.imm16(v.v)];
    }

    if (op in MEM_OPS) return this.memory(st, op, count(2));

    const cond = BRANCHES.get(op);
    if (cond !== undefined) {
      const [a] = count(1);
      const t = exprOf(a);
      let disp = 0;
      if (this.pass === 2) {
        let diff = (t.v - (this.pc + 2)) & 0xffff;
        if (diff >= 0x8000) diff -= 0x10000;
        if (diff & 1) this.err(`${op} target $${hex(t.v)} is at an odd offset from the branch (targets must be word aligned)`);
        disp = diff >> 1;
        if (disp < -128 || disp > 127) this.err(`${op} target $${hex(t.v)} out of range (${disp} words; branches reach -128..127 words)`);
      }
      return [enc.branch(cond, disp)];
    }

    if (op === "JMP" || op === "CALL") {
      const [a] = count(1);
      if (a.k === "ind" && a.e === null) return [enc.unary(U(op === "JMP" ? "JMPR" : "CALLR"), a.r)];
      if (a.k === "reg") throw new Fail(`${op} through a register is written ${op} [R${a.n}]`);
      return [enc.long(op === "JMP" ? 0 : 1), this.addr16(exprOf(a).v, `${op} target`)];
    }
    if (op === "PUSHM" || op === "POPM") return [enc.long(op === "PUSHM" ? 2 : 3, this.regList(op, argText))];
    if (op === "JMPT") {
      const [a, b] = count(2);
      return [enc.long(5, regOf(a) << 5), this.addr16(exprOf(b).v, "JMPT table address")];
    }
    throw new Fail(`unknown mnemonic '${op}'`);
  }

  shiftImm(rawOp: string, d: number, v: Val): number {
    const n = this.range(v.v, 1, 16, `${rawOp.slice(0, 3)} count (1..16)`);
    return enc.unary(U(rawOp), d, (n - 1) & 15);
  }

  addsp(v: Val): number {
    const n = this.range(v.v, -256, 254, "stack adjustment");
    if (n & 1) this.err(`stack adjustment ${n} must be even`);
    return enc.long(4, n >> 1);
  }

  regList(op: string, text: string): number {
    const body = text.trim().replace(/^\{(.*)\}$/s, "$1").trim();
    if (body === "") throw new Fail(`${op} needs a register list such as R0,R3-R5`);
    let mask = 0;
    for (const item of body.split(",")) {
      const m = /^\s*R([0-7])\s*(?:-\s*R([0-7])\s*)?$/i.exec(item);
      if (!m) throw new Fail(`${op}: bad register list item '${item.trim()}'`);
      const lo = +m[1], hi = m[2] === undefined ? lo : +m[2];
      if (hi < lo) throw new Fail(`${op}: register range R${lo}-R${hi} must be ascending`);
      for (let r = lo; r <= hi; r++) mask |= 1 << r;
    }
    return mask;
  }

  memory(st: Stmt, op: string, [a, m]: Operand[]): number[] {
    const { byte, store, forceX } = MEM_OPS[op];
    if (a.k !== "reg") throw new Fail(`${op}: first operand must be a register (${store ? "ST Rs, [...]" : "LD Rd, [...]"}), got ${describe(a)}`);
    const d = a.n;
    const base = op.replace(/X$/, "");
    if (forceX && m.k !== "ind") throw new Fail(`${op} forces the [Rs+d16] form; use ${base} for ${describe(m)}`);
    switch (m.k) {
      case "ind": {
        const v: Val = m.e === null ? { v: 0, known: true } : this.value(m.e);
        if (!byte && v.known && (v.v & 1)) this.err(`odd displacement ${v.v} for word access ${op} (word displacements must be even)`);
        if (this.pass === 1) {
          const fits = v.known && (byte ? v.v >= 0 && v.v <= 63 : v.v >= 0 && v.v <= 126 && (v.v & 1) === 0);
          st.long = forceX || !fits;
        }
        if (!st.long) return [enc.mem(byte, store, d, m.r, byte ? v.v : v.v >> 1)];
        return [enc.memx(d, m.r, byte, store, 0), this.imm16(v.v, "displacement")];
      }
      case "abs": return [enc.memx(d, 0, byte, store, 1), this.addr16(this.value(m.e).v)];
      case "post": return [enc.memx(d, m.r, byte, store, 2)];
      case "pre": return [enc.memx(d, m.r, byte, store, 3)];
      case "spind": {
        if (byte) throw new Fail(`${op}: there is no byte form of [SP+d]; use a word access or copy SP to a register`);
        const v = m.e === null ? 0 : this.value(m.e).v;
        this.range(v, 0, 510, "SP displacement");
        if (v & 1) this.err(`odd SP displacement ${v} (must be even)`);
        return [enc.sprel(d, store, (v >> 1) & 255)];
      }
      default: throw new Fail(`${op}: expected a memory operand like [Rs+d], [addr], [Rs]+, -[Rs] or [SP+d], got ${describe(m)}`);
    }
  }

  // -- finish ---------------------------------------------------------------
  finish(): AsmResult {
    let nBanks = 2;
    while (nBanks < this.highestBank + 1) nBanks *= 2;
    if (this.romBanks) {
      if (this.romBanks.n <= this.highestBank)
        this.report(this.romBanks.st, `.rom ${this.romBanks.n} is too small: bank ${this.highestBank} is used`);
      else nBanks = this.romBanks.n;
    }
    nBanks = Math.min(nBanks, MAX_BANKS);
    const rom = new Uint8Array(nBanks * BANK_BYTES).fill(0xff);
    for (const [n, b] of this.banks) if (n < nBanks) rom.set(b.data, n * BANK_BYTES);
    if (this.header) {
      rom[0x15] = nBanks - 1;
      rom[CHECKSUM_AT] = 0; rom[CHECKSUM_AT + 1] = 0;
      let sum = 0;
      for (let i = 0; i < rom.length; i += 2) sum = (sum + rom[i] + (rom[i + 1] << 8)) & 0xffff;
      rom[CHECKSUM_AT] = sum & 0xff; rom[CHECKSUM_AT + 1] = sum >> 8;
    }
    const symbols = new Map<string, number>(), labelBanks = new Map<string, number>();
    for (const [name, s] of [...this.syms].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
      if (s.value !== undefined) symbols.set(name, s.value);
      if (s.value !== undefined && s.bank !== undefined) labelBanks.set(name, s.bank);
    }
    const errors = this.errors.map((x, i) => ({ ...x, i })).sort((x, y) => x.seq - y.seq || x.i - y.i).map((x) => x.e);
    const listingSource = this.stmts.map((st) => ({ file: st.file, line: st.line }));
    return { rom, symbols, labelBanks, listing: this.listing.join("\n") + "\n", errors, listingSource };
  }
}

/**
 * Assemble `mainFile` (read through `readFile`, as are .include/.incbin files,
 * which resolve relative to the including file). Pure: identical inputs give
 * identical output. Errors are collected, never thrown.
 */
export function assemble(mainFile: string, readFile: ReadFile): AsmResult {
  const a = new Assembler(readFile);
  let text: string | undefined;
  try { text = toText(readFile(mainFile)); }
  catch (e) {
    a.errors.push({ seq: -1, e: { file: mainFile, line: 0, message: `cannot read file '${mainFile}': ${e instanceof Error ? e.message : String(e)}` } });
  }
  if (text !== undefined) {
    a.load(mainFile, text, [mainFile]);
    a.runPass(1);
    a.highestBank = 0;
    a.runPass(2);
  }
  return a.finish();
}
