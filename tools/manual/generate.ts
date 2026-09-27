// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Generated sections of the M1 manual. Everything here is derived from the
// normative tables (src/isa/isa.ts, src/isa/reference.ts, src/hw/registers.ts)
// or from the verified example files, so the manual cannot drift from them.
import { readFileSync } from "node:fs";
import { CYCLES, CONDITIONS, aluExtraCycles, decode, LAYOUT, type Decoded } from "../../src/isa/isa.ts";
import { REFERENCE, GROUPS, CONDITION_TESTS, type Entry, type Form, type Field } from "../../src/isa/reference.ts";
import { REGISTERS, CHIP_RANGES, type Chip } from "../../src/hw/registers.ts";
import { assemble, parseHex } from "./cyasm-lite.ts";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hex = (n: number, w = 4) => n.toString(16).toUpperCase().padStart(w, "0");
/** Mark up backquoted spans in reference prose as code. */
const prose = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

// ---------------------------------------------------------------------------
// Instruction reference

/** Bit diagram of a first word: fixed bits printed as 0/1, variable fields as labelled spans. */
export function bitDiagram(word: number, fields: Field[]): string {
  const nums: string[] = [], cells: string[] = [];
  for (let b = 15; b >= 0; b--) nums.push(`<td>${b}</td>`);
  for (let b = 15; b >= 0;) {
    const fl = fields.find(q => q.hi === b);
    if (fl) {
      cells.push(`<td colspan="${fl.hi - fl.lo + 1}" class="${fl.ignored ? "fz" : "fv"}">${esc(fl.name)}</td>`);
      b = fl.lo - 1;
    } else {
      if (fields.some(q => b <= q.hi && b >= q.lo)) throw new Error(`field overlap at bit ${b}`);
      cells.push(`<td class="fb">${(word >> b) & 1}</td>`);
      b--;
    }
  }
  return `<table class="enc"><tr class="bn">${nums.join("")}</tr><tr>${cells.join("")}</tr></table>`;
}

const cyclesText = (f: Form) =>
  f.cycles.taken !== undefined ? `${f.cycles.base} not taken, ${f.cycles.taken} taken` : `${f.cycles.base}${f.cycles.plus ? ` + ${f.cycles.plus}` : ""}`;

function formRow(e: Entry, f: Form): string {
  const mn = e.mnemonic === "Bcc" ? "B" + CONDITIONS[(f.word >> 8) & 15] : e.mnemonic;
  const taken = f.cycles.taken !== undefined ? ` data-taken="${f.cycles.taken}"` : "";
  return `<tr class="form" data-word="${hex(f.word)}" data-mnemonic="${mn}" data-cycles="${f.cycles.base}"${taken}>` +
    `<td class="syn"><code>${esc(f.syntax)}</code>${f.note ? `<div class="fnote">${esc(f.note)}</div>` : ""}</td>` +
    `<td>${bitDiagram(f.word, f.fields)}<div class="base">base ${hex(f.word)}</div></td>` +
    `<td class="ext">${f.ext ? `<i>${esc(f.ext)}</i>` : "—"}</td>` +
    `<td class="cyc">${esc(cyclesText(f))}</td></tr>`;
}

function renderEntry(e: Entry): string {
  const id = `insn-${e.mnemonic}`;
  const flagCells = e.flags.map(v => `<td>${esc(v)}</td>`).join("");
  const conds = e.mnemonic === "Bcc"
    ? `<table class="ruled conds"><thead><tr><th>cccc</th><th>Code</th><th>Mnemonic</th><th>Meaning</th><th>Branch if</th></tr></thead><tbody>${CONDITIONS.map((c, i) =>
      `<tr><td><code>${i.toString(2).padStart(4, "0")}</code></td><td>${c}</td><td><code>B${c}${c === "LO" ? " / BCS" : c === "HS" ? " / BCC" : ""}</code></td><td>${esc(CONDITION_TESTS[c][0])}</td><td>${esc(CONDITION_TESTS[c][1])}</td></tr>`).join("")}</tbody></table>`
    : "";
  return `<div class="insn">
<h4 id="${id}"><span class="mn">${e.mnemonic}</span> ${esc(e.title)}</h4>
<table class="forms"><thead><tr><th>Syntax</th><th>Encoding (first word)</th><th>Ext. word</th><th>Cycles</th></tr></thead><tbody>
${e.forms.map(f => formRow(e, f)).join("\n")}
</tbody></table>
<div class="opflags"><pre class="op">${esc(e.operation)}</pre><table class="flags"><tr><th>Z</th><th>N</th><th>C</th><th>V</th></tr><tr>${flagCells}</tr></table></div>
${conds}${e.notes.length ? `<ul class="notes">${e.notes.map(n => `<li>${prose(n)}</li>`).join("")}</ul>` : ""}
</div>`;
}

