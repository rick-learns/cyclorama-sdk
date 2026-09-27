// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// SCRIM code generator: checked AST -> CYASM text lines (docs/scrim-spec.md §4-§6).
//
// Register use: expression temporaries in R0-R3 (a "register stack": an expression evaluated
// at depth d leaves its value in Rd and may use Rd..R3; R0..R(d-1) are live). R4-R6 hold up to
// three scalar locals per procedure (callee-saved). R7 is the compiler's scratch register.
// Frames are addressed with [SP+d]; `depth` tracks bytes pushed since the statement began.
import type { Pos } from "./lexer.ts";
import type { Expr, Stmt } from "./parser.ts";
import { fallsThrough, u16, s16, type Checked, type ProcInfo, type Slot, type Sym, type VectorName } from "./check.ts";
import { isByteRange, isScalar, isSigned, sizeOf, type Type } from "./types.ts";
import { relativePath } from "./paths.ts";

export type Branch = { cc: string; target: string; long: boolean };
/** One generated line; `owner` names the procedure or runtime routine it belongs to (for the size report). */
export type Line = { text: string; pos: Pos | null; br?: Branch; owner?: string | undefined };

type Mode =
  | { m: "abs"; base: string; off: number }
  | { m: "sp"; off: number; word: boolean }          // off: frame offset at depth 0
  | { m: "ind"; r: number; base: string | null; off: number }
  | { m: "reg"; r: number };

export const INVERSE: Record<string, string> = { EQ: "NE", NE: "EQ", LO: "HS", HS: "LO", MI: "PL", PL: "MI", VS: "VC", VC: "VS", HI: "LS", LS: "HI", LT: "GE", GE: "LT", GT: "LE", LE: "GT" };
const MIRROR: Record<string, string> = { "=": "=", "<>": "<>", "<": ">", ">": "<", "<=": ">=", ">=": "<=" };
const CMP_CC: Record<string, [string, string]> = { "=": ["EQ", "EQ"], "<>": ["NE", "NE"], "<": ["LT", "LO"], "<=": ["LE", "LS"], ">": ["GT", "HI"], ">=": ["GE", "HS"] };
const ALU: Record<string, string> = { "+": "ADD", "-": "SUB", AND: "AND", OR: "OR", XOR: "XOR" };
const IND = "        ";

/** Immediate as text: small values decimal, $FF80-$FFFF as negative (quick-form eligible), else hex. */
export function fmt(v: number): string {
  const u = u16(v);
  if (u < 256) return String(u);
  if (u >= 0xff80) return String(u - 0x10000);
  return "$" + u.toString(16).toUpperCase().padStart(4, "0");
}
const R = (n: number) => `R${n}`;
const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

export function regList(regs: number[]): string {
  const out: string[] = [];
  const s = [...regs].sort((a, b) => a - b);
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `R${s[i]}-R${s[j]}` : `R${s[i]}`);
    i = j + 1;
  }
  return out.join(",");
}

type Frame = { size: number; saved: number[] };

export class Gen {
  ck: Checked;
  sections = new Map<number, Line[]>();
  cur: Line[] = [];
  pos: Pos | null = null;
  owner: string | undefined = undefined;
  depth = 0;
  proc!: ProcInfo;
  frame: Frame = { size: 0, saved: [] };
  loops: string[] = [];
  n = 0;
  runtime = new Set<string>();

  constructor(ck: Checked) { this.ck = ck; }

  // -------------------------------------------------------------------------- emission
  section(bank: number) {
    let s = this.sections.get(bank);
    if (!s) { s = []; this.sections.set(bank, s); }
    this.cur = s;
  }
  line(text: string) { this.cur.push({ text, pos: this.pos, owner: this.owner }); }
  ins(mn: string, ops = "") { this.line(IND + (ops ? `${mn.padEnd(4)} ${ops}` : mn)); }
  label(l: string) { this.line(`${l}:`); }
  newLabel() { return `__L${++this.n}`; }
  br(cc: string, target: string) { this.cur.push({ text: "", pos: this.pos, br: { cc, target, long: false }, owner: this.owner }); }
  comment(t: string) { this.line(`${IND}; ${t}`); }

  movImm(r: number, v: number) {
    const s = s16(v);
    if (s >= -128 && s <= 127) this.ins("MOVQ", `${R(r)}, #${s}`);
    else this.ins("MOV", `${R(r)}, #${fmt(v)}`);
  }
  addImm(r: number, v: number) {
    const s = s16(v);
    if (s === 0) return;
    if (s >= -128 && s <= 127) this.ins("ADDQ", `${R(r)}, #${s}`);
    else this.ins("ADD", `${R(r)}, #${fmt(v)}`);
  }
  /** ALU op Rd, src (src "#imm" or "Rn"); picks quick forms for ADD/SUB immediates. */
  alu(mn: string, d: number, src: string) {
    if (src.startsWith("#") && (mn === "ADD" || mn === "SUB")) {
      const v = parseImm(src);
      this.addImm(d, mn === "ADD" ? v : -v);
      return;
    }
    this.ins(mn, `${R(d)}, ${src}`);
  }
  adjustSp(bytes: number) {
    if (bytes === 0) return;
    if (bytes >= -256 && bytes <= 254) this.ins("ADD", `SP, #${bytes}`);
    else { this.ins("MOV", "R7, SP"); this.addImm(7, bytes); this.ins("MOV", "SP, R7"); }
  }

