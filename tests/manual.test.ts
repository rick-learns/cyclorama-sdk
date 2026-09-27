// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// M1 manual: the built document is reproducible, complete against the ISA and
// register tables, agrees with the canon, and every worked example's
// hand-assembled machine code is re-derived from the ISA encoders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { buildManual, MANUAL_OUT, MANUAL_SRC, EXAMPLES_DIR } from "../tools/build-manual.ts";
import { renderInstructionReference, renderRegisterTable, renderOpcodeMap } from "../tools/manual/generate.ts";
import { assemble, parseHex, AsmError } from "../tools/manual/cyasm-lite.ts";
import { ALU_OPS, UNARY_OPS, CONDITIONS, LONG_OPS, CYCLES, aluExtraCycles, decode, hasExtension, enc } from "../src/isa/isa.ts";
import { REGISTERS } from "../src/hw/registers.ts";
import { REFERENCE } from "../src/isa/reference.ts";
import { loadPublicCanon, checkProse, denylistHits, htmlToText, prosePrices, hardwareClaims } from "../tools/canon/lib.ts";

const canon = loadPublicCanon();   // the open extract (canon/canon-public.json)
const read = (p: string | URL) => readFileSync(p, "utf8");
const built = buildManual();
const committed = existsSync(MANUAL_OUT) ? read(MANUAL_OUT) : "";
/** The built manual without the section numbers the builder adds to headings. */
const unnumbered = built.replace(/<span class="secno">[^<]*<\/span> ?/g, "");

// ---------------------------------------------------------------------------
// Build

test("committed docs/manual/index.html is up to date with its sources (run npm run manual)", () => {
  assert.ok(committed.length > 0, "docs/manual/index.html missing");
  assert.ok(committed === built, "docs/manual/index.html is stale: run `npm run manual`");
});

test("build is deterministic", () => {
  assert.equal(buildManual(), built);
});

test("all my fragments exist and every GEN marker is expanded", () => {
  for (const f of ["00-front", "10-overview", "20-cpu", "30-system", "40-cartridge", "70-input", "80-assembler", "85-examples", "95-registers"])
    assert.ok(existsSync(new URL(`${f}.html`, MANUAL_SRC)), `${f}.html missing`);
  assert.doesNotMatch(built, /<!--GEN:/);
});

test("headings: every h2/h3 has a unique id, the TOC links them all, and every #link resolves", () => {
  const ids = [...built.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  assert.deepEqual(dup, [], "duplicate ids");
  const idSet = new Set(ids);
  const heads = [...built.matchAll(/<h([23])\b([^>]*)>/g)];
  assert.ok(heads.length > 20);
  const toc = built.slice(built.indexOf('<nav class="toc"'), built.indexOf("</nav>"));
  for (const h of heads) {
    const id = /\sid="([^"]+)"/.exec(h[2])?.[1];
    assert.ok(id, `h${h[1]} without id: ${h[0]}`);
    assert.ok(toc.includes(`href="#${id}"`), `TOC lacks #${id}`);
  }
  for (const m of built.matchAll(/href="#([^"]*)"/g)) assert.ok(idSet.has(m[1]), `dangling link #${m[1]}`);
  assert.doesNotMatch(built, /<a class="xref" href="#[^"]*"><\/a>/, "unfilled cross-reference");
});

