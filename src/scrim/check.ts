// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// SCRIM semantic checker: scopes, types, constants and storage layout (docs/scrim-spec.md §2-§5, §8).
// Annotates the AST in place (Expr.t / .c / .sym) for the code generator and collects errors
// (compilation stops after 20).
import { REGISTERS } from "../hw/registers.ts";
import { CompileError, type Pos } from "./lexer.ts";
import { resolvePath } from "./paths.ts";
import type { Decl, Expr, Init, ProcDecl, Program, Stmt, TypeNode } from "./parser.ts";
import { T, alignOf, isInteger, isNumeric, isScalar, isSigned, sizeOf, typeEq, typeName, type Field, type Type } from "./types.ts";

// ---------------------------------------------------------------------------- symbols

export type Slot = {
  name: string; pos: Pos; type: Type;
  isParam: boolean; hidden: boolean;
  uses: number;          // weighted reference count (loop nesting), for register allocation
  addrTaken: boolean;
  off: number;           // frame offset from SP at statement level (set by codegen)
  reg: number | null;    // R4-R6 when kept in a register (set by codegen)
  wordSlot: boolean;     // a BYTE/BOOL scalar kept in a whole word slot (accessed as a word)
};

export type ProcInfo = {
  name: string; label: string; bodyLabel: string; pos: Pos;
  params: Slot[]; result: Type | null;
  far: boolean; interrupt: boolean; bank: number; isMain: boolean;
  runtime: boolean;      // a runtime-library routine (runtime.inc)
  extern: boolean;       // EXTERN PROC/FUNC: an assembly routine, no SCRIM body
  decl: ProcDecl | null;
  locals: Slot[];
  localConsts: Map<string, number>;
  hasAsm: boolean;
  scope: Map<string, Sym>;
  endPos: Pos;
};

export type Sym =
  | { k: "const"; name: string; pos: Pos; type: Type; value: number }
  | { k: "xconst"; name: string; pos: Pos; type: Type }     // EXTERN CONST: value known when linking
  | { k: "var"; name: string; pos: Pos; type: Type; asm: string; addr: number }
  | { k: "local"; name: string; pos: Pos; slot: Slot }
  | { k: "port"; name: string; pos: Pos; type: Type; asm: string; addr: number }
  | { k: "data"; name: string; pos: Pos; type: Type; label: string; bank: number }
  | { k: "type"; name: string; pos: Pos; type: Type | null; node: TypeNode | null; state: 0 | 1 | 2 }
  | { k: "proc"; name: string; pos: Pos; info: ProcInfo }
  | { k: "builtin"; name: "TRUNC" | "SIZEOF" | "LEN"; pos: Pos };

export type DataItem = { name: string; bank: number; bytes: number[]; words: boolean; pos: Pos };
/** Assembly placed in a bank's link area (after its DATA), in declaration order. */
export type LinkItem =
  | { k: "include"; bank: number; pos: Pos; file: string }      // LINK file, or ASSET file + ".inc"
  | { k: "asm"; bank: number; pos: Pos; lines: { text: string; pos: Pos }[] };
/** A symbol an EXTERN declaration expects the linked assembly to define. */
export type ExternRef = { name: string; pos: Pos; what: string };
export type Global = { name: string; addr: number; size: number };
export type HeaderInfo = { title: number[]; dev: number; date: number; version: number; ram: number; generation: number };
export type VectorName = "VBLANK" | "LINE" | "TIMER" | "TRAP";

export type Checked = {
  program: Program;
  globals: Global[];
  varsEnd: number;
  consts: { name: string; value: number }[];
  portEqus: { name: string; addr: number }[];
  data: DataItem[];
  procs: ProcInfo[];
  main: ProcInfo;
  vectors: Record<VectorName, ProcInfo | null>;
  header: HeaderInfo;
  links: LinkItem[];
  externs: ExternRef[];
};

export type CheckError = { pos: Pos; message: string };
export type ReadBinary = (fromFile: string, path: string, pos: Pos) => Uint8Array;

class TooManyErrors extends Error {}

export const MAX_ERRORS = 20;
const RAM_START = 0x8000, RAM_END = 0xc000;
const u16 = (v: number) => ((v % 65536) + 65536) % 65536;
const s16 = (v: number) => (u16(v) << 16) >> 16;
const hex = (v: number) => "$" + (v >>> 0).toString(16).toUpperCase().padStart(4, "0");

/** Predeclared ports whose register name is a SCRIM keyword get this suffix. */
const KEYWORD_PORTS = new Set(["IF", "BANK", "FIXED"]);
export const portAlias = (reg: string) => (KEYWORD_PORTS.has(reg) ? `${reg}_PORT` : reg);
const IO_BY_UPPER = new Map(REGISTERS.map((r) => [r.name.toUpperCase(), r]));

export const RUNTIME_PROCS: { name: string; params: [string, Type][]; result: Type | null }[] = [
  { name: "MEMCPY", params: [["dst", T.addr], ["src", T.addr], ["n", T.word]], result: null },
  { name: "MEMSET", params: [["dst", T.addr], ["value", T.word], ["n", T.word]], result: null },
  { name: "VRAM_COPY", params: [["vramAddr", T.word], ["src", T.addr], ["words", T.word]], result: null },
  { name: "RANDOM", params: [], result: T.word },
  { name: "SEED_RANDOM", params: [["seed", T.word]], result: null },
  { name: "WAIT_VBLANK", params: [], result: null },
];

type Cx = { proc: ProcInfo; loopDepth: number };

export function check(program: Program, readBinary: ReadBinary): { checked: Checked | null; errors: CheckError[] } {
  const c = new Checker(program, readBinary);
  try { c.run(); }
  catch (e) {
    if (e instanceof CompileError) c.errors.push({ pos: e.pos, message: e.message });
    else if (!(e instanceof TooManyErrors)) throw e;
  }
  const errors = c.errors.slice(0, MAX_ERRORS);
  return { checked: errors.length ? null : c.result(), errors };
}

class Checker {
  program: Program;
  readBinary: ReadBinary;
  errors: CheckError[] = [];
  system = new Map<string, Sym>();
  module = new Map<string, Sym>();
  globals: Global[] = [];
  varsEnd = RAM_START;
  consts: { name: string; value: number }[] = [];
  portEqus: { name: string; addr: number }[] = [];
  data: DataItem[] = [];
  procs: ProcInfo[] = [];
  main!: ProcInfo;
  vectors: Record<VectorName, ProcInfo | null> = { VBLANK: null, LINE: null, TIMER: null, TRAP: null };
  header: HeaderInfo = { title: [], dev: 0, date: 0, version: 0, ram: 0, generation: 0 };
  bank = 0;
  hiddenCount = 0;
  links: LinkItem[] = [];
  externs: ExternRef[] = [];

  constructor(program: Program, readBinary: ReadBinary) { this.program = program; this.readBinary = readBinary; }

  err(pos: Pos, message: string): Type {
    this.errors.push({ pos, message });
    if (this.errors.length >= MAX_ERRORS) throw new TooManyErrors();
    return T.err;
  }

  result(): Checked {
    return {
      program: this.program, globals: this.globals, varsEnd: this.varsEnd, consts: this.consts, portEqus: this.portEqus,
      data: this.data, procs: this.procs, main: this.main, vectors: this.vectors, header: this.header,
      links: this.links, externs: this.externs,
    };
  }