  // -------------------------------------------------------------------------- program
  program(): Line[] {
    const ck = this.ck;
    for (const p of ck.procs) this.procedure(p);
    this.procedure(ck.main);
    const out: Line[] = [];
    const add = (text: string) => out.push({ text, pos: null });
    const p = ck.program;
    add(`; SCRIM compiler output for PROGRAM ${p.name} (${p.pos.file}). Generated: do not edit.`);
    if (ck.consts.length) { add(""); add("; ---- constants"); for (const c of ck.consts) add(`${c.name} = ${c.value < 0 ? c.value : fmtEqu(c.value)}`); }
    if (ck.portEqus.length) { add(""); add("; ---- ports"); for (const q of ck.portEqus) add(`${q.name} = ${fmtEqu(q.addr)}`); }
    let end = ck.varsEnd;
    const rtVars: string[] = [];
    if (this.runtime.has("RANDOM") || this.runtime.has("SEED_RANDOM")) { end = Math.ceil(end / 2) * 2; rtVars.push(`__rnd = ${fmtEqu(end)}`); end += 2; }
    add("");
    add(`; ---- module variables (work RAM $8000-${fmtEqu(Math.max(end, 0x8000) - 1)})`);
    for (const g of ck.globals) add(`${g.name} = ${fmtEqu(g.addr)}${g.size !== 2 ? `    ; ${g.size} byte${g.size === 1 ? "" : "s"}` : ""}`);
    for (const v of rtVars) add(v);

    add("");
    add(`${IND}.org $0000`);
    const vec = (n: VectorName) => ck.vectors[n]?.label ?? "__irq_rti";
    add(`${IND}.word __start, ${vec("VBLANK")}, ${vec("LINE")}, ${vec("TIMER")}, ${vec("TRAP")}, 0, 0, 0`);
    const h = ck.header;
    add(`${IND}.header title=${asmString(h.title)}, dev=${fmtEqu(h.dev)}, date=$${h.date.toString(16).toUpperCase().padStart(8, "0")}, version=${fmtEqu(h.version)}, ram=${h.ram}, generation=${h.generation}`);
    add(`${IND}.org $0040`);
    out.push(...this.startup(end));
    const bank0 = this.sections.get(0) ?? [];
    out.push(...bank0);
    out.push(...this.runtimeLines());
    out.push(...this.dataLines(0));
    out.push(...this.linkLines(0));
    const banks = [...new Set([...this.sections.keys(), ...ck.data.map((d) => d.bank), ...ck.links.map((l) => l.bank)])].filter((b) => b !== 0).sort((a, b) => a - b);
    for (const b of banks) {
      add("");
      add(`${IND}.bank ${b}`);
      out.push(...(this.sections.get(b) ?? []));
      out.push(...this.dataLines(b));
      out.push(...this.linkLines(b));
    }
    return out;
  }

  /** LINK / ASSET includes and module-level ASM blocks of a bank, in declaration order (spec §10). */
  linkLines(bank: number): Line[] {
    const out: Line[] = [];
    const main = this.ck.program.pos.file;
    for (const l of this.ck.links.filter((x) => x.bank === bank)) {
      out.push({ text: "", pos: null });
      if (l.k === "include") {
        out.push({ text: `${IND}.align 2`, pos: l.pos }, { text: `${IND}.include ${asmString([...relativePath(main, l.file)].map((c) => c.charCodeAt(0)))}`, pos: l.pos });
        continue;
      }
      out.push({ text: `${IND}.align 2`, pos: l.pos });
      for (const a of l.lines) {
        const lead = a.text.length - a.text.trimStart().length;
        const text = a.text.trim();
        out.push({ text: /^[.\w]+:/.test(text) ? text : IND + text, pos: { file: a.pos.file, line: a.pos.line, col: a.pos.col + lead } });
      }
    }
    return out;
  }

  startup(varsEnd: number): Line[] {
    this.cur = [];
    this.pos = null;
    this.owner = "(startup)";
    this.line("");
    this.line("; ---- startup: SP = C000, display off, zero module variables, hide all sprites, run main");
    this.label("__start");
    this.ins("MOV", "R0, #$C000");
    this.ins("MOV", "SP, R0");
    this.ins("MOVQ", "R0, #0");
    this.ins("ST", "R0, [VCTRL]");
    const words = Math.ceil((varsEnd - 0x8000) / 2);
    if (words > 0) {
      this.ins("MOV", "R1, #$8000");
      this.movImm(2, words);
      this.label("__zero");
      this.ins("ST", "R0, [R1]+");
      this.ins("ADDQ", "R2, #-1");
      this.ins("BNE", "__zero");
    }
    this.ins("ST", "R0, [OAMADDR]");
    this.ins("MOVQ", "R1, #2");
    this.ins("MOVQ", "R2, #64");
    this.label("__hide");
    this.ins("ST", "R0, [OAMDATA]");
    this.ins("ST", "R0, [OAMDATA]");
    this.ins("ST", "R0, [OAMDATA]");
    this.ins("ST", "R1, [OAMDATA]");
    this.ins("ADDQ", "R2, #-1");
    this.ins("BNE", "__hide");
    if (this.runtime.has("RANDOM") || this.runtime.has("SEED_RANDOM")) {
      this.ins("MOV", "R0, #$ACE1");
      this.ins("ST", "R0, [__rnd]");
    }
    this.ins("CALL", "__main");
    this.ins("STOP");
    this.label("__irq_rti");
    this.ins("RTI");
    this.owner = undefined;
    return this.cur;
  }

  dataLines(bank: number): Line[] {
    const out: Line[] = [];
    for (const d of this.ck.data.filter((x) => x.bank === bank)) {
      out.push({ text: "", pos: null }, { text: `${IND}.align 2`, pos: d.pos }, { text: `${d.name}:`, pos: d.pos });
      if (d.words) {
        for (let i = 0; i < d.bytes.length; i += 16) {
          const ws: string[] = [];
          for (let k = i; k < Math.min(i + 16, d.bytes.length); k += 2) ws.push(fmtEqu(d.bytes[k] | (d.bytes[k + 1] << 8)));
          out.push({ text: `${IND}.word ${ws.join(", ")}`, pos: d.pos });
        }
      } else {
        for (let i = 0; i < d.bytes.length; i += 16)
          out.push({ text: `${IND}.byte ${d.bytes.slice(i, i + 16).map((b) => "$" + b.toString(16).toUpperCase().padStart(2, "0")).join(", ")}`, pos: d.pos });
      }
    }
    return out;
  }

  runtimeLines(): Line[] {
    const lib = RUNTIME;
    const need = new Set<string>();
    const visit = (n: string) => {
      if (need.has(n)) return;
      need.add(n);
      for (const dep of lib.get(n)?.needs ?? []) visit(dep);
    };
    for (const n of this.runtime) visit(n);
    const out: Line[] = [];
    for (const [name, sec] of lib) {
      if (!need.has(name)) continue;
      out.push({ text: "", pos: null });
      for (const t of sec.lines) out.push({ text: t, pos: null, owner: name });
    }
    return out;
  }

