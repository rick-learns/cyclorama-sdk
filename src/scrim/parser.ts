// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// SCRIM parser: tokens -> AST (docs/scrim-spec.md §3-§6). Stops at the first syntax error.
import { CompileError, lex, type Pos, type Token } from "./lexer.ts";
import type { Type } from "./types.ts";

// ---------------------------------------------------------------------------- AST

export type BinOp = "+" | "-" | "*" | "/" | "MOD" | "SHL" | "SHR" | "AND" | "OR" | "XOR" | "=" | "<>" | "<" | "<=" | ">" | ">=";
export type ConvName = "BYTE" | "WORD" | "INT" | "FIXED" | "BOOL";

/** Annotations written by the checker (check.ts) and read by the code generator. */
export type Ann = {
  t?: Type;          // type
  c?: number | undefined; // constant value (typed: 0..65535; untyped integer constants: exact)
  sym?: unknown;     // resolved symbol for names and calls (check.ts Sym)
  negLit?: boolean;  // a literal directly under unary minus (range checked after folding)
};

export type Expr = (
  | { k: "num"; value: number; fixed: boolean }
  | { k: "str"; bytes: number[] }
  | { k: "bool"; value: boolean }
  | { k: "nil" }
  | { k: "name"; name: string }
  | { k: "unary"; op: "-" | "NOT" | "@"; e: Expr }
  | { k: "binary"; op: BinOp; l: Expr; r: Expr; opPos: Pos }
  | { k: "index"; e: Expr; index: Expr }
  | { k: "field"; e: Expr; name: string; namePos: Pos }
  | { k: "deref"; e: Expr }
  | { k: "call"; callee: Expr; args: Expr[]; typeArg?: TypeNode | undefined }
  | { k: "conv"; to: ConvName; e: Expr }
) & { pos: Pos } & Ann;

export type TypeNode = (
  | { k: "prim"; name: ConvName }
  | { k: "named"; name: string }
  | { k: "array"; len: Expr | null; elem: TypeNode }
  | { k: "record"; fields: { name: string; pos: Pos; type: TypeNode }[] }
  | { k: "pointer"; to: TypeNode }
) & { pos: Pos };

export type CaseLabel = { lo: Expr; hi: Expr | null };

export type Stmt = (
  | { k: "assign"; target: Expr; value: Expr }
  | { k: "call"; call: Expr }
  | { k: "if"; arms: { cond: Expr; body: Stmt[] }[]; els: Stmt[] | null }
  | { k: "while"; cond: Expr; body: Stmt[] }
  | { k: "repeat"; body: Stmt[]; cond: Expr }
  | { k: "for"; v: Expr; from: Expr; to: Expr; step: Expr | null; down: boolean; body: Stmt[]; limitSlot?: unknown; stepValue?: number }
  | { k: "case"; e: Expr; arms: { labels: CaseLabel[]; body: Stmt[] }[]; els: Stmt[] | null }
  | { k: "exit" }
  | { k: "return"; value: Expr | null }
  | { k: "wait" }
  | { k: "asm"; lines: { text: string; pos: Pos }[] }
) & { pos: Pos };

export type Init =
  | { k: "expr"; e: Expr; pos: Pos }
  | { k: "list"; items: Init[]; pos: Pos }
  | { k: "str"; bytes: number[]; pos: Pos }
  | { k: "incbin"; path: string; pos: Pos };

export type Param = { name: string; pos: Pos; type: TypeNode };

export type ProcDecl = {
  k: "proc"; name: string; pos: Pos; kwPos: Pos;
  params: Param[]; result: TypeNode | null; isFunc: boolean; far: boolean; interrupt: boolean;
  decls: Decl[]; body: Stmt[]; endPos: Pos;
  /** EXTERN PROC/FUNC: an assembly routine (SCRIM calling convention) with no SCRIM body. */
  extern: boolean;
};