  // -------------------------------------------------------------------------- setup
  run() {
    const sysPos: Pos = { file: "<system>", line: 0, col: 0 };
    for (const r of REGISTERS) {
      const name = portAlias(r.name);
      this.system.set(name, { k: "port", name, pos: sysPos, type: T.word, asm: r.name, addr: r.addr });
    }
    for (const rp of RUNTIME_PROCS) {
      const info = this.newProc(rp.name, sysPos, null);
      info.runtime = true;
      info.params = rp.params.map(([n, t]) => this.slot(n, sysPos, t, true));
      info.result = rp.result;
      this.system.set(rp.name, { k: "proc", name: rp.name, pos: sysPos, info });
    }
    for (const b of ["TRUNC", "SIZEOF", "LEN"] as const) this.system.set(b, { k: "builtin", name: b, pos: sysPos });

    const p = this.program;
    this.main = this.newProc("main", p.bodyPos, null);
    this.main.label = this.main.bodyLabel = "__main";
    this.main.isMain = true;
    this.main.endPos = p.endPos;
    this.headerInfo();

    // Pass A: types and procedures are visible everywhere in the module.
    for (const d of p.decls) {
      if (d.k === "type") this.declare(this.module, { k: "type", name: d.name, pos: d.pos, type: null, node: d.type, state: 0 });
      else if (d.k === "proc") {
        const info = this.newProc(d.name, d.pos, d);
        info.extern = d.extern;
        if (this.declare(this.module, { k: "proc", name: d.name, pos: d.pos, info }) && !d.extern) this.procs.push(info);
      }
    }
    // Pass B: declarations in order.
    for (const d of p.decls) this.decl(d);
    // Pass C: bodies.
    for (const info of this.procs) this.procBody(info);
    this.body(this.main, p.body);
    if (this.varsEnd > RAM_END) this.err(p.pos, `module variables need ${this.varsEnd - RAM_START} bytes; work RAM holds ${RAM_END - RAM_START}`);
  }

  newProc(name: string, pos: Pos, decl: ProcDecl | null): ProcInfo {
    return {
      name, label: name, bodyLabel: name, pos, params: [], result: null,
      far: decl?.far ?? false, interrupt: decl?.interrupt ?? false, bank: 0, isMain: false, runtime: false, extern: false,
      decl, locals: [], localConsts: new Map(), hasAsm: false, scope: new Map(), endPos: decl?.endPos ?? pos,
    };
  }

  slot(name: string, pos: Pos, type: Type, isParam: boolean, hidden = false): Slot {
    return { name, pos, type, isParam, hidden, uses: 0, addrTaken: false, off: 0, reg: null, wordSlot: isScalar(type) && sizeOf(type) === 1 };
  }

  headerInfo() {
    const p = this.program;
    this.header.title = [...p.name].map((ch) => ch.charCodeAt(0)).slice(0, 24);
    const seen = new Set<string>();
    for (const f of p.header) {
      const key = f.key.toLowerCase();
      if (seen.has(key)) { this.err(f.pos, `HEADER field '${f.key}' given twice`); continue; }
      seen.add(key);
      if (key === "title") {
        if (!f.str) { this.err(f.valuePos, "HEADER title must be a quoted string"); continue; }
        if (f.str.length > 24) this.err(f.valuePos, `HEADER title is ${f.str.length} characters; at most 24 fit`);
        if (f.str.some((b) => b < 0x20 || b > 0x7e)) this.err(f.valuePos, "HEADER title must be printable ASCII");
        this.header.title = f.str.slice(0, 24);
        continue;
      }
      const limits: Record<string, [number, number]> = { dev: [0, 0xffff], date: [0, 0xffffffff], version: [0, 0xffff], ram: [0, 1], generation: [0, 1] };
      if (!(key in limits)) { this.err(f.pos, `unknown HEADER field '${f.key}' (title, dev, date, version, ram, generation)`); continue; }
      if (!f.value) { this.err(f.valuePos, `HEADER ${key} must be a number`); continue; }
      const v = this.constValue(f.value, { proc: this.main, loopDepth: 0 }, `HEADER ${key}`);
      if (v === null) continue;
      const [lo, hi] = limits[key];
      if (v < lo || v > hi) { this.err(f.valuePos, `HEADER ${key} ${v} out of range (${lo}..${hi})`); continue; }
      (this.header as Record<string, number | number[]>)[key] = v;
    }
  }

  // -------------------------------------------------------------------------- names
  validName(name: string, pos: Pos): boolean {
    if (name.startsWith("__")) { this.err(pos, `names beginning with __ are reserved for the compiler ('${name}')`); return false; }
    if (/^(R[0-7]|SP)$/i.test(name)) { this.err(pos, `'${name}' clashes with the CYASM register name ${name.toUpperCase()}`); return false; }
    return true;
  }

  /** Declare in `scope`; reports duplicates and clashes with predeclared names. */
  declare(scope: Map<string, Sym>, s: Sym, portAddr?: number): boolean {
    if (!this.validName(s.name, s.pos)) return false;
    const prev = scope.get(s.name);
    if (prev) { this.err(s.pos, `'${s.name}' is already declared (at ${prev.pos.file}:${prev.pos.line}:${prev.pos.col})`); return false; }
    if (scope === this.module) {
      const sys = this.system.get(s.name);
      const io = IO_BY_UPPER.get(s.name.toUpperCase());
      if (sys && sys.k === "port") {
        if (portAddr === undefined) { this.err(s.pos, `'${s.name}' is the I/O register at ${hex(sys.addr)} (predeclared as a PORT)`); return false; }
        if (portAddr !== sys.addr) { this.err(s.pos, `PORT ${s.name} conflicts with the I/O register ${s.name} at ${hex(sys.addr)}`); return false; }
      } else if (sys && sys.k === "proc") { this.err(s.pos, `'${s.name}' is a runtime library routine and cannot be redeclared`); return false; }
      else if (io && io.name !== s.name) { this.err(s.pos, `'${s.name}' clashes with the I/O register name ${io.name} (CYASM register names are case-insensitive)`); return false; }
    }
    scope.set(s.name, s);
    return true;
  }

  lookup(name: string, cx: Cx | null): Sym | undefined {
    return cx?.proc.scope.get(name) ?? this.module.get(name) ?? this.system.get(name);
  }