export function renderInstructionReference(): string {
  const out: string[] = [];
  for (const g of GROUPS) {
    out.push(`<h3 id="ref-${g.id}">${esc(g.title)}</h3>\n<p>${esc(g.intro)}</p>`);
    for (const e of REFERENCE.filter(x => x.group === g.id)) out.push(renderEntry(e));
  }
  return `<div class="iref">\n${out.join("\n")}\n</div>`;
}

// ---------------------------------------------------------------------------
// Instruction layouts (from LAYOUT) and cycle table (from CYCLES)

export function renderLayouts(): string {
  const names: Record<string, string> = { group0: "0", group1: "1", group2: "2", group3: "3", group4: "4–7", group8: "8", group9: "9", groupA: "A", groupB: "B" };
  const rows = Object.entries(LAYOUT).map(([k, v]) => {
    const [bits, ...rest] = v.split(/\s{2,}/);
    return `<tr><td>${names[k]}</td><td><code>${esc(bits)}</code></td><td>${esc(rest.join("; "))}</td></tr>`;
  });
  return `<table class="ruled"><thead><tr><th>Major</th><th>Bits 15 → 0</th><th>Fields</th></tr></thead><tbody>${rows.join("")}<tr><td>C–F</td><td><code>11xx xxxx xxxx xxxx</code></td><td>reserved (see Reserved encodings)</td></tr></tbody></table>`;
}