export type Decl =
  | { k: "const"; name: string; pos: Pos; value: Expr }
  | { k: "var"; name: string; pos: Pos; type: TypeNode; at: Expr | null }
  | { k: "port"; name: string; pos: Pos; type: TypeNode; at: Expr }
  | { k: "data"; name: string; pos: Pos; type: TypeNode; init: Init }
  | { k: "type"; name: string; pos: Pos; type: TypeNode }
  | ProcDecl
  | { k: "vector"; which: string; whichPos: Pos; handler: string; handlerPos: Pos; pos: Pos }
  | { k: "bank"; n: Expr; pos: Pos }
  /** EXTERN DATA / CONST / VAR: an assembly symbol given a SCRIM type (no storage emitted). */
  | { k: "extern"; what: "DATA" | "CONST" | "VAR"; name: string; pos: Pos; type: TypeNode }
  /** LINK "file.inc" (CYASM source) or ASSET "file.art|.song" (kit-converted data). */
  | { k: "link"; asset: boolean; path: string; pos: Pos; pathPos: Pos }
  /** Module-level ASM ... END: CYASM placed in the current bank's link area. */
  | { k: "asm"; lines: { text: string; pos: Pos }[]; pos: Pos };

export type HeaderField = { key: string; pos: Pos; value: Expr | null; str: number[] | null; valuePos: Pos };

export type Program = {
  name: string; pos: Pos; header: HeaderField[]; decls: Decl[]; body: Stmt[]; bodyPos: Pos; endPos: Pos;
};

// ---------------------------------------------------------------------------- parser

export type IncludeLoader = (fromFile: string, path: string, pos: Pos) => { file: string; text: string };

const CONV = new Set(["BYTE", "WORD", "INT", "FIXED", "BOOL"]);
const MUL_OPS = new Set(["*", "/", "MOD", "SHL", "SHR", "AND"]);
const ADD_OPS = new Set(["+", "-", "OR", "XOR"]);
const REL_OPS = new Set(["=", "<>", "<", "<=", ">", ">="]);

class Parser {
  toks: Token[];
  i = 0;
  loader: IncludeLoader;
  includeStack: string[];

  constructor(toks: Token[], loader: IncludeLoader, stack: string[]) { this.toks = toks; this.loader = loader; this.includeStack = stack; }

  get t(): Token { return this.toks[this.i]; }
  peek(n = 1): Token { return this.toks[Math.min(this.i + n, this.toks.length - 1)]; }
  next(): Token { const t = this.t; if (t.kind !== "eof") this.i++; return t; }
  is(text: string): boolean { const t = this.t; return (t.kind === "kw" || t.kind === "op") && t.text === text; }
  isAt(n: number, text: string): boolean { const t = this.peek(n); return (t.kind === "kw" || t.kind === "op") && t.text === text; }
  accept(text: string): boolean { if (this.is(text)) { this.i++; return true; } return false; }
  fail(msg: string, at: Token = this.t): never { throw new CompileError(at.pos, msg); }
  describe(t: Token): string { return t.kind === "eof" ? "end of file" : t.kind === "asm" ? "ASM block" : `'${t.text}'`; }
  expect(text: string, what = text): Token {
    if (!this.is(text)) this.fail(`expected ${what}, found ${this.describe(this.t)}`);
    return this.next();
  }
  ident(what = "a name"): { name: string; pos: Pos } {
    const t = this.t;
    if (t.kind !== "ident") this.fail(`expected ${what}, found ${t.kind === "kw" ? `keyword ${t.text}` : this.describe(t)}`);
    this.i++;
    return { name: t.text, pos: t.pos };
  }

