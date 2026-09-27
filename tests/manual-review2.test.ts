// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// M1 outsider review (research/m1-review.md) pinned against the built manual.
// Rulings: docs/spec-notes.md §9 (items 37-45) and §10 (items 46-60).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REFERENCE } from "../src/isa/reference.ts";
import { reg } from "../src/hw/registers.ts";
import { htmlToText } from "../tools/canon/lib.ts";

const html = readFileSync("docs/manual/index.html", "utf8");
const norm = (s: string) => htmlToText(s).replace(/\s+/g, " ");
const manual = norm(html);
/** Text of one chapter or appendix, from its h2 to the next h2. */
function chapter(id: string): string {
  const start = html.indexOf(`<h2 id="${id}"`);
  assert.ok(start >= 0, `chapter #${id} missing`);
  const end = html.indexOf("<h2", start + 4);
  return norm(html.slice(start, end < 0 ? undefined : end));
}
const asm = chapter("assembler");
const video = chapter("video");
const audio = chapter("audio");
const sys = chapter("system");
const eng = chapter("appendix-e");
const refNotes = (m: string) => JSON.stringify(REFERENCE.find(r => r.mnemonic === m)!);
const sentences = (t: string, re: RegExp) => t.split(/(?<=[.;])\s/).filter(s => re.test(s));

// ---------------------------------------------------------------------------
// (f) CYASM, chapter 8: B9-B17, M17-M22