test("renders offline: no external resources", () => {
  assert.doesNotMatch(built, /\b(src|href)="(https?:)?\/\//i);
  assert.doesNotMatch(built, /@import|url\(\s*['"]?https?:/i);
  assert.doesNotMatch(built, /<script\b[^>]*\bsrc=/i);
  assert.doesNotMatch(built, /<link\b[^>]*stylesheet/i);
});

test("front matter: document number, March 1987 issue, licensing notice, out-of-world fiction note", () => {
  const front = read(new URL("00-front.html", MANUAL_SRC));
  assert.match(front, /HED-0041/);
  assert.match(front, /March 1987/);
  assert.match(front, /licen[cs]/i);
  assert.match(front, /class="out-of-world"[\s\S]*alternate-history fiction/);
});

// ---------------------------------------------------------------------------
// Instruction reference completeness and cycle agreement

const ref = renderInstructionReference();
const refText = htmlToText(ref);
const word = (s: string) => new RegExp(`(?<![A-Za-z0-9])${s}(?![A-Za-z0-9])`);

test("every mnemonic appears in the instruction reference", () => {
  const all = [...ALU_OPS, ...UNARY_OPS, ...CONDITIONS, ...CONDITIONS.map(c => "B" + c), ...LONG_OPS, "MOVQ", "ADDQ", "LD", "ST", "LDB", "STB", "BCS", "BCC"];
  for (const m of all) assert.match(refText, word(m), `${m} missing from instruction reference`);
  assert.ok(unnumbered.includes(ref), "instruction reference not included in the built manual");
});

test("reference data covers every unary, ALU, long and condition code", () => {
  const names = new Set(REFERENCE.map(e => e.mnemonic));
  for (const m of [...ALU_OPS, ...UNARY_OPS, ...LONG_OPS, "MOVQ", "ADDQ", "LD", "ST", "LDB", "STB", "BSR", "Bcc", "RESERVED"]) assert.ok(names.has(m), m);
});

// A form row nests a bit-diagram table, so match up to its final (cycles) cell.
type Row = { word: number; mnemonic: string; cycles: number; taken: number | null; text: string; cyc: string };
const rows: Row[] = [...ref.matchAll(/<tr class="form" data-word="([0-9A-F]{4})" data-mnemonic="([A-Z]+)" data-cycles="(\d+)"(?: data-taken="(\d+)")?>([\s\S]*?)<td class="cyc">([\s\S]*?)<\/td><\/tr>/g)]
  .map(m => ({ word: parseInt(m[1], 16), mnemonic: m[2], cycles: +m[3], taken: m[4] ? +m[4] : null, text: htmlToText(m[5] + " " + m[6]), cyc: htmlToText(m[6]) }));

test("every encoding row decodes to its mnemonic, and every major/op is covered", () => {
  assert.ok(rows.length >= 80, `only ${rows.length} form rows`);
  const kinds = new Set<string>();
  for (const r of rows) {
    const d = decode(r.word);
    assert.equal(d.mnemonic, r.mnemonic, `row ${r.word.toString(16)}`);
    kinds.add(d.kind === "memx" ? `memx${d.mode}` : d.kind);
  }
  for (const k of ["unary", "aluR", "aluI", "quick", "mem", "memx0", "memx1", "memx2", "memx3", "sprel", "branch", "long", "reserved"]) assert.ok(kinds.has(k), k);
});

/** Expected cycles computed independently from CYCLES for a decoded word. */
function expectedCycles(w: number): { base: number; taken?: number } {
  const d = decode(w);
  switch (d.kind) {
    case "unary": return { base: CYCLES.unary[d.mnemonic] };
    case "aluR": return { base: CYCLES.aluReg + aluExtraCycles(d.op, 0) };
    case "aluI": return { base: CYCLES.aluImm + aluExtraCycles(d.op, 0) };
    case "quick": return { base: CYCLES.quick };
    case "mem": return { base: CYCLES.memShort };
    case "memx": return { base: d.mode < 2 ? CYCLES.memExt : CYCLES.memPostPre };
    case "sprel": return { base: CYCLES.spRel };
    case "branch": return d.cond === 15 ? { base: CYCLES.bsr } : d.cond === 0 ? { base: CYCLES.branchTaken } : { base: CYCLES.branchNotTaken, taken: CYCLES.branchTaken };
    case "long": return { base: [CYCLES.jmpAbs, CYCLES.callAbs, CYCLES.pushmBase, CYCLES.pushmBase, CYCLES.addsp, CYCLES.jmpt][d.op] };
    case "reserved": return { base: CYCLES.unary.NOP };
  }
}

test("cycle counts in the reference equal the CYCLES table", () => {
  for (const r of rows) {
    const e = expectedCycles(r.word);
    assert.equal(r.cycles, e.base, `${r.mnemonic} ${r.word.toString(16)} cycles`);
    assert.equal(r.taken, e.taken ?? null, `${r.mnemonic} taken cycles`);
    assert.match(r.cyc, new RegExp(`^${e.base}(?!\\d)`), `${r.mnemonic} cycles cell text`);
    if (e.taken !== undefined) assert.match(r.cyc, word(String(e.taken)), `${r.mnemonic} taken cycles text`);
  }
  // Variable parts are stated: shifts per bit, MUL/FMUL extra, PUSHM/POPM per register.
  const byM = (m: string) => rows.filter(r => r.mnemonic === m).map(r => r.cyc).join(" ");
  for (const m of ["SHL", "SHR", "ASR", "ROL", "SHLI", "SHRI", "ASRI", "ROLI"]) assert.match(byM(m), /\+ ?n\b/, `${m} shift-count cycles`);
  for (const m of ["PUSHM", "POPM"]) assert.match(byM(m), new RegExp(`${CYCLES.perReg} per register`), m);
  assert.equal(rows.find(r => r.mnemonic === "MUL")!.cycles, CYCLES.aluReg + 8);
});

// ---------------------------------------------------------------------------
// Register table and opcode map

test("every register appears in the register table with an anchor", () => {
  const table = renderRegisterTable();
  for (const r of REGISTERS) {
    assert.ok(table.includes(`id="reg-${r.name}"`), `${r.name} anchor`);
    assert.match(htmlToText(table), word(r.name), r.name);
  }
  assert.ok(unnumbered.includes(table), "register table not included in the built manual");
});

test("opcode map has 256 cells, one per high byte, that agree with the decoder", () => {
  const map = renderOpcodeMap();
  const cells = [...map.matchAll(/<td class="op [^"]*" data-hb="([0-9A-F]{2})">([\s\S]*?)<\/td>/g)];
  assert.equal(cells.length, 256);
  for (const [, hb, body] of cells) {
    const d = decode(parseInt(hb, 16) << 8);
    assert.match(htmlToText(body), word(d.mnemonic === "RESERVED" ? "res" : d.mnemonic), `cell ${hb}`);
  }
  assert.ok(built.includes(map));
});

// ---------------------------------------------------------------------------
// Canon

test("no denylisted real-world name appears anywhere in the manual source or output", () => {
  assert.deepEqual(denylistHits(built, canon.denylist.terms), []);
  for (const f of readdirSync(EXAMPLES_DIR)) assert.deepEqual(denylistHits(read(new URL(f, EXAMPLES_DIR)), canon.denylist.terms), [], f);
});

test("manual prose agrees with the canon (checkProse, no coverage requirement)", () => {
  assert.deepEqual(checkProse("docs/manual/index.html", htmlToText(built), canon).problems, []);
});

test("htmlToText strips tags, style blocks and entities", () => {
  assert.equal(htmlToText("<style>p{}</style><p>a&nbsp;&amp;&lt;b&gt; 8&times;8</p>"), "a &<b> 8×8");
});

test("narrowed price pattern: assembler hex ($1F, $8000) is not a price; bare-dollar prices still are", () => {
  assert.deepEqual(prosePrices("MOV R0,#$1F ; LD R1,[$8000] ; .org $0100"), []);
  assert.deepEqual(prosePrices("cost $199.99 then $179.99").map(p => p.key), ["USD:19999", "USD:17999"]);
  assert.deepEqual(prosePrices("US$199 and CA$229.99 and £149.99").map(p => p.key), ["USD:19900", "CAD:22999", "GBP:14999"]);
  const problems = checkProse("x", "It sold for $199.99 at launch.", canon).problems;
  assert.ok(problems.some(p => p.includes("not a canon price")));
});

test("narrowed CPU-cycles-per-line pattern ignores instruction timings but catches line contradictions", () => {
  const claims = (t: string) => checkProse("x", t, canon).problems.filter(p => /CPU cycles per line/.test(p));
  assert.deepEqual(claims("the prescaler ticks every 256 CPU cycles; MUL takes 10 CPU cycles."), []);
  assert.deepEqual(claims("342 dots = 228 CPU cycles; a line is 228 CPU cycles per line."), []);
  assert.notDeepEqual(claims("342 dots = 227 CPU cycles"), []);
  assert.notDeepEqual(claims("a line lasts 227 CPU cycles per line"), []);
  assert.ok(hardwareClaims(canon).some(c => c.label === "CPU cycles per line"));
});

// ---------------------------------------------------------------------------
// Worked examples: hand-assembled hex re-derived from the ISA encoders

const exampleNames = readdirSync(EXAMPLES_DIR).filter(f => f.endsWith(".asm")).map(f => f.slice(0, -4)).sort();

test("at least six worked examples, each with a .hex sibling and shown in the manual", () => {
  assert.ok(exampleNames.length >= 6, `${exampleNames.length} examples`);
  for (const n of exampleNames) {
    assert.ok(existsSync(new URL(`${n}.hex`, EXAMPLES_DIR)), `${n}.hex missing`);
    assert.ok(built.includes(`id="ex-${n}"`), `example ${n} not in the manual`);
  }
});

/** Source mnemonic -> decoded mnemonics it may legitimately produce. */
const ALIASES: Record<string, string[]> = {
  MOV: ["MOV", "MOVQ", "MOVFS", "MOVTS"], MOVW: ["MOV"], ADD: ["ADD", "ADDQ", "ADDSP"], ADDW: ["ADD"],
  SHL: ["SHL", "SHLI"], SHR: ["SHR", "SHRI"], ASR: ["ASR", "ASRI"], ROL: ["ROL", "ROLI"],
  JMP: ["JMP", "JMPR"], CALL: ["CALL", "CALLR"], BCS: ["BLO"], BCC: ["BHS"],
};

for (const n of exampleNames) {
  test(`example ${n}: every hex word re-derives from the source via enc.* and decodes back`, () => {
    const src = read(new URL(`${n}.asm`, EXAMPLES_DIR));
    const hex = parseHex(read(new URL(`${n}.hex`, EXAMPLES_DIR)));
    const out = assemble(src);
    assert.deepEqual(hex.map(h => [h.addr, h.words]), out.statements.map(s => [s.addr, s.words]), `${n}.hex disagrees with the encoders`);
    for (const s of out.statements) {
      if (s.data) continue;
      const d = decode(s.words[0]);
      assert.equal(hasExtension(s.words[0]), s.words.length === 2, `line ${s.line}: extension word`);
      assert.ok((ALIASES[s.mnemonic] ?? [s.mnemonic]).includes(d.mnemonic), `line ${s.line}: ${s.mnemonic} decoded as ${d.mnemonic}`);
      if ("d" in d && s.firstReg !== undefined && d.kind !== "long") assert.equal(d.d, s.firstReg, `line ${s.line}: register field`);
    }
  });
}

// ---------------------------------------------------------------------------
// The verification assembler itself, against golden encodings

test("cyasm-lite: golden encodings and form selection", () => {
  const w = (line: string) => assemble(`  .org $0100\n  ${line}\n`).statements[0].words;
  assert.deepEqual(w("NOT R3"), [enc.unary(8, 3)]);
  assert.deepEqual(w("ADD R2, R5"), [enc.aluR(1, 2, 5)]);
  assert.deepEqual(w("MOV R7, #$1234"), [enc.aluI(0, 7), 0x1234]);
  assert.deepEqual(w("MOV R1, #-5"), [enc.quick(false, 1, -5)]);
  assert.deepEqual(w("MOVW R1, #-5"), [enc.aluI(0, 1), 0xfffb]);
  assert.deepEqual(w("ADD R4, #-1"), [enc.quick(true, 4, -1)]);
  assert.deepEqual(w("LD R1, [R2+6]"), [enc.mem(false, false, 1, 2, 3)]);
  assert.deepEqual(w("STB R1, [R2+3]"), [enc.mem(true, true, 1, 2, 3)]);
  assert.deepEqual(w("LD R1, [R2+128]"), [enc.memx(1, 2, false, false, 0), 128]);
  assert.deepEqual(w("ST R1, [R2]+"), [enc.memx(1, 2, false, true, 2)]);
  assert.deepEqual(w("LDB R0, -[R6]"), [enc.memx(0, 6, true, false, 3)]);
  assert.deepEqual(w("LD R3, [$F008]"), [enc.memx(3, 0, false, false, 1), 0xf008]);
  assert.deepEqual(w("LD R3, [VSTAT]"), [enc.memx(3, 0, false, false, 1), 0xf008]);
  assert.deepEqual(w("ST R6, [SP+10]"), [enc.sprel(6, true, 5)]);
  assert.deepEqual(w("PUSHM R0, R7"), [enc.long(2, 0x81)]);
  assert.deepEqual(w("PUSHM R0-R2, R5"), [enc.long(2, 0x27)]);
  assert.deepEqual(w("ADD SP, #-4"), [enc.long(4, -2)]);
  assert.deepEqual(w("SHL R4, #16"), [enc.unary(15, 4, 15)]);
  assert.deepEqual(w("SHR R1, R2"), [enc.aluR(11, 1, 2)]);
  assert.deepEqual(w("JMP [R2]"), [enc.unary(19, 2)]);
  assert.deepEqual(w("MOV R5, SP"), [enc.unary(23, 5)]);
  assert.deepEqual(w("MOV SP, R5"), [enc.unary(24, 5)]);
  assert.deepEqual(w("TRAP #3"), [enc.unary(7, 0, 3)]);
  assert.deepEqual(w("JMPT R3, $0200"), [enc.long(5, 3 << 5), 0x0200]);
  assert.deepEqual(w(".word 1, 'A', <$1234, >$1234, 2+3*4, (2+3)*4, ~0, 1<<4|1"), [1, 65, 0x34, 0x12, 14, 20, 0xffff, 17]);
});

test("cyasm-lite: branches, labels, local labels, forward references", () => {
  const out = assemble([
    "  .org $0200",
    "start:", ".loop:", "  BNE .loop", "  BRA fwd", "  MOV R0, #fwd", "fwd:", "  BSR start", "  BCS start", "  BCC fwd",
  ].join("\n"));
  const words = out.statements.map(s => s.words);
  assert.deepEqual(words[0], [enc.branch(2, -1)]);
  assert.deepEqual(words[1], [enc.branch(0, 2)]);            // skips the 2-word MOV (forward ref -> 16-bit form)
  assert.deepEqual(words[2], [enc.aluI(0, 0), 0x0208]);
  assert.deepEqual(words[3], [enc.branch(15, -5)]);
  assert.deepEqual(words[4], [enc.branch(3, -6)]);
  assert.deepEqual(words[5], [enc.branch(4, -3)]);
  assert.throws(() => assemble("  .org 0\nx:\n  .fill 300, 0\n  BRA x\n"), AsmError);
});

test("example verification is not vacuous: one wrong hand-assembled word is caught", () => {
  const src = read(new URL("05-fmul.asm", EXAMPLES_DIR));
  const good = parseHex(read(new URL("05-fmul.hex", EXAMPLES_DIR)));
  const bad = good.map((h, i) => (i === 3 ? { ...h, words: [h.words[0] ^ 0x0040] } : h)); // ST R0,[R3+6] -> wrong base register
  const derived = assemble(src).statements.map(s => [s.addr, s.words]);
  assert.deepEqual(good.map(h => [h.addr, h.words]), derived);
  assert.notDeepEqual(bad.map(h => [h.addr, h.words]), derived);
});