  // -------------------------------------------------------------------------- declarations
  decl(d: Decl) {
    const cx: Cx = { proc: this.main, loopDepth: 0 };
    switch (d.k) {
      case "const": {
        const t = this.expr(d.value, cx);
        if (t.k === "err") return;
        if (d.value.c === undefined) { this.err(d.value.pos, `CONST ${d.name} must be a constant expression${this.linkHint(d.value)}`); return; }
        if (!isNumeric(t) && t.k !== "bool") { this.err(d.value.pos, `CONST ${d.name} must be a number or BOOL`); return; }
        if (t.k === "ulit" && (d.value.c < -32768 || d.value.c > 0xffffffff)) { this.err(d.value.pos, `CONST ${d.name} value ${d.value.c} out of range`); return; }
        if (this.declare(this.module, { k: "const", name: d.name, pos: d.pos, type: t, value: d.value.c }))
          this.consts.push({ name: d.name, value: d.value.c });
        return;
      }
      case "type": {
        const s = this.module.get(d.name);
        if (s && s.k === "type" && s.node === d.type) this.namedType(s, d.pos, false);
        return;
      }
      case "var": {
        const t = this.type(d.type, cx, false);
        if (t.k === "err") return;
        let addr: number;
        if (d.at) {
          const v = this.constValue(d.at, cx, "AT address");
          if (v === null) return;
          if (v < 0 || v > 0xffff) { this.err(d.at.pos, `AT address ${v} out of range`); return; }
          if (alignOf(t) === 2 && v & 1) { this.err(d.at.pos, `AT address ${hex(v)} must be even for a ${typeName(t)}`); return; }
          addr = v;
        } else {
          addr = this.varsEnd = align(this.varsEnd, alignOf(t));
          this.varsEnd += sizeOf(t);
        }
        if (this.declare(this.module, { k: "var", name: d.name, pos: d.pos, type: t, asm: d.name, addr }))
          this.globals.push({ name: d.name, addr, size: sizeOf(t) });
        return;
      }
      case "port": {
        const t = this.type(d.type, cx, false);
        if (t.k === "err") return;
        if (!isScalar(t)) { this.err(d.type.pos, "a PORT must have a scalar type (BYTE, WORD, INT, ...)"); return; }
        const v = this.constValue(d.at, cx, "PORT address");
        if (v === null) return;
        if (v < 0 || v > 0xffff) { this.err(d.at.pos, `PORT address ${v} out of range`); return; }
        const sys = this.system.get(d.name);
        if (this.declare(this.module, { k: "port", name: d.name, pos: d.pos, type: t, asm: sys?.k === "port" ? sys.asm : d.name, addr: v }, v)
          && !(sys?.k === "port")) this.portEqus.push({ name: d.name, addr: v });
        return;
      }
      case "data": {
        let t = this.type(d.type, cx, true);
        if (t.k === "err") return;
        const bytes: number[] = [];
        const got = this.serialize(t, d.init, bytes, cx);
        if (got === null) return;
        t = got;
        const scalarElem = t.k === "array" ? t.elem : t;
        const words = isScalar(scalarElem) && sizeOf(scalarElem) === 2;
        if (this.declare(this.module, { k: "data", name: d.name, pos: d.pos, type: t, label: d.name, bank: this.bank }))
          this.data.push({ name: d.name, bank: this.bank, bytes, words, pos: d.pos });
        return;
      }
      case "proc": {
        const s = this.module.get(d.name);
        if (!s || s.k !== "proc" || s.info.decl !== d) return;
        this.signature(s.info, d);
        return;
      }
      case "vector": {
        const which = d.which.toUpperCase();
        if (!["VBLANK", "LINE", "TIMER", "TRAP"].includes(which)) { this.err(d.whichPos, `unknown vector '${d.which}' (VBLANK, LINE, TIMER or TRAP)`); return; }
        const s = this.lookup(d.handler, null);
        if (!s) { this.err(d.handlerPos, `undeclared name '${d.handler}'`); return; }
        if (s.k !== "proc" || !s.info.interrupt) { this.err(d.handlerPos, `VECTOR ${which} needs an INTERRUPT PROC; '${d.handler}' is not one`); return; }
        const v = which as VectorName;
        if (this.vectors[v]) { this.err(d.pos, `VECTOR ${which} is already set`); return; }
        this.vectors[v] = s.info;
        return;
      }
      case "bank": {
        const v = this.constValue(d.n, cx, "BANK number");
        if (v === null) return;
        if (v < 0 || v > 255) { this.err(d.n.pos, `bank ${v} out of range (0..255)`); return; }
        this.bank = v;
        return;
      }
      case "extern": {
        const t = this.type(d.type, cx, d.what === "DATA");
        if (t.k === "err") return;
        let ok: boolean;
        if (d.what === "DATA") ok = this.declare(this.module, { k: "data", name: d.name, pos: d.pos, type: t, label: d.name, bank: this.bank });
        else if (d.what === "VAR") ok = this.declare(this.module, { k: "var", name: d.name, pos: d.pos, type: t, asm: d.name, addr: -1 });
        else {
          if (!["byte", "word", "int", "fixed", "pointer"].includes(t.k)) { this.err(d.type.pos, `EXTERN CONST '${d.name}' must have a BYTE, WORD, INT, FIXED or POINTER type, not ${typeName(t)}`); return; }
          ok = this.declare(this.module, { k: "xconst", name: d.name, pos: d.pos, type: t });
        }
        if (ok) this.externs.push({ name: d.name, pos: d.pos, what: `EXTERN ${d.what}` });
        return;
      }
      case "link": {
        if (d.asset && !/\.(art|song)$/i.test(d.path)) { this.err(d.pathPos, `ASSET takes a .art or .song file (use LINK for CYASM source), not '${d.path}'`); return; }
        const file = resolvePath(d.pos.file, d.path) + (d.asset ? ".inc" : "");
        if (!this.links.some((l) => l.k === "include" && l.file === file)) this.links.push({ k: "include", bank: this.bank, pos: d.pos, file });
        return;
      }
      case "asm":
        this.links.push({ k: "asm", bank: this.bank, pos: d.pos, lines: d.lines });
        return;
    }
  }

  signature(info: ProcInfo, d: ProcDecl) {
    const cx: Cx = { proc: info, loopDepth: 0 };
    if (d.extern) {
      if (this.bank !== 0) this.err(d.kwPos, `EXTERN ${d.isFunc ? "FUNC" : "PROC"} '${d.name}' follows BANK ${this.bank}: external routines are called directly and must live in bank 0 (write BANK 0; before the declaration and the LINK that defines it)`);
      this.externs.push({ name: d.name, pos: d.pos, what: `EXTERN ${d.isFunc ? "FUNC" : "PROC"}` });
    } else if (d.far) {
      if (this.bank === 0) this.err(d.kwPos, `FAR ${d.isFunc ? "FUNC" : "PROC"} '${d.name}' must be placed in a switchable bank: write BANK n; (n >= 1) before it`);
      info.bank = this.bank;
      info.bodyLabel = `__far_${d.name}`;
    } else if (this.bank !== 0) {
      this.err(d.kwPos, `${d.interrupt ? "INTERRUPT PROC" : d.isFunc ? "FUNC" : "PROC"} '${d.name}' follows BANK ${this.bank} but is not FAR: only FAR procedures and DATA live in switchable banks (declare it FAR, or write BANK 0; before it)`);
    }
    if (d.interrupt && d.params.length) this.err(d.params[0].pos, "an INTERRUPT PROC takes no parameters");
    d.params.forEach((p) => {
      let t = this.type(p.type, cx, false);
      if (t.k === "array" || t.k === "record") t = this.err(p.type.pos, `parameter '${p.name}': pass arrays and records by POINTER`);
      const slot = this.slot(p.name, p.pos, t, true);
      if (this.declare(info.scope, { k: "local", name: p.name, pos: p.pos, slot })) info.params.push(slot);
    });
    if (d.result) {
      const t = this.type(d.result, cx, false);
      info.result = t.k === "array" || t.k === "record" ? this.err(d.result.pos, "a FUNC returns a scalar; return a POINTER to larger objects") : t;
    }
  }

  procBody(info: ProcInfo) {
    const d = info.decl!;
    const cx: Cx = { proc: info, loopDepth: 0 };
    for (const ld of d.decls) {
      if (ld.k === "const") {
        const t = this.expr(ld.value, cx);
        if (t.k === "err") continue;
        if (ld.value.c === undefined) { this.err(ld.value.pos, `CONST ${ld.name} must be a constant expression${this.linkHint(ld.value)}`); continue; }
        if (this.declare(info.scope, { k: "const", name: ld.name, pos: ld.pos, type: t, value: ld.value.c })) info.localConsts.set(ld.name, u16(ld.value.c));
      } else if (ld.k === "var") {
        const t = this.type(ld.type, cx, false);
        if (t.k === "err") continue;
        const slot = this.slot(ld.name, ld.pos, t, false);
        if (this.declare(info.scope, { k: "local", name: ld.name, pos: ld.pos, slot })) info.locals.push(slot);
      }
    }
    this.body(info, d.body);
  }

  body(info: ProcInfo, body: Stmt[]) {
    const cx: Cx = { proc: info, loopDepth: 0 };
    this.stmts(body, cx);
    if (info.result && info.result.k !== "err" && fallsThrough(body))
      this.err(info.endPos, `FUNC '${info.name}' can reach its end without RETURN`);
  }

