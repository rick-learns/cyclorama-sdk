// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// SCRIM compiler driver: source -> CYASM text -> ROM (docs/scrim-spec.md).
//
//   lex + parse (parser.ts) -> check (check.ts) -> generate CYASM lines (codegen.ts)
//   -> assemble with CYASM (src/asm/assembler.ts), relaxing out-of-range branches
//      (Bcc label  ->  B!cc *+6 / JMP label) until everything fits.
// Pure: identical sources give identical assembly text and ROM bytes.
import { readFileSync } from "node:fs";
import { assemble } from "../asm/assembler.ts";
import { CompileError, type Pos } from "./lexer.ts";
import { parse, type Program } from "./parser.ts";
import { check, MAX_ERRORS } from "./check.ts";
import { Gen, INVERSE, loadRuntime, type Line } from "./codegen.ts";
import { CYCLES, aluExtraCycles, decode } from "../isa/isa.ts";
import { resolvePath, relativePath } from "./paths.ts";
// The kit's asset converters (.art, .song -> CYASM include text), for ASSET (spec §10).
import { sourceReader } from "../assets/art.ts";

loadRuntime(readFileSync(new URL("./runtime.inc", import.meta.url), "utf8"));

export type ScrimError = { file: string; line: number; col: number; message: string };
export type CompileResult = {
  asm: string;
  rom?: Uint8Array;
  errors: ScrimError[];
  /** Assembler symbol table (labels and constants), when compilation succeeded. */
  symbols?: Map<string, number>;
  /** CYASM listing, when compilation succeeded. */
  listing?: string;
  /** Per-procedure code size and static worst-case cycles of one pass through its code (spec §7). */
  report?: ProcReport[];
};
export type ProcReport = { name: string; bytes: number; cycles: number };
export type ReadFile = (path: string) => string | Uint8Array;

const toErr = (pos: Pos, message: string): ScrimError => ({ file: pos.file, line: pos.line, col: pos.col, message });

function toText(content: string | Uint8Array): string {
  const s = typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
}

export { resolvePath };

function read(readFile: ReadFile, path: string, pos: Pos): string | Uint8Array {
  try { return readFile(path); }
  catch (e) { throw new CompileError(pos, `cannot read file '${path}': ${e instanceof Error ? e.message : String(e)}`); }
}

/** Render generated lines to text, expanding branches; map[i] is the source line of text line i+1. */
function render(lines: Line[]): { text: string; map: Line[] } {
  const out: string[] = [], map: Line[] = [];
  const put = (t: string, l: Line) => { out.push(t); map.push(l); };
  for (const l of lines) {
    if (!l.br) { put(l.text, l); continue; }
    const { cc, target, long } = l.br;
    if (!long) put(`        B${cc.padEnd(4)}${target}`, l);
    else if (cc === "RA") put(`        JMP  ${target}`, l);
    else { put(`        B${INVERSE[cc].padEnd(4)}*+6`, l); put(`        JMP  ${target}`, l); }
  }
  return { text: out.join("\n") + "\n", map };
}