export function renderCycleTable(): string {
  const shiftPer = aluExtraCycles(10, 1) - aluExtraCycles(10, 0);
  const rows: [string, string][] = [
    ["ALU, register form (group 1)", `${CYCLES.aluReg}`],
    ["ALU, immediate form (group 2)", `${CYCLES.aluImm}`],
    ["MOVQ, ADDQ (group 3)", `${CYCLES.quick}`],
    ["Shifts and rotates (SHL, SHR, ASR, ROL; any form)", `+ ${shiftPer} per bit of count n`],
    ["MUL, FMUL (any form)", `+ ${aluExtraCycles(14, 0)}`],
    ["Load/store short form (groups 4–7)", `${CYCLES.memShort}`],
    ["Load/store [Rs+d16] or [addr] (group 8)", `${CYCLES.memExt}`],
    ["Load/store [Rs]+ or -[Rs] (group 8)", `${CYCLES.memPostPre}`],
    ["Load/store [SP+d] (group 9)", `${CYCLES.spRel}`],
    ["Branch not taken", `${CYCLES.branchNotTaken}`],
    ["Branch taken (and BRA)", `${CYCLES.branchTaken}`],
    ["BSR", `${CYCLES.bsr}`],
    ["JMP addr", `${CYCLES.jmpAbs}`],
    ["CALL addr", `${CYCLES.callAbs}`],
    ["PUSHM, POPM", `${CYCLES.pushmBase} + ${CYCLES.perReg} per register`],
    ["ADD SP,#n", `${CYCLES.addsp}`],
    ["JMPT", `${CYCLES.jmpt}`],
    ...Object.entries(CYCLES.unary).map(([m, c]): [string, string] => [m + (/^(SHL|SHR|ASR|ROL)I$/.test(m) ? " (+ n)" : ""), `${c}`]),
    ["Reserved encoding", `${CYCLES.unary.NOP}`],
    ["Interrupt entry (push PC, push F, fetch vector)", `${CYCLES.interruptEntry}`],
    ["Access to VDATA, OAMDATA or CRAMDATA during active display", `+ ${CYCLES.videoPortWait} per access`],
  ];
  return `<table class="ruled cycles"><thead><tr><th>Instruction class</th><th>Cycles</th></tr></thead><tbody>${rows.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join("")}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Opcode map: one cell per high byte (bits 15-8) of the first word

const qualifier = (d: Decoded): string => {
  switch (d.kind) {
    case "aluR": return "Rd,Rs";
    case "aluI": return "Rd,#16";
    case "quick": case "mem": case "memx": return `R${d.d}`;
    case "sprel": return `R${d.d},[SP]`;
    default: return "";
  }
};

export function renderOpcodeMap(): string {
  const rows: string[] = [];
  const head = `<tr><th></th>${[...Array(16)].map((_, i) => `<th>x${hex(i, 1)}</th>`).join("")}</tr>`;
  for (let hi = 0; hi < 16; hi++) {
    const cells: string[] = [];
    for (let lo = 0; lo < 16; lo++) {
      const hb = hi * 16 + lo;
      const labels: string[] = [];
      const quals = new Set<string>();
      for (let low = 0; low < 256; low++) {
        const d = decode(hb << 8 | low);
        const lab = d.mnemonic === "RESERVED" ? "res" : d.mnemonic;
        if (!labels.includes(lab)) labels.push(lab);
        const q = qualifier(d);
        if (q) quals.add(q);
      }
      const cls = labels.length === 1 && labels[0] === "res" ? "res" : `g${hex(hi, 1)}`;
      cells.push(`<td class="op ${cls}" data-hb="${hex(hb, 2)}">${labels.map(l => `<b>${l}</b>`).join(" ")}${quals.size ? `<br><small>${[...quals].join(" ")}</small>` : ""}</td>`);
    }
    rows.push(`<tr><th>${hex(hi, 1)}x</th>${cells.join("")}</tr>`);
  }
  return `<table class="opmap"><thead>${head}</thead><tbody>${rows.join("\n")}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Register table

export const CHIP_TITLES: Record<Chip, string> = {
  cartridge: "Cartridge registers",
  video: "Video registers (Barndoor, AV-2210)",
  audio: "Audio registers (Cue, AV-3105)",
  input: "Input registers",
  system: "Timer and interrupt registers",
  dma: "DMA registers",
};
const ACCESS = { r: "R", w: "W", rw: "R/W" } as const;

export function renderRegisterTable(): string {
  const out: string[] = [];
  for (const chip of Object.keys(CHIP_RANGES) as Chip[]) {
    const [lo, hi] = CHIP_RANGES[chip];
    const regs = REGISTERS.filter(r => r.chip === chip).sort((a, b) => a.addr - b.addr);
    out.push(`<h3 id="regs-${chip}">${esc(CHIP_TITLES[chip])}, ${hex(lo)}–${hex(hi)}</h3>`);
    out.push(`<table class="ruled regs"><thead><tr><th>Address</th><th>Name</th><th>Access</th><th>Description</th></tr></thead><tbody>${regs.map(r =>
      `<tr id="reg-${r.name}"><td><code>${hex(r.addr)}</code></td><td><code>${r.name}</code></td><td>${ACCESS[r.access]}</td><td>${esc(r.description)}</td></tr>`).join("\n")}</tbody></table>`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Worked example listings (source + verified hand-assembled words)

export function renderExample(name: string, dir: URL): string {
  const src = readFileSync(new URL(`${name}.asm`, dir), "utf8");
  const hexLines = parseHex(readFileSync(new URL(`${name}.hex`, dir), "utf8"));
  const { statements } = assemble(src);
  if (statements.length !== hexLines.length) throw new Error(`${name}: ${statements.length} statements but ${hexLines.length} hex lines`);
  const byLine = new Map(statements.map((s, i) => [s.line, hexLines[i]]));
  const lines = src.replace(/\n$/, "").split(/\r?\n/);
  // The file's SPDX header (and the empty comment line after it) is real-world licensing, not
  // part of the 1987 listing: the manual shows the example from the line after it.
  let skip = 0;
  while (skip < lines.length && /^;\s*SPDX-/.test(lines[skip])) skip++;
  if (skip && lines[skip]?.trim() === ";") skip++;
  const rows = lines.map((line, i) => {
    const h = byLine.get(i + 1);
    const addr = h ? hex(h.addr) : "";
    const words = h ? h.words.map(w => hex(w)).join(" ") : "";
    return `<tr><td class="a">${addr}</td><td class="w">${words}</td><td class="s">${esc(line) || "&nbsp;"}</td></tr>`;
  }).slice(skip);
  return `<figure class="listing" id="ex-${name}"><figcaption>File <code>examples/${name}.asm</code> with its hand-assembled words (<code>${name}.hex</code>)</figcaption>
<table class="listing"><thead><tr><th>Addr</th><th>Words</th><th>Source</th></tr></thead><tbody>
${rows.join("\n")}
</tbody></table></figure>`;
}