  // -------------------------------------------------------------------------- types
  type(n: TypeNode, cx: Cx, allowUnsized: boolean, viaPointer = false): Type {
    switch (n.k) {
      case "prim": return (T as Record<string, Type>)[n.name.toLowerCase()];
      case "named": {
        const s = this.lookup(n.name, cx);
        if (!s) return this.err(n.pos, `undeclared type '${n.name}'`);
        if (s.k !== "type") return this.err(n.pos, `'${n.name}' is not a type`);
        return this.namedType(s, n.pos, viaPointer);
      }
      case "array": {
        const elem = this.type(n.elem, cx, false);
        if (elem.k === "err") return elem;
        if (n.len === null) {
          if (!allowUnsized) return this.err(n.pos, "ARRAY OF without a size is only allowed for DATA");
          return { k: "array", len: null, elem };
        }
        const t = this.expr(n.len, cx);
        if (t.k === "err") return t;
        if (n.len.c === undefined || !isInteger(t)) return this.err(n.len.pos, `array size must be a constant integer${this.linkHint(n.len)}`);
        const len = t.k === "int" ? s16(n.len.c) : n.len.c;
        if (len < 1 || len * sizeOf(elem) > 0x8000) return this.err(n.len.pos, `array size ${len} out of range (1..${Math.floor(0x8000 / Math.max(1, sizeOf(elem)))})`);
        return { k: "array", len, elem };
      }
      case "record": return this.record(n, cx, { k: "record", name: "RECORD", fields: [], size: 0, align: 1 });
      case "pointer": return { k: "pointer", to: this.type(n.to, cx, false, true) };
    }
  }

  namedType(s: Sym & { k: "type" }, pos: Pos, viaPointer: boolean): Type {
    if (s.state === 2) return s.type!;
    if (s.state === 1) {
      if (viaPointer && s.type) return s.type;
      return this.err(pos, `type '${s.name}' contains itself (use a POINTER)`);
    }
    s.state = 1;
    const cx: Cx = { proc: this.main, loopDepth: 0 };
    const n = s.node!;
    let t: Type;
    if (n.k === "record") {
      const r: Type & { k: "record" } = { k: "record", name: s.name, fields: [], size: 0, align: 1 };
      s.type = r;
      t = this.record(n, cx, r);
    } else if (n.k === "pointer") {
      const p: Type & { k: "pointer" } = { k: "pointer", to: T.void };
      s.type = p;
      p.to = this.type(n.to, cx, false, true);
      t = p;
    } else t = this.type(n, cx, false);
    s.type = t;
    s.state = 2;
    return t;
  }

  record(n: TypeNode & { k: "record" }, cx: Cx, r: Type & { k: "record" }): Type {
    let off = 0, al = 1;
    const fields: Field[] = [];
    for (const f of n.fields) {
      if (fields.some((x) => x.name === f.name)) { this.err(f.pos, `field '${f.name}' is declared twice`); continue; }
      const t = this.type(f.type, cx, false);
      if (t.k === "err") return t;
      const a = alignOf(t);
      off = align(off, a);
      fields.push({ name: f.name, off, type: t });
      off += sizeOf(t);
      al = Math.max(al, a);
    }
    r.fields = fields; r.align = al; r.size = align(off, al);
    return r;
  }

  // -------------------------------------------------------------------------- DATA initialisers
  /** Serialise `init` as type `t`; returns the (sized) type or null on error. */
  serialize(t: Type, init: Init, out: number[], cx: Cx): Type | null {
    const pushScalar = (e: Expr, st: Type): boolean => {
      const et = this.expr(e, cx);
      if (et.k === "err") return false;
      if (e.c === undefined) { this.err(e.pos, `DATA initialisers must be constants${this.linkHint(e)}`); return false; }
      if (!this.coerce(e, st, "DATA initialiser")) return false;
      const v = u16(e.c!);
      if (sizeOf(st) === 1) out.push(v & 0xff); else out.push(v & 0xff, v >> 8);
      return true;
    };
    if (t.k === "array") {
      const elem = t.elem;
      if (init.k === "str" || init.k === "incbin") {
        let bytes: Uint8Array | number[];
        if (init.k === "str") bytes = init.bytes;
        else {
          try { bytes = this.readBinary(init.pos.file, init.path, init.pos); }
          catch (e) { if (e instanceof CompileError) { this.err(e.pos, e.message); return null; } throw e; }
        }
        const es = sizeOf(elem);
        if (!isScalar(elem) || elem.k === "pointer" || (init.k === "str" && es !== 1)) {
          this.err(init.pos, `${init.k === "str" ? "a string" : "INCBIN"} initialises an ARRAY OF BYTE${init.k === "incbin" ? " or of 16-bit numbers" : ""}, not ${typeName(t)}`);
          return null;
        }
        if (bytes.length % es) { this.err(init.pos, `INCBIN file has ${bytes.length} bytes, not a whole number of ${es}-byte elements`); return null; }
        const n = bytes.length / es;
        if (t.len !== null && (init.k === "incbin" ? n !== t.len : n > t.len)) { this.err(init.pos, `initialiser has ${n} elements; the array has ${t.len}`); return null; }
        for (const b of bytes) out.push(b);
        const len = t.len ?? n;
        for (let k = n * es; k < len * es; k++) out.push(0);
        if (len === 0) { this.err(init.pos, "empty DATA array"); return null; }
        return { k: "array", len, elem };
      }
      // a one-element list "(x)" parses as a parenthesised expression
      const items = init.k === "list" ? init.items : [init];
      if (init.k !== "list" && t.len !== 1) { this.err(init.pos, `an ARRAY needs a parenthesised list of ${t.len ?? "its"} elements`); return null; }
      if (t.len !== null && items.length !== t.len) { this.err(init.pos, `initialiser has ${items.length} elements; the array has ${t.len}`); return null; }
      for (const it of items) if (this.serialize(elem, it, out, cx) === null) return null;
      return { k: "array", len: items.length, elem };
    }
    if (t.k === "record") {
      const items = init.k === "list" ? init.items : [init];
      if ((init.k !== "list" && init.k !== "expr") || items.length !== t.fields.length) { this.err(init.pos, `a ${t.name} initialiser lists its ${t.fields.length} fields in parentheses`); return null; }
      const base = out.length;
      for (let k = 0; k < t.fields.length; k++) {
        while (out.length < base + t.fields[k].off) out.push(0);
        if (this.serialize(t.fields[k].type, items[k], out, cx) === null) return null;
      }
      while (out.length < base + t.size) out.push(0);
      return t;
    }
    if (t.k === "pointer") { this.err(init.pos, "DATA cannot hold pointers"); return null; }
    if (init.k !== "expr") { this.err(init.pos, `a ${typeName(t)} is initialised with a single constant`); return null; }
    return pushScalar(init.e, t) ? t : null;
  }

  // -------------------------------------------------------------------------- statements
  stmts(list: Stmt[], cx: Cx) { for (const s of list) this.stmt(s, cx); }

  weight(cx: Cx) { return Math.min(8 ** cx.loopDepth, 4096); }

  stmt(s: Stmt, cx: Cx) {
    switch (s.k) {
      case "assign": {
        const tt = this.lvalue(s.target, cx);
        const vt = this.expr(s.value, cx);
        if (tt.k === "err" || vt.k === "err") return;
        this.coerce(s.value, tt, "assignment", true);
        return;
      }
      case "call": {
        const e = s.call;
        if (e.k === "name") Object.assign(e, { k: "call", callee: { k: "name", name: e.name, pos: e.pos }, args: [] });
        if (e.k !== "call" || e.callee.k !== "name") { this.err(e.pos, "expected a procedure call"); return; }
        const sym = this.lookup(e.callee.name, cx);
        if (sym && sym.k !== "proc") {
          this.err(e.pos, sym.k === "builtin" || sym.k === "type" ? `'${e.callee.name}(...)' is a value, not a statement` : `'${e.callee.name}' is not a procedure`);
          return;
        }
        this.call(e, cx);
        return;
      }
      case "if":
        for (const a of s.arms) { this.cond(a.cond, cx); this.stmts(a.body, cx); }
        if (s.els) this.stmts(s.els, cx);
        return;
      case "while": {
        this.cond(s.cond, { ...cx, loopDepth: cx.loopDepth + 1 });
        this.stmts(s.body, { ...cx, loopDepth: cx.loopDepth + 1 });
        return;
      }
      case "repeat": {
        const inner = { ...cx, loopDepth: cx.loopDepth + 1 };
        this.stmts(s.body, inner);
        this.cond(s.cond, inner);
        return;
      }
      case "for": return this.forStmt(s, cx);
      case "case": return this.caseStmt(s, cx);
      case "exit": if (cx.loopDepth === 0) this.err(s.pos, "EXIT outside of a loop (WHILE, REPEAT or FOR)"); return;
      case "return": {
        const p = cx.proc;
        if (p.result) {
          if (!s.value) { this.err(s.pos, `RETURN in FUNC '${p.name}' needs a value of type ${typeName(p.result)}`); return; }
          const t = this.expr(s.value, cx);
          if (t.k !== "err" && p.result.k !== "err") this.coerce(s.value, p.result, "RETURN value", false, `RETURN type mismatch: ${typeName(t)} value in a FUNC returning ${typeName(p.result)}`);
        } else if (s.value) {
          this.err(s.pos, p.isMain ? "the main body cannot return a value" : `a PROC cannot return a value (declare '${p.name}' as a FUNC)`);
        }
        return;
      }
      case "wait": return;
      case "asm": cx.proc.hasAsm = true; return;
    }
  }