  // -- program ---------------------------------------------------------------
  program(): Program {
    const kw = this.expect("PROGRAM");
    const name = this.ident("the program name");
    this.expect(";");
    const header: HeaderField[] = [];
    if (this.accept("HEADER")) {
      do {
        const key = this.ident("a HEADER field (title, dev, date, version, ram, generation)");
        this.expect("=");
        const vt = this.t;
        if (vt.kind === "string") { this.next(); header.push({ key: key.name, pos: key.pos, value: null, str: vt.bytes, valuePos: vt.pos }); }
        else header.push({ key: key.name, pos: key.pos, value: this.expr(), str: null, valuePos: vt.pos });
      } while (this.accept(","));
      this.expect(";");
    }
    const decls = this.decls(true);
    const bodyPos = this.expect("BEGIN", "BEGIN (the main body) or a declaration").pos;
    const body = this.stmts();
    const endPos = this.expect("END").pos;
    this.expect(".", "'.' after the program's final END");
    if (this.t.kind !== "eof") this.fail(`unexpected ${this.describe(this.t)} after the end of the program`);
    return { name: name.name, pos: kw.pos, header, decls, body, bodyPos, endPos };
  }

  /** Declarations until BEGIN (or end of file for included files). */
  decls(moduleLevel: boolean): Decl[] {
    const out: Decl[] = [];
    for (;;) {
      const t = this.t;
      if (this.accept("CONST")) {
        do {
          const n = this.ident("a constant name");
          this.expect("=");
          out.push({ k: "const", name: n.name, pos: n.pos, value: this.expr() });
          this.expect(";");
        } while (this.t.kind === "ident");
      } else if (this.accept("VAR")) {
        do {
          const names = this.identList("a variable name");
          this.expect(":");
          const type = this.type();
          let at: Expr | null = null;
          if (this.is("AT")) {
            if (!moduleLevel) this.fail("local variables cannot be placed with AT");
            this.next();
            at = this.expr();
            if (names.length > 1) throw new CompileError(names[1].pos, "AT places a single variable; declare one name per AT");
          }
          for (const n of names) out.push({ k: "var", name: n.name, pos: n.pos, type, at });
          this.expect(";");
        } while (this.t.kind === "ident");
      } else if (moduleLevel && this.accept("PORT")) {
        do {
          const n = this.ident("a port name");
          this.expect(":");
          const type = this.type();
          this.expect("AT", "AT address (a PORT needs an address)");
          out.push({ k: "port", name: n.name, pos: n.pos, type, at: this.expr() });
          this.expect(";");
        } while (this.t.kind === "ident");
      } else if (moduleLevel && this.accept("DATA")) {
        do {
          const n = this.ident("a DATA name");
          this.expect(":");
          const type = this.type();
          this.expect("=", "'=' and an initialiser (DATA is read-only and must be initialised)");
          out.push({ k: "data", name: n.name, pos: n.pos, type, init: this.init() });
          this.expect(";");
        } while (this.t.kind === "ident");
      } else if (moduleLevel && this.accept("TYPE")) {
        do {
          const n = this.ident("a type name");
          this.expect("=");
          out.push({ k: "type", name: n.name, pos: n.pos, type: this.type() });
          this.expect(";");
        } while (this.t.kind === "ident");
      } else if (moduleLevel && (this.is("PROC") || this.is("FUNC") || this.is("FAR") || this.is("INTERRUPT"))) {
        out.push(this.proc());
      } else if (moduleLevel && this.accept("VECTOR")) {
        const which = this.ident("VBLANK, LINE, TIMER or TRAP");
        this.expect(":=");
        const h = this.ident("an INTERRUPT PROC name");
        this.expect(";");
        out.push({ k: "vector", which: which.name, whichPos: which.pos, handler: h.name, handlerPos: h.pos, pos: t.pos });
      } else if (moduleLevel && this.accept("BANK")) {
        const n = this.expr();
        this.expect(";");
        out.push({ k: "bank", n, pos: t.pos });
      } else if (moduleLevel && this.accept("EXTERN")) {
        if (this.is("PROC") || this.is("FUNC")) out.push(this.procHeader(t.pos, true));
        else if (this.is("DATA") || this.is("CONST") || this.is("VAR")) {
          const what = this.next().text as "DATA" | "CONST" | "VAR";
          do {
            const names = this.identList(`an EXTERN ${what} name`);
            this.expect(":", `':' and the type of EXTERN ${what} ${names[names.length - 1].name}`);
            const type = this.type();
            for (const n of names) out.push({ k: "extern", what, name: n.name, pos: n.pos, type });
            if (this.is("=")) this.fail(`EXTERN ${what} has no initialiser: the linked assembly defines ${names.map((n) => n.name).join(", ")}`);
            this.expect(";");
          } while (this.t.kind === "ident");
        } else this.fail(`expected PROC, FUNC, DATA, CONST or VAR after EXTERN, found ${this.describe(this.t)}`);
      } else if (moduleLevel && (this.is("LINK") || this.is("ASSET"))) {
        const asset = this.next().text === "ASSET";
        const s = this.t;
        if (s.kind !== "string") this.fail(`${asset ? "ASSET" : "LINK"} needs a quoted file name`);
        this.next();
        this.expect(";");
        out.push({ k: "link", asset, path: String.fromCharCode(...s.bytes), pos: t.pos, pathPos: s.pos });
      } else if (moduleLevel && t.kind === "asm") {
        this.next();
        this.expect(";", "';' after the module-level ASM block's END");
        out.push({ k: "asm", lines: t.lines, pos: t.pos });
      } else if (moduleLevel && this.accept("INCLUDE")) {
        const s = this.t;
        if (s.kind !== "string") this.fail("INCLUDE needs a quoted file name");
        this.next();
        this.expect(";");
        const path = String.fromCharCode(...s.bytes);
        const loaded = this.loader(t.pos.file, path, s.pos);
        if (this.includeStack.includes(loaded.file)) throw new CompileError(s.pos, `recursive INCLUDE of '${loaded.file}'`);
        const sub = new Parser(lex(loaded.text, loaded.file), this.loader, [...this.includeStack, loaded.file]);
        out.push(...sub.decls(true));
        if (sub.t.kind !== "eof") sub.fail(`expected a declaration, found ${sub.describe(sub.t)} (included files hold declarations only)`);
      } else return out;
    }
  }