export function compile(mainFile: string, readFile: ReadFile): CompileResult {
  let program: Program;
  try {
    const src = toText(read(readFile, mainFile, { file: mainFile, line: 0, col: 0 }));
    program = parse(src, mainFile, (from, path, pos) => {
      const file = resolvePath(from, path);
      return { file, text: toText(read(readFile, file, pos)) };
    });
  } catch (e) {
    if (e instanceof CompileError) return { asm: "", errors: [toErr(e.pos, e.message)] };
    throw e;
  }

  const { checked, errors } = check(program, (from, path, pos) => toBytes(read(readFile, resolvePath(from, path), pos)));
  if (!checked) return { asm: "", errors: errors.map((e) => toErr(e.pos, e.message)) };

  const lines = new Gen(checked).program();
  const asmName = mainFile.replace(/\.[^./\\]*$/, "") + ".asm";
  // LINK / ASSET files: read through readFile; "x.art.inc" / "x.song.inc" are converted from
  // "x.art" / "x.song" on demand, exactly as every ROM build does (sourceReader, src/assets/art.ts).
  const linked = sourceReader((p) => {
    const c = readFile(p);
    return /\.(art|song)$/i.test(p) ? toText(c) : c;
  });
  // Included file -> the LINK / ASSET declaration that names it (for error positions).
  const linkPos = new Map<string, Pos>();
  for (const l of checked.links) if (l.k === "include") linkPos.set(resolvePath(asmName, relativePath(program.pos.file, l.file)), l.pos);
  for (let pass = 0; ; pass++) {
    const { text, map } = render(lines);
    const res = assemble(asmName, (p) => (p === asmName ? text : linked(p)));
    const own = (e: { file: string; line: number }) => (e.file === asmName ? map[e.line - 1] : undefined);
    const tooFar = res.errors.filter((e) => /branches reach/.test(e.message) && own(e)?.br && !own(e)!.br!.long);
    if (tooFar.length && pass < 64) {
      for (const e of tooFar) own(e)!.br!.long = true;
      continue;
    }
    // Every EXTERN must be defined by the linked assembly, used or not.
    const missing = checked.externs.filter((x) => !res.symbols.has(x.name))
      .map((x) => toErr(x.pos, `${x.what} '${x.name}' is not defined by any LINK, ASSET or ASM block`));
    if (res.errors.length || missing.length) {
      const errs = res.errors.map((e) => {
        if (e.file !== asmName) return toErr(linkPos.get(e.file) ?? program.pos, `assembler: ${e.file}:${e.line}: ${e.message}`);
        const src = map[e.line - 1]?.pos;
        return src ? toErr(src, `assembler: ${e.message}`) : toErr(program.pos, `internal compiler error (assembler, ${asmName}:${e.line}): ${e.message}`);
      });
      return { asm: text, errors: [...missing, ...errs].slice(0, MAX_ERRORS) };
    }
    const src = res.listingSource ?? [];
    const listed = src.map((s) => (s.file === asmName ? map[s.line - 1] : undefined));
    return { asm: text, rom: res.rom, errors: [], symbols: res.symbols, listing: res.listing, report: report(res.listing, listed) };
  }
}

/**
 * Size and a static worst-case cycle count per procedure (every instruction once, branches taken,
 * register shifts by 15; video-port wait cycles and DMA stalls excluded). Real timing is measured
 * on the emulator.
 */
function report(listing: string, map: (Line | undefined)[]): ProcReport[] {
  const acc = new Map<string, ProcReport>();
  listing.split(/\r?\n/).forEach((l, i) => {
    const owner = map[i]?.owner;
    if (!owner) return;
    const r = acc.get(owner) ?? { name: owner, bytes: 0, cycles: 0 };
    acc.set(owner, r);
    const text = map[i]!.text.trim();
    if (text.startsWith(".word")) { r.bytes += 2 * text.slice(5).split(",").length; return; } // jump tables
    const m = /^[0-9A-F]{2}:[0-9A-F]{4}  ((?:[0-9A-F]{4} )*[0-9A-F]{4})\s/.exec(l);
    if (!m) return;
    const words = m[1].split(" ").map((w) => parseInt(w, 16));
    r.bytes += words.length * 2;
    r.cycles += cyclesOf(words[0], words[1]);
  });
  return [...acc.values()];
}

function cyclesOf(w: number, ext: number | undefined): number {
  const d = decode(w);
  switch (d.kind) {
    case "unary": return (CYCLES.unary[d.mnemonic] ?? 2) + (/^(SHL|SHR|ASR|ROL)I$/.test(d.mnemonic) ? d.imm + 1 : 0);
    case "aluR": return CYCLES.aluReg + aluExtraCycles(d.op, 15);
    case "aluI": return CYCLES.aluImm + aluExtraCycles(d.op, (ext ?? 15) & 15);
    case "quick": return CYCLES.quick;
    case "mem": return CYCLES.memShort;
    case "memx": return d.ext ? CYCLES.memExt : CYCLES.memPostPre;
    case "sprel": return CYCLES.spRel;
    case "branch": return d.cond === 15 ? CYCLES.bsr : CYCLES.branchTaken;
    case "long": {
      if (d.op === 0) return CYCLES.jmpAbs;
      if (d.op === 1) return CYCLES.callAbs;
      if (d.op === 2 || d.op === 3) { let n = 0; for (let b = d.mask ?? 0; b; b &= b - 1) n++; return CYCLES.pushmBase + CYCLES.perReg * n; }
      if (d.op === 4) return CYCLES.addsp;
      return CYCLES.jmpt;
    }
    default: return 2;
  }
}