  cond(e: Expr, cx: Cx) {
    const t = this.expr(e, cx);
    if (t.k !== "err" && t.k !== "bool") this.err(e.pos, `a condition must be BOOL, not ${typeName(t)} (compare with <> 0)`);
  }

  forStmt(s: Stmt & { k: "for" }, cx: Cx) {
    const v = s.v as Expr & { k: "name" };
    const sym = this.lookup(v.name, cx);
    const inner = { ...cx, loopDepth: cx.loopDepth + 1 };
    let vt: Type = T.err;
    if (!sym) this.err(v.pos, `undeclared name '${v.name}'`);
    else if (sym.k !== "var" && sym.k !== "local") this.err(v.pos, `the FOR variable must be a variable; '${v.name}' is not`);
    else {
      vt = sym.k === "var" ? sym.type : sym.slot.type;
      if (vt.k !== "byte" && vt.k !== "word" && vt.k !== "int") vt = this.err(v.pos, `the FOR variable must be BYTE, WORD or INT, not ${typeName(vt)}`);
      v.sym = sym; v.t = vt;
      if (sym.k === "local") sym.slot.uses += 3 * this.weight(inner);
    }
    const ft = this.expr(s.from, cx), tt = this.expr(s.to, cx);
    if (vt.k !== "err") {
      if (ft.k !== "err") this.coerce(s.from, vt, "FOR start");
      if (tt.k !== "err") this.coerce(s.to, vt, "FOR limit");
    }
    s.stepValue = 1;
    if (s.step) {
      const st = this.expr(s.step, cx);
      if (st.k !== "err") {
        if (s.step.c === undefined || !isInteger(st)) this.err(s.step.pos, `STEP must be a constant integer${this.linkHint(s.step)}`);
        else {
          const k = st.k === "ulit" ? s.step.c : isSigned(st) ? s16(s.step.c) : s.step.c;
          if (k < 1 || k > 32767) this.err(s.step.pos, `STEP must be positive (1..32767), got ${k}${k < 0 ? "; use DOWNTO" : ""}`);
          else s.stepValue = k;
        }
      }
    }
    if (s.to.c === undefined && vt.k !== "err") {
      const slot = this.slot(`__for${this.hiddenCount++}`, s.pos, vt, false, true);
      slot.uses = 2 * this.weight(inner);
      cx.proc.locals.push(slot);
      s.limitSlot = slot;
    }
    this.stmts(s.body, inner);
  }

  caseStmt(s: Stmt & { k: "case" }, cx: Cx) {
    let t = this.expr(s.e, cx);
    if (t.k === "ulit") { this.coerce(s.e, T.int, "CASE selector"); t = T.int; }
    if (t.k !== "err" && t.k !== "byte" && t.k !== "word" && t.k !== "int") t = this.err(s.e.pos, `CASE needs a BYTE, WORD or INT selector, not ${typeName(t)}`);
    const seen: [number, number][] = [];
    const signed = t.k === "int";
    const ord = (v: number) => (signed ? s16(v) : u16(v));
    for (const arm of s.arms) {
      const ranges: [number, number][] = [];
      for (const lab of arm.labels) {
        const lo = this.caseLabel(lab.lo, t, cx), hi = lab.hi ? this.caseLabel(lab.hi, t, cx) : lo;
        if (lo === null || hi === null) continue;
        const a = ord(lo), b = ord(hi);
        if (b < a) { this.err(lab.lo.pos, `empty CASE range ${a}..${b}`); continue; }
        const clash = seen.find(([x, y]) => a <= y && x <= b);
        if (clash) { this.err(lab.lo.pos, `duplicate CASE label ${Math.max(a, clash[0])}`); continue; }
        seen.push([a, b]);
        ranges.push([a, b]);
      }
      (arm as { ranges?: [number, number][] }).ranges = ranges;
      this.stmts(arm.body, cx);
    }
    if (s.els) this.stmts(s.els, cx);
  }

  caseLabel(e: Expr, t: Type, cx: Cx): number | null {
    const lt = this.expr(e, cx);
    if (lt.k === "err" || t.k === "err") return null;
    if (e.c === undefined) { this.err(e.pos, `CASE labels must be constants${this.linkHint(e)}`); return null; }
    if (!this.coerce(e, t, "CASE label")) return null;
    return e.c!;
  }

  // -------------------------------------------------------------------------- expressions
  /** " (EXTERN CONST 'X' is only known when linking)" when e mentions one, else "". */
  linkHint(e: Expr): string {
    const find = (x: Expr): string | null => {
      switch (x.k) {
        case "name": return (x.sym as Sym | undefined)?.k === "xconst" ? x.name : null;
        case "unary": case "deref": case "conv": return find(x.e);
        case "binary": return find(x.l) ?? find(x.r);
        case "index": return find(x.e) ?? find(x.index);
        case "field": return find(x.e);
        case "call": return x.args.map(find).find((n) => n) ?? null;
        default: return null;
      }
    };
    const n = find(e);
    return n ? ` (EXTERN CONST '${n}' is only known when linking)` : "";
  }

  /** Explanation for an array whose length is not known (only EXTERN DATA ... ARRAY OF T). */
  unsized(e: Expr | undefined): string {
    let root = e;
    while (root && (root.k === "index" || root.k === "field")) root = root.e;
    const what = root?.k === "name" ? `EXTERN DATA '${root.name}'` : "this array";
    return `the size of ${what} is not declared (write ARRAY [n] OF T in the EXTERN declaration)`;
  }

  constValue(e: Expr, cx: Cx, what: string): number | null {
    const t = this.expr(e, cx);
    if (t.k === "err") return null;
    if (e.c === undefined || !(isInteger(t) || t.k === "bool")) { this.err(e.pos, `${what} must be a constant integer${this.linkHint(e)}`); return null; }
    return t.k === "int" ? s16(e.c) : e.c;
  }

  /** Check an assignment target; returns its type. */
  lvalue(e: Expr, cx: Cx): Type {
    let root: Expr = e;
    while (root.k === "index" || root.k === "field") root = root.e;
    if (root.k === "name") {
      const s = this.lookup(root.name, cx);
      if (s?.k === "const" || s?.k === "xconst") return this.err(root.pos, `cannot assign to constant '${root.name}'`);
      if (s?.k === "data") return this.err(root.pos, `DATA '${root.name}' is read-only (it lives in ROM)`);
      if (s?.k === "proc" || s?.k === "type" || s?.k === "builtin") return this.err(root.pos, `cannot assign to '${root.name}'`);
    } else if (root.k !== "deref") return this.err(e.pos, "this expression cannot be assigned to");
    const t = this.expr(e, cx);
    if (t.k === "void") return this.err(e.pos, "cannot assign to a procedure call");
    return t;
  }