  identList(what: string): { name: string; pos: Pos }[] {
    const out = [this.ident(what)];
    while (this.accept(",")) out.push(this.ident(what));
    return out;
  }

  proc(): ProcDecl {
    const d = this.procHeader(this.t.pos, false);
    d.decls = this.decls(false);
    this.expect("BEGIN", "BEGIN or a local declaration (CONST, VAR)");
    d.body = this.stmts();
    d.endPos = this.expect("END").pos;
    this.expect(";", "';' after the procedure's END");
    return d;
  }

  /** [FAR | INTERRUPT] PROC|FUNC name [(params)] [: T]; (after EXTERN: PROC|FUNC only). */
  procHeader(kwPos: Pos, extern: boolean): ProcDecl {
    const far = !extern && this.accept("FAR");
    const interrupt = !far && !extern && this.accept("INTERRUPT");
    let isFunc = false;
    if (this.accept("FUNC")) isFunc = true;
    else this.expect("PROC", interrupt ? "PROC after INTERRUPT" : "PROC or FUNC");
    if (interrupt && isFunc) this.fail("an INTERRUPT handler is a PROC");
    const n = this.ident(isFunc ? "a function name" : "a procedure name");
    const params: Param[] = [];
    if (this.accept("(")) {
      if (!this.is(")")) {
        do {
          const names = this.identList("a parameter name");
          this.expect(":");
          const type = this.type();
          for (const p of names) params.push({ name: p.name, pos: p.pos, type });
        } while (this.accept(";"));
      }
      this.expect(")");
    }
    let result: TypeNode | null = null;
    if (isFunc) { this.expect(":", "':' and the function's result type"); result = this.type(); }
    else if (this.is(":")) this.fail("a PROC has no result type; use FUNC");
    this.expect(";");
    return { k: "proc", name: n.name, pos: n.pos, kwPos, params, result, isFunc, far, interrupt, decls: [], body: [], endPos: n.pos, extern };
  }