test("B9: expression semantics are exhaustive", () => {
  assert.match(asm, /32-bit two's complement/);
  assert.match(asm, /wraps? (around )?modulo 2\^32/);
  assert.match(asm, /\/ truncates toward zero/);
  assert.match(asm, /% takes the sign of the dividend/);
  assert.match(asm, /[Dd]ivision or remainder by zero is an error/);
  assert.match(asm, /count & 31/);
  assert.match(asm, />> is arithmetic/);
});

test("B10: .byte/.word/.fill ranges and the MOV #$FFFF vs #-1 rule", () => {
  assert.match(asm, /\.byte values must lie in −128…255/);
  assert.match(asm, /\.word values must lie in −32768…65535/);
  assert.match(asm, /\.fill value must lie in −128…255/);
  assert.match(asm, /no silent truncation/);
  assert.match(asm, /MOV R0, #\$FFFF[^.]*2000 FFFF/);
  assert.match(asm, /MOV R0, #-1[^.]*30FF/);
  assert.match(asm, /taken as a 32-bit value/);
});

test("B11: odd-address rules", () => {
  assert.match(asm, /[Aa]n instruction at an odd address is an error/);
  assert.match(asm, /\.word at an odd address is allowed/);
});

test("B12: .org and .bank rules, starting bank and address", () => {
  assert.match(asm, /starts in bank 0 at address 0000/);
  assert.match(asm, /\.org may move backwards/);
  assert.match(asm, /outside the current bank's window is an error/);
  assert.match(asm, /already been emitted is an error/);
  assert.match(asm, /resumes bank n's own location counter/);
});

test("B13: 'known in pass 1' is defined, with the forward-constant example", () => {
  assert.match(asm, /defined on an earlier line by a value that was itself known in pass 1/);
  assert.match(asm, /X = Later \+ 1/);
});

test("B14: string escapes and the character set", () => {
  assert.match(asm, /20–7E/);
  for (const e of ["\\\\", '\\"', "\\'", "\\n", "\\0", "\\xHH"]) assert.ok(asm.includes(e), `escape ${e}`);
  assert.match(asm, /[Aa]ny other escape[^.]*error/);
});

test("B15: duplicate symbols are an error", () => {
  assert.match(asm, /[Dd]efining a symbol twice[^.]*is an error/);
});

test("B16/K2: SHLW..ROLW syntax with n = 0…15; no stale 'no mnemonic' note", () => {
  assert.match(asm, /SHLW Rd, #n[^.]*n = 0…15/);
  assert.doesNotMatch(manual, /CYASM has no mnemonic for the group 2 shift form/);
  for (const m of ["SHL", "SHR", "ASR", "ROL"]) assert.doesNotMatch(refNotes(m), /no mnemonic/);
});

test("B17: .header defaults and title limit; .rom rules", () => {
  assert.match(asm, /title all spaces, dev 0, date 0, version 0, ram 0, generation 0/);
  assert.match(asm, /longer than 24 characters is an error/);
  assert.match(asm, /\.rom n[^.]*power of two from 1 to 256[^.]*highest bank used \+ 1/);
});

test("M17-M22: .align, operator position, errors, local labels, include paths, symbol table", () => {
  assert.match(asm, /\.align n[^.]*power of two from 1 to 16384/);
  assert.match(asm, /[Ww]here a value is expected, \* is the current address and % begins a binary number/);
  assert.match(asm, /TRAP #16/);
  assert.match(asm, /\[R1-4\]/);
  assert.match(asm, /local label before any non-local label is an error/);
  assert.match(asm, /relative to the file that contains the directive/);
  assert.match(asm, /bank as well as its address/);
});

// ---------------------------------------------------------------------------
// Contradictions K1-K8 and example errors X1-X2

test("K1/B6: bank count comes from the image length; 16 KiB is a development board", () => {
  assert.match(manual, /image length ÷ 16 KiB/);
  assert.match(manual, /header[^.]*0015[^.]*never examined/);
  assert.match(manual, /[Rr]etail cartridges are 32 KiB or larger/);
  assert.match(manual, /development and test boards/);
  assert.doesNotMatch(manual, /The smallest cartridge, 16 KiB/);
  assert.match(reg("BANK").description, /image length/);
});

test("K3: no 'runs during active display' anywhere", () => {
  assert.doesNotMatch(manual, /runs during active display/);
});

test("K4: the line pipeline is described once, as a line buffer", () => {
  assert.doesNotMatch(manual, /during the horizontal blank before it/);
  assert.match(video, /line buffer/);
  assert.match(video, /scanned out to the television during line y \+ 1/);
  assert.doesNotMatch(eng, /started four dots before the line/);
  assert.match(eng, /started by the dot-0 strobe/);
});

test("K5: the position counter is 11 bits", () => {
  assert.match(eng, /11-bit up\/down counter/);
  assert.doesNotMatch(manual, /10-bit up\/down counter/);
});

test("K6: every byte-write statement is qualified for command registers", () => {
  const hits = sentences(manual, /other half unchanged/);
  assert.ok(hits.length >= 2, "byte-write rule stated");
  for (const s of hits) assert.match(s, /command register/, `unqualified: ${s}`);
  assert.match(refNotes("STB"), /command register/);
});

test("K7: the inputs are the ROM image, initial cartridge RAM and controller samples", () => {
  assert.doesNotMatch(manual, /[Tt]he only input is the controller state/);
  assert.doesNotMatch(manual, /controller state is the only input/);
  assert.ok((manual.match(/initial cartridge-RAM contents/g) ?? []).length >= 3, "stated in 1.4 (twice) and 7.2");
});

test("K8: the opcode-map caption matches the map", () => {
  assert.doesNotMatch(manual, /Groups 0 and B hold two or more operations per cell/);
  assert.match(manual, /cells 0E and 0F hold only reserved operations/);
  assert.match(manual, /Group B has one operation per cell/);
});

test("X1: light distances reach 1502 (diamond); octagon 1134", () => {
  assert.doesNotMatch(manual, /1150/);
  assert.match(video, /1502/);
  assert.match(video, /1134/);
});

test("X2: the tile loop costs 166 cycles", () => {
  assert.doesNotMatch(manual, /about 168 cycles/);
  assert.match(manual, /12 × 14 − 2 = 166 cycles/);
});

// ---------------------------------------------------------------------------
// BLOCKING B1-B5, B7

test("B1: WAI wakes at a CPU-cycle boundary (multiples of 6 from power-on)", () => {
  for (const t of [refNotes("WAI"), sys]) {
    assert.match(t, /first CPU-cycle boundary at or after/);
    assert.match(t, /multiples of 6 counted from power-on/);
  }
});

test("B2: fetches and stack accesses to I/O behave as data accesses", () => {
  assert.match(manual, /same side effects and wait cycles as a data access/);
  assert.match(manual, /fetches first, then its data accesses/);
});

test("B3-B5, M14-M16: audio write timing, key-on, envelope counting, CTRL reads", () => {
  assert.doesNotMatch(audio, /takes effect at the first sample computed after it/);
  assert.match(audio, /samples whose times are greater than t/);
  assert.match(audio, /first sample after key-on is therefore computed with P = FREQ/);
  assert.match(audio, /ticks of samples produced after the key-on write/);
  assert.match(audio, /reads of ViCTRL reflect the new state immediately/);
  assert.match(audio, /L keeps shifting/);
  assert.doesNotMatch(manual, /every LFSR/);
  assert.match(audio, /apply one after another, in the order they are made/);
});

test("B7: address registers keep their defined bits and wrap; DMADST example", () => {
  assert.match(video, /VADDR keeps bits 14–0; bit 15 is not stored and reads 0/);
  assert.match(video, /OAMADDR keeps bits 8–1; bit 0 is not stored and reads 0/);
  assert.match(video, /DMASRC keeps bits 15–1/);
  assert.match(video, /DMADST 01FE[^.]*0202/);
  assert.match(reg("OAMADDR").description, /bits 8-1/);
  assert.match(reg("VADDR").description, /bit 15 reads 0/);
  assert.match(reg("DMASRC").description, /bit 0 reads 0/);
  assert.match(reg("DMADST").description, /modulo 64 KiB/);
});

// ---------------------------------------------------------------------------
// MINOR items with spec-notes answers (M1, M3, M4, M7, M10, M11, M12)

test("M1, M3, M4, M7, M10-M12: timing details", () => {
  assert.match(manual, /event due at exactly the master cycle at which an instruction starts happens first/);
  assert.match(manual, /in addition to the cycles of the store instruction itself/);
  assert.match(video, /PUSHM or POPM of eight registers[^.]*34/);
  assert.match(sys, /measured from the start of the instruction that writes TCTRL/);
  assert.match(video, /offset 1022[^.]*active display[^.]*1024/);
  assert.match(video, /overflow of line y is recorded at dot 0 of line y/);
  assert.match(video, /byte access to OAMDATA[^.]*adds 2 to OAMADDR/);
});