  /**
   * Make `e` usable where `target` is expected. Integer constants adapt (range-checked);
   * BYTE and WORD convert freely (stores to BYTE keep the low 8 bits).
   */
  coerce(e: Expr, target: Type, ctx: string, allowAggregate = false, msg?: string): boolean {
    const src = e.t!;
    if (src.k === "err" || target.k === "err") return false;
    const bad = () => { this.err(e.pos, msg ?? `${ctx}: ${typeName(src)} is not compatible with ${typeName(target)}`); return false; };
    if (src.k === "ulit") {
      const v = e.c!;
      switch (target.k) {
        case "byte":
          if (v < 0 || v > 255) { this.err(e.pos, `${v} is out of range for BYTE (0..255)`); return false; }
          e.t = T.byte; e.c = v; return true;
        case "word": case "int": case "addr":
          if (v < -32768 || v > 65535) { this.err(e.pos, `${v} is out of range for ${target.k === "int" ? "INT" : "WORD"} (-32768..65535)`); return false; }
          e.t = target.k === "addr" ? T.word : target; e.c = u16(v); return true;
        case "fixed":
          if (v < -128 || v > 127) { this.err(e.pos, `${v} is out of range for FIXED (-128.0..127.996)`); return false; }
          e.t = T.fixed; e.c = u16(v * 256); return true;
        default: return bad();
      }
    }
    if (typeEq(src, target)) return (allowAggregate || isScalar(src)) ? true : bad();
    if ((src.k === "byte" || src.k === "word") && (target.k === "byte" || target.k === "word")) return true;
    if (target.k === "pointer" && src.k === "nil") return true;
    if (target.k === "addr" && (src.k === "pointer" || src.k === "nil" || src.k === "word" || src.k === "byte")) return true;
    return bad();
  }

  expr(e: Expr, cx: Cx, addrCtx = false): Type {
    const t = this.expr1(e, cx, addrCtx);
    e.t = t;
    return t;
  }

  expr1(e: Expr, cx: Cx, addrCtx: boolean): Type {
    switch (e.k) {
      case "num":
        if (e.fixed) {
          if (!e.negLit && e.value > 32767) return this.err(e.pos, `${e.value / 256} is out of range for FIXED (-128.0..127.996)`);
          e.c = u16(e.value);
          return T.fixed;
        }
        e.c = e.value;
        return T.ulit;
      case "bool": e.c = e.value ? 1 : 0; return T.bool;
      case "nil": e.c = 0; return T.nil;
      case "str": return this.err(e.pos, "strings are only allowed in DATA initialisers and HEADER");
      case "name": return this.name(e, cx, addrCtx);
      case "unary": return this.unary(e, cx);
      case "binary": return this.binary(e, cx);
      case "index": {
        const at = this.expr(e.e, cx, addrCtx);
        const it = this.expr(e.index, cx);
        if (at.k === "err" || it.k === "err") return T.err;
        if (at.k !== "array") return this.err(e.pos, `${typeName(at)} cannot be indexed`);
        if (!isInteger(it)) return this.err(e.index.pos, `an array index must be an integer, not ${typeName(it)}`);
        if (e.index.c !== undefined) {
          const v = it.k === "int" ? s16(e.index.c) : e.index.c;
          if (at.len !== null && (v < 0 || v >= at.len)) return this.err(e.index.pos, `index ${v} out of bounds (0..${at.len - 1})`);
          if (it.k === "ulit") this.coerce(e.index, T.word, "index");
        }
        return at.elem;
      }
      case "field": {
        const rt = this.expr(e.e, cx, addrCtx);
        if (rt.k === "err") return rt;
        if (rt.k !== "record") return this.err(e.namePos, `${typeName(rt)} has no fields${rt.k === "pointer" ? " (dereference it with ^ first)" : ""}`);
        const f = rt.fields.find((x) => x.name === e.name);
        if (!f) return this.err(e.namePos, `${rt.name} has no field '${e.name}'`);
        return f.type;
      }
      case "deref": {
        const pt = this.expr(e.e, cx);
        if (pt.k === "err") return pt;
        if (pt.k === "nil") return this.err(e.pos, "cannot dereference NIL");
        if (pt.k !== "pointer") return this.err(e.pos, `^ needs a POINTER, not ${typeName(pt)}`);
        return pt.to;
      }
      case "call": {
        const t = this.call(e, cx);
        if (t.k === "void") {
          const n = e.callee.k === "name" ? e.callee.name : "?";
          return this.err(e.pos, `'${n}' is a PROC and has no result`);
        }
        return t;
      }
      case "conv": return this.conv(e, cx);
    }
  }

  name(e: Expr & { k: "name" }, cx: Cx, addrCtx: boolean): Type {
    const s = this.lookup(e.name, cx);
    if (!s) {
      if (["BYTE", "WORD", "INT", "FIXED", "BOOL"].includes(e.name)) return this.err(e.pos, `type ${e.name} used as a value`);
      return this.err(e.pos, `undeclared name '${e.name}'`);
    }
    e.sym = s;
    switch (s.k) {
      case "const": e.c = s.value; return s.type;
      case "xconst": return s.type;
      case "var": case "port": return s.type;
      case "local": s.slot.uses += this.weight(cx); return s.slot.type;
      case "data":
        if (s.bank !== 0 && !addrCtx && !(cx.proc.far && cx.proc.bank === s.bank))
          return this.err(e.pos, `DATA '${e.name}' lives in bank ${s.bank}; only FAR procedures in bank ${s.bank} can read it (@${e.name} gives its address)`);
        return s.type;
      case "type": return this.err(e.pos, `type '${e.name}' used as a value`);
      case "builtin": return this.err(e.pos, `'${e.name}' needs an argument in parentheses`);
      case "proc": {
        const info = s.info;
        if (info.result && info.params.length === 0) {
          Object.assign(e, { k: "call", callee: { k: "name", name: e.name, pos: e.pos }, args: [] });
          return this.expr1(e, cx, false);
        }
        if (!info.result) return this.err(e.pos, `'${e.name}' is a PROC and has no result`);
        return this.err(e.pos, `'${e.name}' needs ${info.params.length} argument${info.params.length === 1 ? "" : "s"}`);
      }
    }
  }