  // -------------------------------------------------------------------------- procedures
  layout(p: ProcInfo): Frame {
    const regs: number[] = [];
    if (!p.hasAsm) {
      const cands = p.locals
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => isScalar(s.type) && !s.addrTaken && s.uses > 0)
        .sort((a, b) => b.s.uses - a.s.uses || a.i - b.i)
        .slice(0, 3);
      cands.forEach(({ s }, k) => { s.reg = 4 + k; regs.push(4 + k); });
    }
    let off = 0;
    for (const s of p.locals) {
      if (s.reg !== null) continue;
      s.off = off;
      s.wordSlot = isScalar(s.type) && sizeOf(s.type) === 1 && !s.addrTaken;
      off += isScalar(s.type) ? 2 : Math.ceil(sizeOf(s.type) / 2) * 2;
    }
    const saved = p.interrupt ? [0, 1, 2, 3, 4, 5, 6, 7] : p.isMain ? [] : regs;
    const base = off + 2 * saved.length + 2 + (p.far ? 4 : 0);
    p.params.forEach((s, i) => { s.off = base + 2 * i; s.wordSlot = sizeOf(s.type) === 1 && !s.addrTaken; });
    return { size: off, saved };
  }

  procedure(p: ProcInfo) {
    this.proc = p;
    this.frame = this.layout(p);
    this.depth = 0;
    this.loops = [];
    const d = p.decl;
    this.pos = d?.pos ?? p.pos;
    this.owner = p.isMain ? "(main)" : p.name;
    if (p.far) {
      // bank-0 trampoline: save BANK, select the procedure's bank, call, restore
      this.section(0);
      this.line("");
      this.line(`; FAR ${p.result ? "FUNC" : "PROC"} ${p.name}: trampoline to bank ${p.bank}`);
      this.label(p.label);
      this.ins("LD", "R7, [BANK]");
      this.ins("PUSH", "R7");
      this.movImm(7, p.bank);
      this.ins("ST", "R7, [BANK]");
      this.ins("CALL", p.bodyLabel);
      this.ins("POP", "R7");
      this.ins("ST", "R7, [BANK]");
      this.ins("RTS");
    }
    this.section(p.far ? p.bank : 0);
    this.line("");
    const kind = p.isMain ? "main body" : `${p.interrupt ? "INTERRUPT PROC" : p.result ? "FUNC" : "PROC"} ${p.name}`;
    const slots = [...p.params, ...p.locals].map((s) => `${s.name}=${s.reg !== null ? R(s.reg) : `[SP+${s.off}]`}`);
    this.line(`; ${kind}${slots.length ? ` (${slots.join(" ")})` : ""}`);
    this.label(p.bodyLabel);
    if (this.frame.saved.length) this.ins("PUSHM", regList(this.frame.saved));
    this.adjustSp(-this.frame.size);
    const body = p.isMain ? this.ck.program.body : d!.body;
    this.stmts(body);
    this.pos = p.endPos;
    if (fallsThrough(body)) this.epilogue();
    this.owner = undefined;
  }

  epilogue() {
    this.adjustSp(this.frame.size);
    if (this.frame.saved.length) this.ins("POPM", regList(this.frame.saved));
    this.ins(this.proc.interrupt ? "RTI" : "RTS");
  }

  // -------------------------------------------------------------------------- statements
  stmts(list: Stmt[]) { for (const s of list) this.stmt(s); }

  stmt(s: Stmt) {
    this.pos = s.pos;
    this.depth = 0;
    switch (s.k) {
      case "assign": return this.assign(s.target, s.value);
      case "call": this.call(s.call, 0); return;
      case "if": {
        const end = this.newLabel();
        s.arms.forEach((a, i) => {
          const last = i === s.arms.length - 1 && !s.els;
          const next = last ? end : this.newLabel();
          this.pos = a.cond.pos;
          this.cond(a.cond, next, false, 0);
          this.stmts(a.body);
          if (!last) {
            if (fallsThrough(a.body)) this.br("RA", end);
            this.label(next);
          }
        });
        if (s.els) this.stmts(s.els);
        this.label(end);
        return;
      }
      case "while": {
        const top = this.newLabel(), test = this.newLabel(), end = this.newLabel();
        if (s.cond.c === 0) return;
        const forever = s.cond.c === 1;
        if (!forever) this.br("RA", test);
        this.label(top);
        this.loops.push(end);
        this.stmts(s.body);
        this.loops.pop();
        this.pos = s.cond.pos;
        this.depth = 0;
        if (forever) this.br("RA", top);
        else { this.label(test); this.cond(s.cond, top, true, 0); }
        this.label(end);
        return;
      }
      case "repeat": {
        const top = this.newLabel(), end = this.newLabel();
        this.label(top);
        this.loops.push(end);
        this.stmts(s.body);
        this.loops.pop();
        this.pos = s.cond.pos;
        this.depth = 0;
        this.cond(s.cond, top, false, 0);
        this.label(end);
        return;
      }
      case "for": return this.forStmt(s);
      case "case": return this.caseStmt(s);
      case "exit": this.br("RA", this.loops[this.loops.length - 1]); return;
      case "return": {
        const p = this.proc;
        if (s.value && p.result) {
          const rr = this.regLocal(s.value);
          if (rr !== null) this.ins("MOV", `R0, ${R(rr)}`);
          else this.expr(s.value, 0);
          if (p.result.k === "byte" && !this.byteSafe(s.value)) this.ins("AND", "R0, #255");
        }
        this.epilogue();
        return;
      }
      case "wait": this.ins("WAI"); return;
      case "asm": {
        for (const l of s.lines) {
          const lead = l.text.length - l.text.trimStart().length;
          this.pos = { file: l.pos.file, line: l.pos.line, col: l.pos.col + lead };
          const text = this.substitute(l.text.trim());
          this.line(/^[.\w]+:/.test(text) ? text : IND + text);
        }
        return;
      }
    }
  }

  /** Replace SCRIM local names (parameters, locals, local constants) in an ASM operand field. */
  substitute(text: string): string {
    const p = this.proc;
    const slots = new Map<string, Slot>();
    for (const s of [...p.params, ...p.locals]) if (!s.hidden) slots.set(s.name, s);
    let out = "", i = 0, field = 0; // field: 0 = label/mnemonic still to come, 1 = operands
    const m = /^(\s*(?:[.\w]+:)?\s*)([.\w]+)?/.exec(text)!;
    out = m[0];
    i = m[0].length;
    field = 1;
    while (i < text.length) {
      const c = text[i];
      if (c === ";") { out += text.slice(i); break; }
      if (c === '"' || c === "'") {
        let k = i + 1;
        while (k < text.length && text[k] !== c) k += text[k] === "\\" ? 2 : 1;
        out += text.slice(i, k + 1);
        i = k + 1;
        continue;
      }
      if (c === "$" || c === "%" || /[0-9]/.test(c) || c === ".") {
        let k = i + 1;
        while (k < text.length && /[\w.]/.test(text[k])) k++;
        out += text.slice(i, k);
        i = k;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let k = i + 1;
        while (k < text.length && /\w/.test(text[k])) k++;
        const word = text.slice(i, k);
        const s = field ? slots.get(word) : undefined;
        if (s && s.reg === null) out += String(s.off);
        else if (field && p.localConsts.has(word)) out += String(p.localConsts.get(word));
        else out += word;
        i = k;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  assign(target: Expr, value: Expr) {
    const t = target.t!;
    if (!isScalar(t)) {
      // whole-array/record copy through MEMCPY(dst, src, n)
      this.movImm(0, sizeOf(t));
      this.push(0);
      this.addrValue(value, 0);
      this.push(0);
      this.addrValue(target, 0);
      this.push(0);
      this.ins("CALL", "MEMCPY");
      this.runtime.add("MEMCPY");
      this.adjustSp(6);
      this.depth -= 6;
      return;
    }
    const byte = sizeOf(t) === 1;
    const safe = this.byteSafe(value);
    const tr = this.regLocal(target);
    if (tr !== null) {
      if (value.c !== undefined) { this.movImm(tr, byte ? u16(value.c) & 0xff : value.c); return; }
      const vr = this.regLocal(value);
      if (vr !== null) {
        this.ins("MOV", `${R(tr)}, ${R(vr)}`);
        if (byte && !safe) this.ins("AND", `${R(tr)}, #255`);
        return;
      }
      if (value.k === "binary" && value.op in ALU && this.regLocal(value.l) === tr && value.t!.k !== "bool") {
        const src = this.operand(value.r, 0);
        this.alu(ALU[value.op], tr, src);
        if (byte && value.op !== "AND") this.ins("AND", `${R(tr)}, #255`);
        return;
      }
      if (this.isLeaf(value)) { this.loadInto(value, tr); if (byte && !safe) this.ins("AND", `${R(tr)}, #255`); return; }
      this.expr(value, 0);
      this.ins("MOV", `${R(tr)}, R0`);
      if (byte && !safe) this.ins("AND", `${R(tr)}, #255`);
      return;
    }
    // lv := lv op x on a memory lvalue: compute the address once (base kept in R1)
    if (value.k === "binary" && value.op in ALU && value.t!.k !== "bool" && target.k !== "name" && this.pure(target) && this.pure(value.r) && sameLvalue(value.l, target)) {
      const m = this.addr(target, 1);
      this.load(m, t, 0);
      this.alu(ALU[value.op], 0, this.operand(value.r, 2));
      this.store(m, t, 0, value.op === "AND" && safe, true);
      return;
    }
    const vr = this.regLocal(value);
    if (vr === null) this.expr(value, 0);
    const m = this.addr(target, vr === null ? 1 : 0);
    this.store(m, t, vr ?? 0, safe, vr === null);
  }

  forStmt(s: Stmt & { k: "for" }) {
    const v = s.v;
    const t = v.t!;
    const signed = isSigned(t), byte = t.k === "byte";
    const step = s.stepValue ?? 1;
    const down = s.down;
    const top = this.newLabel(), end = this.newLabel();
    this.assign(v, s.from);
    const hidden = s.limitSlot as Slot | undefined;
    let limitSrc: () => string;           // operand holding the limit (or sentinel) at the loop test
    const vreg = this.regLocal(v);
    const slotMode = (sl: Slot): Mode => (sl.reg !== null ? { m: "reg", r: sl.reg } : { m: "sp", off: sl.off, word: true });
    // entry test: skip the loop if the start is already past the limit
    const known = s.from.c !== undefined && s.to.c !== undefined;
    if (known) {
      const a = signed ? s16(s.from.c!) : u16(s.from.c!), b = signed ? s16(s.to.c!) : u16(s.to.c!);
      if (down ? a < b : a > b) return;
    }
    if (hidden) {
      this.pos = s.to.pos;
      this.expr(s.to, 0);
      this.store(slotMode(hidden), t, 0, true, true);
    }
    if (!known) {
      const vr = vreg ?? (this.loadInto(v, 0), 0);
      let src: string;
      if (s.to.c !== undefined) src = `#${fmt(s.to.c)}`;
      else if (hidden!.reg !== null) src = R(hidden!.reg);
      else { this.load(slotMode(hidden!), t, 1); src = "R1"; }
      this.cmpOp(vr, src);
      const [sc, uc] = down ? CMP_CC["<"] : CMP_CC[">"];
      this.br(signed ? sc : uc, end);
    }
    if (step === 1) {
      // sentinel = limit +/- 1 (wrapping); the loop ends when the variable reaches it
      const delta = down ? -1 : 1;
      if (s.to.c !== undefined) {
        const sent = byte ? u16(s.to.c + delta) & 0xff : u16(s.to.c + delta);
        limitSrc = () => `#${fmt(sent)}`;
      } else {
        const hm = slotMode(hidden!);
        if (hm.m === "reg") { this.addImm(hm.r, delta); if (byte) this.ins("AND", `${R(hm.r)}, #255`); limitSrc = () => R(hm.r); }
        else {
          this.load(hm, t, 0); this.addImm(0, delta); if (byte) this.ins("AND", "R0, #255"); this.store(hm, t, 0, true, true);
          limitSrc = () => { this.load(hm, t, 1); return "R1"; };
        }
      }
      this.label(top);
      this.loops.push(end);
      this.stmts(s.body);
      this.loops.pop();
      this.pos = s.pos;
      this.depth = 0;
      if (vreg !== null) {
        this.addImm(vreg, delta);
        if (byte) this.ins("AND", `${R(vreg)}, #255`);
        this.cmpOp(vreg, limitSrc());
      } else {
        this.loadInto(v, 0);
        this.addImm(0, delta);
        if (byte) this.ins("AND", "R0, #255");
        this.store(this.addr(v, 1), t, 0, true, true);
        this.cmpOp(0, limitSrc());
      }
      this.br("NE", top);
    } else {
      this.label(top);
      this.loops.push(end);
      this.stmts(s.body);
      this.loops.pop();
      this.pos = s.pos;
      this.depth = 0;
      // remaining = |limit - v| (unsigned, v has not passed the limit); advance; continue while remaining >= step
      const limitInto = (r: number) => {
        if (s.to.c !== undefined) this.movImm(r, s.to.c);
        else this.load(slotMode(hidden!), t, r);
      };
      const vr = vreg ?? (this.loadInto(v, 1), 1);
      if (down) { this.ins("MOV", `R0, ${R(vr)}`); limitInto(2); this.ins("SUB", "R0, R2"); }
      else { limitInto(0); this.ins("SUB", `R0, ${R(vr)}`); }
      this.addImm(vr, down ? -step : step);
      if (byte) this.ins("AND", `${R(vr)}, #255`);
      if (vreg === null) this.store(this.addr(v, 2), t, 1, true, true);
      this.cmpOp(0, `#${fmt(step)}`);
      this.br("HS", top);
    }
    this.label(end);
  }

  cmpOp(r: number, src: string) {
    if (src === "#0") this.ins("TST", `${R(r)}, ${R(r)}`);
    else this.ins("CMP", `${R(r)}, ${src}`);
  }

  caseStmt(s: Stmt & { k: "case" }) {
    const signed = s.e.t!.k === "int";
    const end = this.newLabel();
    const elseL = s.els ? this.newLabel() : end;
    const arms = s.arms.map((a) => ({ a, label: this.newLabel(), ranges: (a as { ranges?: [number, number][] }).ranges ?? [] }));
    const all = arms.flatMap((x) => x.ranges.map(([lo, hi]) => ({ lo, hi, label: x.label })));
    let count = 0, min = Infinity, max = -Infinity;
    for (const r of all) { count += r.hi - r.lo + 1; min = Math.min(min, r.lo); max = Math.max(max, r.hi); }
    const span = max - min + 1;
    const dense = all.length > 0 && count >= 4 && span <= 3 * count && span <= 256;
    const sr = this.regLocal(s.e);
    if (dense) {
      if (sr !== null) this.ins("MOV", `R0, ${R(sr)}`);
      else this.expr(s.e, 0);
      this.addImm(0, -min);
      this.ins("CMP", `R0, #${fmt(span - 1)}`);
      this.br("HI", elseL);
      const table = this.newLabel();
      this.ins("JMPT", `R0, ${table}`);
      this.label(table);
      const slots: string[] = [];
      for (let v = min; v <= max; v++) slots.push(all.find((r) => v >= r.lo && v <= r.hi)?.label ?? elseL);
      for (let i = 0; i < slots.length; i += 8) this.ins(".word", slots.slice(i, i + 8).join(", "));
    } else {
      let r = 0;
      if (sr !== null) r = sr;
      else this.expr(s.e, 0);
      for (const x of all) {
        if (x.lo === x.hi) { this.cmpOp(r, `#${fmt(x.lo)}`); this.br("EQ", x.label); }
        else {
          const skip = this.newLabel();
          this.cmpOp(r, `#${fmt(x.lo)}`);
          this.br(signed ? "LT" : "LO", skip);
          this.cmpOp(r, `#${fmt(x.hi)}`);
          this.br(signed ? "LE" : "LS", x.label);
          this.label(skip);
        }
      }
      this.br("RA", elseL);
    }
    arms.forEach(({ a, label }, i) => {
      this.label(label);
      this.stmts(a.body);
      this.depth = 0;
      const lastBeforeEnd = i === arms.length - 1 && !s.els;
      if (!lastBeforeEnd && fallsThrough(a.body)) this.br("RA", end);
    });
    if (s.els) { this.label(elseL); this.stmts(s.els); }
    this.label(end);
  }

  // -------------------------------------------------------------------------- symbols and modes
  slotOf(e: Expr): Slot | null {
    if (e.k !== "name") return null;
    const s = e.sym as Sym | undefined;
    return s?.k === "local" ? s.slot : null;
  }
  regLocal(e: Expr): number | null {
    if (e.c !== undefined) return null;
    const s = this.slotOf(e);
    return s && s.reg !== null ? s.reg : null;
  }
  byteSafe(e: Expr): boolean { return e.c !== undefined ? u16(e.c) <= 255 : isByteRange(e.t!); }
  isLeaf(e: Expr): boolean {
    if (e.k !== "name") return false;
    const s = e.sym as Sym | undefined;
    return !!s && (s.k === "var" || s.k === "port" || s.k === "data" || s.k === "local");
  }
  loadInto(e: Expr, r: number) { this.load(this.addr(e, r), e.t!, r); }

  /** Addressing mode for an lvalue; may use Rd..R3 (the base ends up in Rd). */
  addr(e: Expr, d: number): Mode {
    switch (e.k) {
      case "name": {
        const s = e.sym as Sym;
        switch (s.k) {
          case "var": return { m: "abs", base: s.asm, off: 0 };
          case "port": return { m: "abs", base: s.asm, off: 0 };
          case "data": return { m: "abs", base: s.label, off: 0 };
          case "local": return s.slot.reg !== null ? { m: "reg", r: s.slot.reg } : { m: "sp", off: s.slot.off, word: s.slot.wordSlot };
          default: throw new Error(`internal: no address for ${s.k} ${e.name}`);
        }
      }
      case "field": {
        const m = this.addr(e.e, d);
        const rt = e.e.t! as Type & { k: "record" };
        const fo = rt.fields.find((f) => f.name === e.name)!.off;
        return this.offset(m, fo);
      }
      case "index": {
        const at = e.e.t! as Type & { k: "array" };
        const size = sizeOf(at.elem);
        const m = this.addr(e.e, d);
        if (e.index.c !== undefined) {
          const iv = isSigned(e.index.t!) ? s16(e.index.c) : u16(e.index.c);
          return this.offset(m, iv * size);
        }
        if (m.m === "abs") {
          this.expr(e.index, d);
          this.scale(d, size);
          return { m: "ind", r: d, base: m.base, off: m.off };
        }
        if (m.m === "sp") {
          this.expr(e.index, d);
          this.scale(d, size);
          this.ins("MOV", "R7, SP");
          this.ins("ADD", `${R(d)}, R7`);
          return { m: "ind", r: d, base: null, off: m.off + this.depth };
        }
        if (m.m === "ind") {
          if (m.r !== d) this.ins("MOV", `${R(d)}, ${R(m.r)}`);
          const ir = this.withTemp(d + 1, (r) => { this.expr(e.index, r); this.scale(r, size); });
          this.ins("ADD", `${R(d)}, ${R(ir)}`);
          return { m: "ind", r: d, base: m.base, off: m.off };
        }
        throw new Error("internal: index of a register");
      }
      case "deref": {
        const pr = this.regLocal(e.e);
        if (pr !== null) return { m: "ind", r: pr, base: null, off: 0 };
        this.expr(e.e, d);
        return { m: "ind", r: d, base: null, off: 0 };
      }
      default: throw new Error(`internal: not an lvalue (${e.k})`);
    }
  }

  offset(m: Mode, by: number): Mode {
    switch (m.m) {
      case "abs": return { ...m, off: m.off + by };
      case "sp": return { m: "sp", off: m.off + by, word: false };
      case "ind": return { ...m, off: m.off + by };
      default: throw new Error("internal: offset of a register");
    }
  }

  scale(r: number, size: number) {
    if (size === 1) return;
    if (size === 2) { this.ins("ADD", `${R(r)}, ${R(r)}`); return; }
    if (isPow2(size)) { this.ins("SHL", `${R(r)}, #${Math.log2(size)}`); return; }
    this.ins("MUL", `${R(r)}, #${fmt(size)}`);
  }

  /** Run `f` with a free temporary at `d` (spilling R3 when all four are live); returns its register. */
  withTemp(d: number, f: (r: number) => void): number {
    if (d <= 3) { f(d); return d; }
    this.push(3);
    f(3);
    this.ins("MOV", "R7, R3");
    this.pop(3);
    return 7;
  }

  push(r: number) { this.ins("PUSH", R(r)); this.depth += 2; }
  pop(r: number) { this.ins("POP", R(r)); this.depth -= 2; }

  dispText(base: string | null, off: number): string {
    if (base === null) return String(off);
    return off === 0 ? base : `${base}+${off}`;
  }

  load(m: Mode, t: Type, r: number) {
    const byte = sizeOf(t) === 1;
    const op = byte ? "LDB" : "LD";
    switch (m.m) {
      case "abs": this.ins(op, `${R(r)}, [${this.dispText(m.base, m.off)}]`); return;
      case "ind": this.ins(op, `${R(r)}, [${R(m.r)}+${this.dispText(m.base, m.off)}]`.replace("+0]", "]")); return;
      case "reg": if (m.r !== r) this.ins("MOV", `${R(r)}, ${R(m.r)}`); return;
      case "sp": {
        const off = m.off + this.depth;
        if (!byte || m.word) {
          if (off <= 510) this.ins("LD", `${R(r)}, [SP+${off}]`);
          else { this.ins("MOV", "R7, SP"); this.ins("LD", `${R(r)}, [R7+${off}]`); }
        } else { this.ins("MOV", "R7, SP"); this.ins("LDB", `${R(r)}, [R7+${off}]`); }
      }
    }
  }

  /** Store Rv to m. `safe`: the value is already 0..255; `scratch`: Rv may be modified. */
  store(m: Mode, t: Type, v: number, safe: boolean, scratch: boolean) {
    const byte = sizeOf(t) === 1;
    const op = byte ? "STB" : "ST";
    switch (m.m) {
      case "abs": this.ins(op, `${R(v)}, [${this.dispText(m.base, m.off)}]`); return;
      case "ind": this.ins(op, `${R(v)}, [${R(m.r)}+${this.dispText(m.base, m.off)}]`.replace("+0]", "]")); return;
      case "reg":
        if (m.r !== v) this.ins("MOV", `${R(m.r)}, ${R(v)}`);
        if (byte && !safe) this.ins("AND", `${R(m.r)}, #255`);
        return;
      case "sp": {
        const off = m.off + this.depth;
        if (!byte || m.word) {
          if (byte && !safe) {
            if (!scratch) { this.ins("MOV", `R7, ${R(v)}`); v = 7; }
            this.ins("AND", `${R(v)}, #255`);
          }
          if (off <= 510) this.ins("ST", `${R(v)}, [SP+${off}]`);
          else { const tmp = v === 7 ? 3 : 7; if (tmp === 3) this.push(3); this.ins("MOV", `${R(tmp)}, SP`); this.ins("ST", `${R(v)}, [${R(tmp)}+${off + (tmp === 3 ? 2 : 0)}]`); if (tmp === 3) this.pop(3); }
        } else { this.ins("MOV", "R7, SP"); this.ins("STB", `${R(v)}, [R7+${off}]`); }
      }
    }
  }

  /** Address of an lvalue into Rd. */
  addrValue(e: Expr, d: number) {
    const m = this.addr(e, d);
    switch (m.m) {
      case "abs": this.ins("MOV", `${R(d)}, #${this.dispText(m.base, m.off)}`); return;
      case "sp": this.ins("MOV", `${R(d)}, SP`); this.addImm(d, m.off + this.depth); return;
      case "ind":
        if (m.r !== d) this.ins("MOV", `${R(d)}, ${R(m.r)}`);
        if (m.base !== null) this.ins("ADD", `${R(d)}, #${this.dispText(m.base, m.off)}`);
        else this.addImm(d, m.off);
        return;
      default: throw new Error("internal: address of a register variable");
    }
  }

  // -------------------------------------------------------------------------- expressions
  /** Source operand for an ALU op: "#imm", a register local, or the value evaluated at depth d. */
  operand(e: Expr, d: number): string {
    if (e.c !== undefined) return `#${fmt(e.c)}`;
    const rr = this.regLocal(e);
    if (rr !== null) return R(rr);
    return R(this.withTemp(d, (r) => this.expr(e, r)));
  }

  /** Evaluate e into Rd; R0..R(d-1) are live and preserved. */
  expr(e: Expr, d: number) {
    if (e.c !== undefined) { this.movImm(d, e.c); return; }
    if (e.k === "name" && (e.sym as Sym).k === "xconst") {
      // EXTERN CONST: the assembler supplies the value (BYTE keeps its low 8 bits)
      this.ins("MOVW", `${R(d)}, #${e.name}${sizeOf(e.t!) === 1 ? " & $FF" : ""}`);
      return;
    }
    switch (e.k) {
      case "name": case "index": case "field": case "deref": {
        const m = this.addr(e, d);
        this.load(m, e.t!, d);
        return;
      }
      case "unary": {
        if (e.op === "@") { this.addrValue(e.e, d); return; }
        this.expr(e.e, d);
        if (e.op === "-") this.ins("NEG", R(d));
        else if (e.t!.k === "bool") this.ins("XOR", `${R(d)}, #1`);
        else this.ins("NOT", R(d));
        return;
      }
      case "binary": return this.binary(e, d);
      case "call": {
        const s = e.sym as Sym;
        if (s.k === "proc") return this.call(e, d);
        this.expr(e.args[0], d);
        if (s.k === "builtin" && s.name === "TRUNC") { this.ins("SWPB", R(d)); this.ins("SXB", R(d)); } // ASR 8
        return;
      }
      case "conv": {
        this.expr(e.e, d);
        const st = e.e.t!;
        if (e.to === "BYTE" && !isByteRange(st)) this.ins("AND", `${R(d)}, #255`);
        if (e.to === "FIXED" && st.k !== "fixed") { this.ins("SWPB", R(d)); this.ins("AND", `${R(d)}, #$FF00`); }
        return;
      }
      default: throw new Error(`internal: cannot evaluate ${e.k}`);
    }
  }

  binary(e: Expr & { k: "binary" }, d: number) {
    const op = e.op;
    if (op in CMP_CC || e.t!.k === "bool") {
      // BOOL AND/OR with a simple right side: plain bitwise ops (both sides are 0/1)
      if ((op === "AND" || op === "OR" || op === "XOR") && (op === "XOR" || this.simpleBool(e.r))) {
        this.expr(e.l, d);
        this.alu(op, d, this.operand(e.r, d + 1));
        return;
      }
      const t = this.newLabel(), end = this.newLabel();
      this.cond(e, t, true, d);
      this.ins("MOVQ", `${R(d)}, #0`);
      this.br("RA", end);
      this.label(t);
      this.ins("MOVQ", `${R(d)}, #1`);
      this.label(end);
      return;
    }
    let l = e.l, r = e.r;
    const commutative = op === "+" || op === "*" || op === "AND" || op === "OR" || op === "XOR";
    if (commutative && ((l.c !== undefined && r.c === undefined) || (r.c === undefined && this.pure(l) && this.pure(r) && this.need(r) > this.need(l)))) [l, r] = [r, l];
    const signed = isSigned(l.t!) || isSigned(r.t!);
    if (op === "*") {
      const fmul = l.t!.k === "fixed" && r.t!.k === "fixed";
      this.expr(l, d);
      if (r.c !== undefined && !fmul) {
        const k = u16(r.c);
        if (k === 0) this.ins("MOVQ", `${R(d)}, #0`);
        else if (k === 1) { /* x * 1 */ }
        else if (k === 2) this.ins("ADD", `${R(d)}, ${R(d)}`);
        else if (isPow2(k)) this.ins("SHL", `${R(d)}, #${Math.log2(k)}`);
        else this.ins("MUL", `${R(d)}, #${fmt(k)}`);
        return;
      }
      this.ins(fmul ? "FMUL" : "MUL", `${R(d)}, ${this.operand(r, d + 1)}`);
      return;
    }
    if (op === "/" || op === "MOD") {
      this.expr(l, d);
      if (r.c !== undefined && !signed) {
        const k = u16(r.c);
        if (k === 0) { if (op === "/") this.ins("MOVQ", `${R(d)}, #0`); return; }
        if (isPow2(k)) {
          if (op === "/") { if (k > 1) this.ins("SHR", `${R(d)}, #${Math.log2(k)}`); }
          else this.ins("AND", `${R(d)}, #${fmt(k - 1)}`);
          return;
        }
      }
      const src = this.operand(r, d + 1);
      const routine = signed ? "__divs" : "__divu";
      this.runtime.add(routine);
      const live = Array.from({ length: d }, (_, i) => i);
      if (live.length) { this.ins("PUSHM", regList(live)); this.depth += 2 * live.length; }
      if (d !== 0) this.ins("MOV", `R0, ${R(d)}`);
      if (src.startsWith("#")) this.movImm(1, parseImm(src));
      else if (src !== "R1") this.ins("MOV", `R1, ${src}`);
      this.ins("CALL", routine);
      const res = op === "/" ? 0 : 1;
      if (res !== d) this.ins("MOV", `${R(d)}, ${R(res)}`);
      if (live.length) { this.ins("POPM", regList(live)); this.depth -= 2 * live.length; }
      return;
    }
    if (op === "SHL" || op === "SHR") {
      this.expr(l, d);
      const mn = op === "SHL" ? "SHL" : isSigned(l.t!) ? "ASR" : "SHR";
      if (r.c !== undefined) {
        const n = u16(r.c) & 15;
        if (n > 0) this.ins(mn, `${R(d)}, #${n}`);
        return;
      }
      this.ins(mn, `${R(d)}, ${this.operand(r, d + 1)}`);
      return;
    }
    this.expr(l, d);
    this.alu(ALU[op], d, this.operand(r, d + 1));
  }

  simpleBool(e: Expr): boolean {
    return e.c !== undefined || (this.isLeaf(e) && (e.sym as Sym).k !== "port");
  }

  /** Free of side effects (no calls, no port accesses)? */
  pure(e: Expr): boolean {
    switch (e.k) {
      case "call": return false;
      case "name": return (e.sym as Sym | undefined)?.k !== "port";
      case "unary": case "deref": case "conv": return this.pure(e.e);
      case "binary": return this.pure(e.l) && this.pure(e.r);
      case "index": return this.pure(e.e) && this.pure(e.index);
      case "field": return this.pure(e.e);
      default: return true;
    }
  }

  /** Registers needed to evaluate (Sethi-Ullman number). */
  need(e: Expr): number {
    if (e.c !== undefined) return 0;
    switch (e.k) {
      case "binary": { const a = this.need(e.l), b = Math.max(1, this.need(e.r)); return a === b ? a + 1 : Math.max(a, b); }
      case "unary": case "conv": case "deref": return this.need(e.e);
      case "index": return Math.max(this.need(e.e), this.need(e.index) + 1);
      case "field": return this.need(e.e);
      case "call": return 4;
      default: return 1;
    }
  }

  /** Jump to `label` when e (BOOL) is `jumpIf`; registers from Rd up are free. */
  cond(e: Expr, label: string, jumpIf: boolean, d: number) {
    if (e.c !== undefined) { if ((e.c !== 0) === jumpIf) this.br("RA", label); return; }
    if (e.k === "unary" && e.op === "NOT") { this.cond(e.e, label, !jumpIf, d); return; }
    if (e.k === "binary" && e.l.t!.k === "bool" && (e.op === "AND" || e.op === "OR")) {
      const and = e.op === "AND";
      if (and !== jumpIf) {           // AND jumping on false / OR jumping on true: either side decides
        this.cond(e.l, label, jumpIf, d);
        this.cond(e.r, label, jumpIf, d);
      } else {
        const skip = this.newLabel();
        this.cond(e.l, skip, !jumpIf, d);
        this.cond(e.r, label, jumpIf, d);
        this.label(skip);
      }
      return;
    }
    if (e.k === "binary" && e.op in CMP_CC) {
      let l = e.l, r = e.r, op = e.op;
      if (l.c !== undefined && r.c === undefined) { [l, r] = [r, l]; op = MIRROR[op] as typeof op; }
      const signed = isSigned(l.t!) || isSigned(r.t!);
      if ((op === "=" || op === "<>") && r.c !== undefined && u16(r.c) === 0 && l.k === "binary" && l.op === "AND") {
        // (x AND m) = 0 / <> 0: one TST, which sets Z without writing a register
        let a = l.l, b = l.r;
        if (a.c !== undefined) [a, b] = [b, a];
        let ar = this.regLocal(a), bd = d;
        if (ar === null) { this.expr(a, d); ar = d; bd = d + 1; }
        this.ins("TST", `${R(ar)}, ${this.operand(b, bd)}`);
        this.br(op === "=" === jumpIf ? "EQ" : "NE", label);
        return;
      }
      let lr = this.regLocal(l), nd = d;
      if (lr === null) { this.expr(l, d); lr = d; nd = d + 1; }
      this.cmpOp(lr, this.operand(r, nd));
      const cc = CMP_CC[op][signed ? 0 : 1];
      this.br(jumpIf ? cc : INVERSE[cc], label);
      return;
    }
    let r = this.regLocal(e);
    if (r === null) { this.expr(e, d); r = d; }
    this.ins("TST", `${R(r)}, ${R(r)}`);
    this.br(jumpIf ? "NE" : "EQ", label);
  }

  call(e: Expr, d: number) {
    const c = e as Expr & { k: "call" };
    const s = c.sym as Sym & { k: "proc" };
    const info = s.info;
    if (info.runtime) this.runtime.add(info.name);
    const live = Array.from({ length: d }, (_, i) => i);
    if (live.length) { this.ins("PUSHM", regList(live)); this.depth += 2 * live.length; }
    for (let i = c.args.length - 1; i >= 0; i--) {
      const a = c.args[i];
      const mask = info.params[i].type.k === "byte" && !this.byteSafe(a);
      const rr = this.regLocal(a);
      if (rr !== null && !mask) { this.push(rr); continue; }
      this.expr(a, 0);
      if (mask) this.ins("AND", "R0, #255");
      this.push(0);
    }
    this.ins("CALL", info.label);
    this.adjustSp(2 * c.args.length);
    this.depth -= 2 * c.args.length;
    if (d !== 0) this.ins("MOV", `${R(d)}, R0`);
    if (live.length) { this.ins("POPM", regList(live)); this.depth -= 2 * live.length; }
  }
}

/** Structurally identical lvalue designators (same variables, fields and constant or same-variable indices). */
function sameLvalue(a: Expr, b: Expr): boolean {
  if (a.k !== b.k) return false;
  if (a.c !== undefined || b.c !== undefined) return a.c === b.c;
  switch (a.k) {
    case "name": return b.k === "name" && a.sym === b.sym;
    case "field": return b.k === "field" && a.name === b.name && sameLvalue(a.e, b.e);
    case "index": return b.k === "index" && sameLvalue(a.e, b.e) && sameLvalue(a.index, b.index);
    case "deref": return b.k === "deref" && sameLvalue(a.e, b.e);
    default: return false;
  }
}

function parseImm(src: string): number {
  const t = src.slice(1);
  return t.startsWith("$") ? parseInt(t.slice(1), 16) : parseInt(t, 10);
}

function fmtEqu(v: number): string { return "$" + (v >>> 0).toString(16).toUpperCase().padStart(4, "0"); }

function asmString(bytes: number[]): string {
  let s = '"';
  for (const b of bytes) {
    if (b === 0x22) s += '\\"';
    else if (b === 0x5c) s += "\\\\";
    else if (b < 0x20 || b > 0x7e) s += "\\x" + b.toString(16).padStart(2, "0");
    else s += String.fromCharCode(b);
  }
  return s + '"';
}

// ---------------------------------------------------------------------------- runtime library

type RtSection = { needs: string[]; lines: string[] };
let RUNTIME: Map<string, RtSection> = new Map();

/** Parse runtime.inc: sections begin with ";@@ NAME [needs A B ...]". */
export function loadRuntime(text: string) {
  const map = new Map<string, RtSection>();
  let cur: RtSection | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^;@@\s+(\w+)(?:\s+needs\s+(.*))?$/.exec(raw.trim());
    if (m) { cur = { needs: m[2] ? m[2].trim().split(/\s+/) : [], lines: [] }; map.set(m[1], cur); continue; }
    if (cur) cur.lines.push(raw.replace(/\s+$/, ""));
  }
  for (const s of map.values()) while (s.lines.length && s.lines[s.lines.length - 1] === "") s.lines.pop();
  RUNTIME = map;
}