  type(): TypeNode {
    const t = this.t;
    if (t.kind === "kw" && CONV.has(t.text)) { this.next(); return { k: "prim", name: t.text as ConvName, pos: t.pos }; }
    if (t.kind === "ident") { this.next(); return { k: "named", name: t.text, pos: t.pos }; }
    if (this.accept("ARRAY")) {
      if (this.accept("OF")) return { k: "array", len: null, elem: this.type(), pos: t.pos };
      this.expect("[", "'[' and a size, or OF");
      const lens = [this.expr()];
      while (this.accept(",")) lens.push(this.expr());
      this.expect("]");
      this.expect("OF");
      let elem = this.type();
      for (let k = lens.length - 1; k >= 1; k--) elem = { k: "array", len: lens[k], elem, pos: lens[k].pos };
      return { k: "array", len: lens[0], elem, pos: t.pos };
    }
    if (this.accept("RECORD")) {
      const fields: { name: string; pos: Pos; type: TypeNode }[] = [];
      while (!this.is("END")) {
        const names = this.identList("a field name");
        this.expect(":");
        const type = this.type();
        for (const n of names) fields.push({ name: n.name, pos: n.pos, type });
        if (!this.accept(";")) break;
      }
      this.expect("END", "END to close the RECORD");
      return { k: "record", fields, pos: t.pos };
    }
    if (this.accept("POINTER")) {
      this.expect("TO");
      return { k: "pointer", to: this.type(), pos: t.pos };
    }
    return this.fail(`expected a type, found ${this.describe(t)}`);
  }

  init(): Init {
    const t = this.t;
    if (t.kind === "string") { this.next(); return { k: "str", bytes: t.bytes, pos: t.pos }; }
    if (this.accept("INCBIN")) {
      const s = this.t;
      if (s.kind !== "string") this.fail("INCBIN needs a quoted file name");
      this.next();
      return { k: "incbin", path: String.fromCharCode(...s.bytes), pos: s.pos };
    }
    if (this.is("(") && this.looksLikeList()) {
      this.next();
      const items: Init[] = [this.init()];
      while (this.accept(",")) items.push(this.init());
      this.expect(")");
      return { k: "list", items, pos: t.pos };
    }
    return { k: "expr", e: this.expr(), pos: t.pos };
  }