  call(e: Expr & { k: "call" }, cx: Cx): Type {
    if (e.callee.k !== "name") return this.err(e.pos, "only named procedures can be called");
    const name = e.callee.name;
    const s = this.lookup(name, cx);
    if (!s) return this.err(e.callee.pos, `undeclared name '${name}'`);
    e.sym = s;
    const one = (): Expr | null => {
      if (e.args.length !== 1) { this.err(e.pos, `'${name}' expects 1 argument, got ${e.args.length}`); return null; }
      return e.args[0];
    };
    if (s.k === "builtin") {
      if (s.name === "SIZEOF") {
        let t: Type;
        if (e.typeArg) t = this.type(e.typeArg, cx, false);
        else {
          const a = one();
          if (!a) return T.err;
          const ts = a.k === "name" ? this.lookup(a.name, cx) : undefined;
          if (a.k === "name" && ["BYTE", "WORD", "INT", "FIXED", "BOOL"].includes(a.name) && !ts) t = (T as Record<string, Type>)[a.name.toLowerCase()];
          else if (ts?.k === "type") t = this.namedType(ts, a.pos, false);
          else t = this.expr(a, cx, true);
        }
        if (t.k === "err") return t;
        if (t.k === "array" && t.len === null) return this.err(e.pos, `SIZEOF: ${this.unsized(e.args[0])}`);
        e.c = sizeOf(t);
        return T.ulit;
      }
      const a = one();
      if (!a) return T.err;
      const t = this.expr(a, cx, s.name === "LEN");
      if (t.k === "err") return t;
      if (s.name === "LEN") {
        if (t.k !== "array") return this.err(a.pos, `LEN needs an array, not ${typeName(t)}`);
        if (t.len === null) return this.err(a.pos, `LEN: ${this.unsized(a)}`);
        e.c = t.len;
        return T.ulit;
      }
      // TRUNC: FIXED -> INT, toward minus infinity
      if (t.k !== "fixed") return this.err(a.pos, `TRUNC needs a FIXED value, not ${typeName(t)}`);
      if (a.c !== undefined) e.c = u16(s16(a.c) >> 8);
      return T.int;
    }
    if (s.k === "type") {
      const a = one();
      if (!a) return T.err;
      const target = this.namedType(s, e.pos, false);
      const st = this.expr(a, cx);
      if (st.k === "err" || target.k === "err") return T.err;
      if (target.k === "byte" || target.k === "word" || target.k === "int" || target.k === "fixed") {
        Object.assign(e, { k: "conv", to: target.k.toUpperCase(), e: a });
        return this.conv(e as unknown as Expr & { k: "conv" }, cx, true);
      }
      const ok16 = (x: Type) => x.k === "word" || x.k === "int" || x.k === "pointer" || x.k === "nil" || x.k === "ulit";
      if (target.k === "pointer" && ok16(st)) {
        if (st.k === "ulit") this.coerce(a, T.word, "conversion");
        if (a.c !== undefined) e.c = a.c;
        return target;
      }
      return this.err(e.pos, `cannot convert ${typeName(st)} to ${typeName(target)}`);
    }
    if (s.k !== "proc") return this.err(e.callee.pos, `'${name}' is not a procedure`);
    const info = s.info;
    if (info.interrupt) return this.err(e.callee.pos, `INTERRUPT PROC '${name}' cannot be called; it runs from its VECTOR (it ends with RTI)`);
    if (e.args.length !== info.params.length)
      return this.err(e.callee.pos, `'${name}' expects ${info.params.length} argument${info.params.length === 1 ? "" : "s"}, got ${e.args.length}`);
    let failed = false;
    e.args.forEach((a, i) => {
      const t = this.expr(a, cx);
      if (t.k === "err" || info.params[i].type.k === "err") { failed = true; return; }
      if (!this.coerce(a, info.params[i].type, `argument ${i + 1} of '${name}'`)) failed = true;
    });
    if (failed) return T.err;
    return info.result ?? T.void;
  }

  conv(e: Expr & { k: "conv" }, cx: Cx, checked = false): Type {
    const a = e.e;
    const st = checked ? a.t! : this.expr(a, cx);
    if (st.k === "err") return st;
    const c = a.c;
    const scalar16 = st.k === "word" || st.k === "int" || st.k === "fixed" || st.k === "pointer" || st.k === "nil";
    switch (e.to) {
      case "BYTE":
        if (!(isInteger(st) || st.k === "bool")) return this.err(e.pos, `BYTE() cannot convert ${typeName(st)}`);
        if (c !== undefined) e.c = u16(c) & 0xff;
        return T.byte;
      case "WORD": case "INT":
        if (e.to === "INT" && st.k === "fixed") return this.err(e.pos, "INT(FIXED) is ambiguous: use TRUNC(f) to round toward minus infinity, or WORD(f) for the raw 8.8 bits");
        if (!(isInteger(st) || st.k === "bool" || scalar16)) return this.err(e.pos, `${e.to}() cannot convert ${typeName(st)}`);
        if (st.k === "ulit" && (c! < -32768 || c! > 65535)) return this.err(a.pos, `${c} is out of range for ${e.to} (-32768..65535)`);
        if (c !== undefined) e.c = u16(c);
        return e.to === "INT" ? T.int : T.word;
      case "FIXED":
        if (st.k === "fixed") { e.c = c; return T.fixed; }
        if (!isInteger(st)) return this.err(e.pos, `FIXED() cannot convert ${typeName(st)}`);
        if (c !== undefined) {
          const v = st.k === "int" ? s16(c) : c;
          if (v < -128 || v > 127) return this.err(a.pos, `${v} is out of range for FIXED (-128.0..127.996)`);
          e.c = u16(v * 256);
        }
        return T.fixed;
      case "BOOL": return this.err(e.pos, "BOOL() is not a conversion; compare with <> 0");
    }
  }

  unary(e: Expr & { k: "unary" }, cx: Cx): Type {
    if (e.op === "@") {
      const x = e.e;
      let root: Expr = x;
      while (root.k === "index" || root.k === "field") root = root.e;
      if (root.k !== "name" && root.k !== "deref") return this.err(e.pos, "@ needs a variable, array element, field or DATA");
      const t = this.expr(x, cx, true);
      if (t.k === "err") return t;
      if (root.k === "name") {
        const s = root.sym as Sym | undefined;
        if (!s || !(s.k === "var" || s.k === "local" || s.k === "data" || s.k === "port")) return this.err(e.pos, `cannot take the address of '${root.name}'`);
        if (s.k === "local") s.slot.addrTaken = true;
      }
      return { k: "pointer", to: t };
    }
    if (e.op === "-" && e.e.k === "num") e.e.negLit = true;
    const t = this.expr(e.e, cx);
    if (t.k === "err") return t;
    const c = e.e.c;
    if (e.op === "-") {
      if (!isNumeric(t)) return this.err(e.pos, `unary minus needs a number, not ${typeName(t)}`);
      if (t.k === "ulit") { e.c = -c!; return T.ulit; }
      if (c !== undefined) {
        e.c = u16(-s16(c));
        if (t.k === "fixed" && e.e.k === "num" && e.e.value > 32768) return this.err(e.e.pos, `-${e.e.value / 256} is out of range for FIXED (-128.0..127.996)`);
      }
      return t.k === "byte" ? T.word : t;
    }
    // NOT
    if (t.k === "bool") { if (c !== undefined) e.c = c ? 0 : 1; return T.bool; }
    if (t.k === "fixed" || !isInteger(t)) return this.err(e.pos, `NOT needs a BOOL or an integer, not ${typeName(t)}`);
    if (c !== undefined) e.c = t.k === "ulit" ? ~c & 0xffff : ~c & 0xffff;
    return t.k === "byte" ? T.word : t;
  }

  binary(e: Expr & { k: "binary" }, cx: Cx): Type {
    const lt = this.expr(e.l, cx), rt = this.expr(e.r, cx);
    if (lt.k === "err" || rt.k === "err") return T.err;
    const op = e.op;
    const show = `'${op}'`;
    const isCmp = op === "=" || op === "<>" || op === "<" || op === "<=" || op === ">" || op === ">=";

    // BOOL operands
    if (lt.k === "bool" || rt.k === "bool") {
      if (lt.k === "bool" && rt.k === "bool" && (op === "AND" || op === "OR" || op === "XOR" || op === "=" || op === "<>")) {
        if (e.l.c !== undefined && e.r.c !== undefined) e.c = foldTyped(op, e.l.c, e.r.c, false, false);
        return T.bool;
      }
      return this.err(e.opPos, `${show} cannot be applied to BOOL${lt.k === rt.k ? "" : ` and ${typeName(lt.k === "bool" ? rt : lt)}`}`);
    }
    // pointers
    if (lt.k === "pointer" || rt.k === "pointer" || lt.k === "nil" || rt.k === "nil") {
      if (op === "=" || op === "<>") {
        const ok = (lt.k === "nil" || rt.k === "nil") ? (lt.k !== "ulit" && rt.k !== "ulit") : typeEq(lt, rt);
        if (!ok) return this.err(e.opPos, `cannot compare ${typeName(lt)} with ${typeName(rt)}`);
        return T.bool;
      }
      return this.err(e.opPos, `${show} cannot be applied to pointers (convert with WORD() for arithmetic)`);
    }
    if (!isNumeric(lt) || !isNumeric(rt)) return this.err(e.opPos, `${show} needs numbers, not ${typeName(isNumeric(lt) ? rt : lt)}`);

    // both untyped constants: exact arithmetic
    if (lt.k === "ulit" && rt.k === "ulit") {
      const v = foldUlit(op, e.l.c!, e.r.c!);
      if (v === null) return this.err(e.opPos, "constant expression overflows");
      e.c = v;
      return isCmp ? T.bool : T.ulit;
    }

    let result: Type;
    if (op === "SHL" || op === "SHR") {
      if (rt.k === "fixed") return this.err(e.r.pos, "a shift count must be an integer");
      if (rt.k === "ulit" && (e.r.c! < 0)) return this.err(e.r.pos, `shift count ${e.r.c} is negative`);
      if (lt.k === "ulit") this.coerce(e.l, rt.k === "byte" ? T.word : rt, "shift");
      if (e.r.t!.k === "ulit") { e.r.c = e.r.c! & 15; e.r.t = T.word; } // counts are taken mod 16, as the hardware does
      result = e.l.t!.k === "byte" ? T.word : e.l.t!;
    } else if (op === "*" || op === "/" || op === "MOD") {
      const lf = lt.k === "fixed", rf = rt.k === "fixed";
      if (lf || rf) {
        if (op === "MOD") return this.err(e.opPos, "MOD is not defined for FIXED");
        if (lf && rf) {
          if (op === "/") return this.err(e.opPos, "FIXED / FIXED is not supported; divide by an INT, or TRUNC first");
          result = T.fixed;
        } else {
          const other = lf ? e.r : e.l;
          if (!lf && op === "/") return this.err(e.opPos, "INT / FIXED is not supported");
          if (other.t!.k === "ulit") this.coerce(other, T.int, "operand");
          else if (other.t!.k !== "int") return this.err(e.opPos, `cannot mix FIXED and ${typeName(other.t!)} in ${show}`);
          result = T.fixed;
        }
      } else {
        const u = this.unify(e, lt, rt);
        if (u.k === "err") return u;
        result = u.k === "byte" ? T.word : u;
      }
    } else if (op === "AND" || op === "OR" || op === "XOR") {
      if (lt.k === "fixed" || rt.k === "fixed") return this.err(e.opPos, `${show} needs integers; use WORD() on FIXED values`);
      const u = this.unify(e, lt, rt);
      if (u.k === "err") return u;
      result = u.k === "byte" ? T.word : u;
    } else {
      const u = this.unify(e, lt, rt);
      if (u.k === "err") return u;
      result = isCmp ? T.bool : u.k === "byte" ? T.word : u;
    }
    if (e.l.c !== undefined && e.r.c !== undefined) {
      const signed = isSigned(e.l.t!) || isSigned(e.r.t!);
      const fmul = op === "*" && e.l.t!.k === "fixed" && e.r.t!.k === "fixed";
      e.c = foldTyped(op, u16(e.l.c), u16(e.r.c), signed, fmul);
    }
    return result;
  }

  /** Operand type for + - comparisons and bitwise ops; adapts constants. */
  unify(e: Expr & { k: "binary" }, lt: Type, rt: Type): Type {
    if (lt.k === "ulit") return this.coerce(e.l, rt.k === "byte" ? T.word : rt, `operand of '${e.op}'`) ? e.l.t! : T.err;
    if (rt.k === "ulit") return this.coerce(e.r, lt.k === "byte" ? T.word : lt, `operand of '${e.op}'`) ? e.r.t! : T.err;
    if (lt.k === rt.k) return lt;
    if ((lt.k === "byte" || lt.k === "word") && (rt.k === "byte" || rt.k === "word")) return T.word;
    if (lt.k === "fixed" || rt.k === "fixed")
      return this.err(e.opPos, `cannot mix ${typeName(lt)} and ${typeName(rt)} in '${e.op}' (use FIXED(i) or TRUNC(f))`);
    return this.err(e.opPos, `cannot mix ${typeName(lt)} and ${typeName(rt)} in '${e.op}' (convert one side with INT() or WORD())`);
  }
}

function align(v: number, a: number) { return Math.ceil(v / a) * a; }

/** Constant folding with 16-bit machine semantics (values given as 0..65535). */
export function foldTyped(op: string, a: number, b: number, signed: boolean, fmul: boolean): number {
  const as = s16(a), bs = s16(b);
  switch (op) {
    case "+": return u16(a + b);
    case "-": return u16(a - b);
    case "*": return fmul ? u16((as * bs) >> 8) : u16(signed ? as * bs : a * b);
    case "/": return b === 0 ? 0 : signed ? u16(Math.trunc(as / bs)) : Math.floor(a / b);
    case "MOD": return b === 0 ? a : signed ? u16(as - Math.trunc(as / bs) * bs) : a % b;
    case "SHL": return (a << (b & 15)) & 0xffff;
    case "SHR": return signed ? u16(as >> (b & 15)) : a >>> (b & 15);
    case "AND": return a & b;
    case "OR": return a | b;
    case "XOR": return a ^ b;
    case "=": return a === b ? 1 : 0;
    case "<>": return a !== b ? 1 : 0;
    case "<": return (signed ? as < bs : a < b) ? 1 : 0;
    case "<=": return (signed ? as <= bs : a <= b) ? 1 : 0;
    case ">": return (signed ? as > bs : a > b) ? 1 : 0;
    default: return (signed ? as >= bs : a >= b) ? 1 : 0;
  }
}

/** Exact folding of untyped integer constants; null on overflow. */
function foldUlit(op: string, a: number, b: number): number | null {
  let v: number;
  switch (op) {
    case "+": v = a + b; break;
    case "-": v = a - b; break;
    case "*": v = a * b; break;
    case "/": v = b === 0 ? 0 : Math.trunc(a / b); break;
    case "MOD": v = b === 0 ? a : a - Math.trunc(a / b) * b; break;
    case "SHL": v = a * 2 ** Math.min(b, 40); break;
    case "SHR": v = Math.floor(a / 2 ** Math.min(b, 40)); break;
    case "AND": v = Number(BigInt(a) & BigInt(b)); break;
    case "OR": v = Number(BigInt(a) | BigInt(b)); break;
    case "XOR": v = Number(BigInt(a) ^ BigInt(b)); break;
    case "=": return a === b ? 1 : 0;
    case "<>": return a !== b ? 1 : 0;
    case "<": return a < b ? 1 : 0;
    case "<=": return a <= b ? 1 : 0;
    case ">": return a > b ? 1 : 0;
    default: return a >= b ? 1 : 0;
  }
  return Math.abs(v) > 2 ** 40 ? null : v;
}

// ---------------------------------------------------------------------------- control flow

/** Can control reach the end of this statement list? */
export function fallsThrough(list: Stmt[]): boolean {
  for (const s of list) if (!stmtFalls(s)) return false;
  return true;
}

function stmtFalls(s: Stmt): boolean {
  switch (s.k) {
    case "return": case "exit": return false;
    case "if": return !s.els || s.arms.some((a) => fallsThrough(a.body)) || fallsThrough(s.els);
    case "case": return !s.els || s.arms.some((a) => fallsThrough(a.body)) || fallsThrough(s.els);
    case "while": return !(s.cond.c === 1 && !hasExit(s.body));
    case "repeat": return !(s.cond.c === 0 && !hasExit(s.body));
    default: return true;
  }
}

/** Does the list contain an EXIT that leaves this loop (not one of its inner loops)? */
export function hasExit(list: Stmt[]): boolean {
  for (const s of list) {
    if (s.k === "exit") return true;
    if (s.k === "if" && (s.arms.some((a) => hasExit(a.body)) || (s.els && hasExit(s.els)))) return true;
    if (s.k === "case" && (s.arms.some((a) => hasExit(a.body)) || (s.els && hasExit(s.els)))) return true;
  }
  return false;
}

export { u16, s16 };