  /** At '(': is this an initialiser list (has a top-level comma or nested list) rather than a parenthesised expression? */
  looksLikeList(): boolean {
    let depth = 0;
    for (let j = this.i; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t.kind === "eof") return false;
      if (t.kind === "string" && depth === 1) return true;
      if (t.kind !== "op") continue;
      if (t.text === "(") { depth++; if (depth === 2 && j === this.i + 1) return true; }
      else if (t.text === ")") { depth--; if (depth === 0) return false; }
      else if (t.text === "," && depth === 1) return true;
    }
    return false;
  }

  // -- statements ------------------------------------------------------------
  stmts(): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      const s = this.stmt();
      if (s) out.push(s);
      if (!this.accept(";")) return out;
    }
  }

  /** Statements of a CASE arm: stop before a new label list, ELSE or END. */
  armStmts(): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      const s = this.stmt();
      if (s) out.push(s);
      if (!this.accept(";")) return out;
      if (this.is("ELSE") || this.is("END") || this.caseLabelsAhead()) return out;
    }
  }

  caseLabelsAhead(): boolean {
    const save = this.i;
    try { this.caseLabels(); return this.is(":"); }
    catch (e) { if (e instanceof CompileError) return false; throw e; }
    finally { this.i = save; }
  }

  caseLabels(): CaseLabel[] {
    const out: CaseLabel[] = [];
    do {
      const lo = this.expr();
      const hi = this.accept("..") ? this.expr() : null;
      out.push({ lo, hi });
    } while (this.accept(","));
    return out;
  }

  stmt(): Stmt | null {
    const t = this.t;
    const pos = t.pos;
    if (t.kind === "asm") { this.next(); return { k: "asm", lines: t.lines, pos }; }
    if (t.kind === "kw") {
      switch (t.text) {
        case "IF": {
          this.next();
          const arms: { cond: Expr; body: Stmt[] }[] = [];
          const cond = this.expr();
          this.expect("THEN");
          arms.push({ cond, body: this.stmts() });
          let els: Stmt[] | null = null;
          for (;;) {
            if (this.accept("ELSIF")) { const c = this.expr(); this.expect("THEN"); arms.push({ cond: c, body: this.stmts() }); continue; }
            if (this.accept("ELSE")) els = this.stmts();
            break;
          }
          this.expect("END", "END to close the IF");
          return { k: "if", arms, els, pos };
        }
        case "WHILE": {
          this.next();
          const cond = this.expr();
          this.expect("DO");
          const body = this.stmts();
          this.expect("END", "END to close the WHILE");
          return { k: "while", cond, body, pos };
        }
        case "REPEAT": {
          this.next();
          const body = this.stmts();
          this.expect("UNTIL", "UNTIL to close the REPEAT");
          return { k: "repeat", body, cond: this.expr(), pos };
        }
        case "FOR": {
          this.next();
          const v = this.ident("the loop variable");
          this.expect(":=");
          const from = this.expr();
          let down = false;
          if (this.accept("DOWNTO")) down = true;
          else this.expect("TO", "TO or DOWNTO");
          const to = this.expr();
          const step = this.accept("STEP") ? this.expr() : null;
          this.expect("DO");
          const body = this.stmts();
          this.expect("END", "END to close the FOR");
          return { k: "for", v: { k: "name", name: v.name, pos: v.pos }, from, to, step, down, body, pos };
        }
        case "CASE": {
          this.next();
          const e = this.expr();
          this.expect("OF");
          const arms: { labels: CaseLabel[]; body: Stmt[] }[] = [];
          while (!this.is("ELSE") && !this.is("END")) {
            const labels = this.caseLabels();
            this.expect(":", "':' after the CASE labels");
            arms.push({ labels, body: this.armStmts() });
          }
          const els = this.accept("ELSE") ? this.stmts() : null;
          this.expect("END", "END to close the CASE");
          return { k: "case", e, arms, els, pos };
        }
        case "EXIT": this.next(); return { k: "exit", pos };
        case "WAIT": this.next(); return { k: "wait", pos };
        case "RETURN": {
          this.next();
          const ends = this.is(";") || this.is("END") || this.is("ELSE") || this.is("ELSIF") || this.is("UNTIL");
          return { k: "return", value: ends ? null : this.expr(), pos };
        }
        case "END": case "ELSE": case "ELSIF": case "UNTIL": return null; // empty statement
      }
    }
    if (this.is(";")) return null;
    if (t.kind !== "ident" && !this.is("^") && !this.is("(")) {
      if (t.kind === "kw" && t.text === "BEGIN") this.fail("BEGIN ... END blocks are not statements; statements need no grouping");
      this.fail(`expected a statement, found ${this.describe(t)}`);
    }
    const target = this.unary();
    if (this.accept(":=")) return { k: "assign", target, value: this.expr(), pos };
    if (target.k === "call" || target.k === "name") return { k: "call", call: target, pos };
    if (this.is("=")) this.fail("expected ':=' (assignment), found '='");
    return this.fail(`expected ':=' or a procedure call, found ${this.describe(this.t)}`);
  }

  // -- expressions ------------------------------------------------------------
  expr(): Expr {
    const l = this.simple();
    const t = this.t;
    if (t.kind === "op" && REL_OPS.has(t.text)) {
      this.next();
      const r = this.simple();
      const n = this.t;
      if (n.kind === "op" && REL_OPS.has(n.text)) this.fail("comparisons do not chain; use parentheses and AND");
      return { k: "binary", op: t.text as BinOp, l, r, opPos: t.pos, pos: l.pos };
    }
    return l;
  }

  simple(): Expr {
    let l = this.term();
    for (;;) {
      const t = this.t;
      if ((t.kind === "op" || t.kind === "kw") && ADD_OPS.has(t.text)) {
        this.next();
        l = { k: "binary", op: t.text as BinOp, l, r: this.term(), opPos: t.pos, pos: l.pos };
      } else return l;
    }
  }

  term(): Expr {
    let l = this.unary();
    for (;;) {
      const t = this.t;
      if ((t.kind === "op" || t.kind === "kw") && MUL_OPS.has(t.text)) {
        this.next();
        l = { k: "binary", op: t.text as BinOp, l, r: this.unary(), opPos: t.pos, pos: l.pos };
      } else return l;
    }
  }

  unary(): Expr {
    const t = this.t;
    if (this.accept("-")) return { k: "unary", op: "-", e: this.unary(), pos: t.pos };
    if (this.accept("NOT")) return { k: "unary", op: "NOT", e: this.unary(), pos: t.pos };
    if (this.accept("@")) return { k: "unary", op: "@", e: this.unary(), pos: t.pos };
    if (this.accept("^")) return { k: "deref", e: this.unary(), pos: t.pos };
    return this.postfix(this.primary());
  }

  postfix(e: Expr): Expr {
    for (;;) {
      const t = this.t;
      if (this.accept("[")) {
        const idx = [this.expr()];
        while (this.accept(",")) idx.push(this.expr());
        this.expect("]");
        for (const i of idx) e = { k: "index", e, index: i, pos: t.pos };
      } else if (this.accept(".")) {
        const f = this.ident("a field name");
        e = { k: "field", e, name: f.name, namePos: f.pos, pos: f.pos };
      } else if (this.accept("^")) {
        e = { k: "deref", e, pos: t.pos };
      } else if (this.is("(") && (e.k === "name")) {
        this.next();
        const args: Expr[] = [];
        let typeArg: TypeNode | undefined;
        if (!this.is(")")) {
          do {
            // SIZEOF(ARRAY ... / RECORD ... / POINTER TO ...) takes a type
            if (e.name === "SIZEOF" && (this.is("ARRAY") || this.is("RECORD") || this.is("POINTER"))) typeArg = this.type();
            else args.push(this.expr());
          } while (this.accept(","));
        }
        this.expect(")");
        e = { k: "call", callee: e, args, typeArg, pos: e.pos };
      } else return e;
    }
  }

  primary(): Expr {
    const t = this.t;
    switch (t.kind) {
      case "int": this.next(); return { k: "num", value: t.value, fixed: false, pos: t.pos };
      case "fixed": this.next(); return { k: "num", value: t.value, fixed: true, pos: t.pos };
      case "string": this.next(); return { k: "str", bytes: t.bytes, pos: t.pos };
      case "ident": this.next(); return { k: "name", name: t.text, pos: t.pos };
      case "kw":
        if (t.text === "TRUE" || t.text === "FALSE") { this.next(); return { k: "bool", value: t.text === "TRUE", pos: t.pos }; }
        if (t.text === "NIL") { this.next(); return { k: "nil", pos: t.pos }; }
        if (CONV.has(t.text)) {
          this.next();
          if (!this.is("(")) {
            // a type keyword used as SIZEOF's argument
            return { k: "name", name: t.text, pos: t.pos };
          }
          this.next();
          const e = this.expr();
          this.expect(")");
          return { k: "conv", to: t.text as ConvName, e, pos: t.pos };
        }
        break;
      case "op":
        if (t.text === "(") { this.next(); const e = this.expr(); this.expect(")"); return e; }
        break;
    }
    return this.fail(`expected an expression, found ${t.kind === "kw" ? `keyword ${t.text}` : this.describe(t)}`);
  }
}

export function parse(src: string, file: string, loader: IncludeLoader): Program {
  return new Parser(lex(src, file), loader, [file]).program();
}
