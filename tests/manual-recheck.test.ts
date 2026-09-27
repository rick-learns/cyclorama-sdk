// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// M1 re-check (research/m1-recheck.md) pinned against the built manual.
// Rulings: docs/spec-notes.md §10 items 66-71 (M2, M5, M6, M8, M9, M13) and §11 items 72-82.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REFERENCE } from "../src/isa/reference.ts";
import { reg } from "../src/hw/registers.ts";
import { htmlToText } from "../tools/canon/lib.ts";

const html = readFileSync("docs/manual/index.html", "utf8");
const norm = (s: string) => htmlToText(s).replace(/\s+/g, " ");
const manual = norm(html);
/** Text from the heading with this id to the next heading of the same or a higher level. */
function section(id: string): string {
  const m = new RegExp(`<h([234]) id="${id}"`).exec(html);
  assert.ok(m, `section #${id} missing`);
  const level = +m[1];
  const rest = html.slice(m.index + 4);
  const next = new RegExp(`<h[2-${level}][ >]`).exec(rest);
  return norm(html.slice(m.index, next ? m.index + 4 + next.index : undefined));
}
const refNotes = (m: string) => JSON.stringify(REFERENCE.find(r => r.mnemonic === m)!);

const model = section("ov-model");          // 1.4
const cpuMem = section("cpu-memory");       // 2.2
const cpuDecode = section("cpu-decode");    // 2.5.1
const lockout = section("sys-lockout");     // 3.2
const interrupts = section("sys-interrupts"); // 3.4 (with 3.4.1, 3.4.2)
const ei = section("sys-ei");               // 3.4.1
const wai = section("sys-wai");             // 3.5
const cartRam = section("cart-ram");        // 4.5
const header = section("cart-header");      // 4.4
const video = section("video");
const input = section("input");
const asm = section("assembler");
const eng3 = section("eng-barndoor");       // E.3
const regs = section("registers");          // Appendix F

// ---------------------------------------------------------------------------
// §11 items 72 and 78: interrupt entry timing and events at a boundary

test("§11.72 (B2): interrupt entry is timed like an instruction", () => {
  for (const t of [model, interrupts]) {
    assert.match(t, /[Ii]nterrupt entry is timed like an instruction/);
    assert.match(t, /two pushes take effect at the master-cycle time at which the entry starts/);
    assert.match(t, /port wait[^.]*judged at that time/);
  }
});

test("§11.78 (N5): an event at a boundary is processed before that boundary's interrupt check", () => {
  for (const t of [model, interrupts]) {
    assert.match(t, /before that boundary's interrupt check/);
    assert.match(t, /dot 0 of line 224/);
  }
});

// ---------------------------------------------------------------------------
// §10 items 66-71

test("§10.66 (M2): the EI delay applies every time EI executes", () => {
  assert.match(ei, /every time EI executes, even when I is already 1/);
  assert.match(refNotes("EI"), /every time EI executes, even when I is already 1/);
});

test("§10.67 (M5): cartridge RAM is fitted exactly when header byte 0016 = 1", () => {
  assert.match(cartRam, /fitted exactly when header byte 0016 = 1/);
  assert.match(cartRam, /whatever the generation byte 0017 says/);
  // 3.2 must not read as if nothing but the magic describes the machine.
  assert.match(lockout, /lockout/);
  assert.match(lockout, /0016/);
  assert.match(lockout, /reference model/);
});

test("§10.68 (M6): cartridge RAM starts undefined; the reference model starts it at zero and preserves it", () => {
  assert.match(cartRam, /undefined/);
  assert.match(cartRam, /reference model starts (it|cartridge RAM) at zero/);
  assert.match(cartRam, /preserves (it|its contents) exactly/);
});

test("§10.69 (M8): STOP halts only the processor", () => {
  assert.match(wai, /STOP halts only the processor/);
  assert.match(wai, /timer, video, audio[^.]*keep running/);
  assert.match(refNotes("STOP"), /halts only the processor/);
  assert.doesNotMatch(manual, /STOP halts the processor until reset\./);
});

test("§10.70 (M9): the host supplies PAD1 then PAD2 each frame", () => {
  assert.match(input, /two bytes per frame, PAD1 then PAD2/);
});

test("§10.71 (M13): 12-bit colour is converted by multiplying each channel by 17", () => {
  assert.match(video, /multiplying each 4-bit channel by 17/);
  assert.match(video, /15 × 17 = 255/);
});

// ---------------------------------------------------------------------------
// §11 item 73: .rom, .header titles, reserved bytes

test("§11.73 (B17): highest bank used, title character set, reserved header bytes", () => {
  assert.match(asm, /highest bank used is the highest bank selected by \.bank or containing any emitted byte/);
  assert.match(asm, /\.bank 5[^.]*8 banks/);
  assert.match(asm, /title must be printable ASCII, 20–7E, after escapes are processed/);
  assert.match(asm, /\\x80/);
  assert.match(asm, /reserved bytes 003A–003F[^.]*0/);
  assert.match(header, /[Pp]rintable ASCII \(20–7E\)/);
});

// ---------------------------------------------------------------------------
// §11 item 74: odd word displacements

test("§11.74 (N1): an odd word displacement is always an error, never the long form", () => {
  assert.match(asm, /odd displacement[^.]*error in every form/);
  assert.match(asm, /never selects the long form/);
  assert.doesNotMatch(asm, /0…126 and even; otherwise group 8/);
  for (const m of ["LD", "ST"]) {
    assert.match(refNotes(m), /odd d is an error in every form/);
    assert.match(refNotes(m), /never selects the \[Rs\+d16\] form/);
    assert.doesNotMatch(refNotes(m), /in range; otherwise it writes the \[Rs\+d16\] form/);
  }
});

// ---------------------------------------------------------------------------
// §11 item 75: VADDR bit 0 and byte access

test("§11.75 (N2): VADDR keeps bit 0; F002/F003 byte access choose the even/odd byte", () => {
  assert.match(video, /VADDR keeps bits 14–0/);
  assert.match(video, /VADDR = 0011[^.]*F002 reads (VRAM )?byte 0010[^.]*F003 reads (VRAM )?byte 0011/);
  assert.match(video, /VADDR \| 1/);
  assert.doesNotMatch(manual, /used by byte access/);
  assert.doesNotMatch(reg("VADDR").description, /used by byte access/);
  assert.match(reg("VADDR").description, /F003/);
  assert.match(regs, /VADDR[^.]*bit 0 is kept/);
});

// ---------------------------------------------------------------------------
// §11 items 76, 77, 79, 80, 81: CYASM

test("§11.76 (N3): emitting past the end of a bank window is an error", () => {
  assert.match(asm, /past the end of the current bank's window \(3FFF for bank 0, 7FFF for the others\) is an error/);
  assert.match(asm, /never spills into another bank or wraps/);
});

test("§11.77 (N4): every 16-bit field accepts −32768…65535", () => {
  assert.match(asm, /Every 16-bit field[^.]*accepts −32768…65535 and stores the value modulo 65536/);
  assert.match(asm, /JMP \$10000/);
  assert.match(asm, /\[Rs\+d16\] addition wraps/);
});

test("§11.79 (N6): a label on a .org/.align/.bank line takes the address after the directive", () => {
  assert.match(asm, /label on the same line as \.org, \.align or \.bank takes the address after the directive/);
  assert.match(asm, /\.header never moves a location counter/);
});

test("§11.80 (N7): register names and predefined I/O register names are not case-sensitive", () => {
  assert.match(asm, /the predefined I\/O register names and directives are not case-sensitive/);
  assert.match(asm, /vctrl = 5/);
  assert.match(asm, /[Uu]ser-defined symbols are case-sensitive/);
});

test("§11.81 (N8): a numeric literal that does not fit in 32 bits is an error", () => {
  assert.match(asm, /numeric literal whose value does not fit in 32 bits[^.]*is an error/);
  assert.match(asm, /\$100000000/);
});

// ---------------------------------------------------------------------------
// §11 item 82: wording (N9-N11)

test("§11.82 (N9): PROBEY of 224 or above never matches (not 'never latch')", () => {
  assert.doesNotMatch(manual, /never latch/);
  assert.doesNotMatch(reg("PROBEY").description, /never latch/);
  assert.match(reg("PROBEY").description, /never match/);
});

test("§11.82 (N10): Appendix E describes the line buffer of 5.8", () => {
  assert.match(eng3, /line buffer of 5\.8/);
  assert.doesNotMatch(eng3, /short queue that the fetch sequencer drains in the dots it does not need/);
  assert.match(eng3, /first seen on line y \+ 1/);
});

test("§11.82 (N11): ADDSP's field is s8 and the SP change is s8 × 2", () => {
  assert.doesNotMatch(cpuDecode, /ADDSP \(n = sx8/);
  assert.match(cpuDecode, /ADDSP \(s8 = w & 255/);
  assert.match(refNotes("ADDSP"), /sx8\(s8\) × 2/);
  assert.doesNotMatch(refNotes("ADDSP"), /n\/2/);
});

test("2.2 still states the fetch/stack rule (context for §11.72)", () => {
  assert.match(cpuMem, /pushes of interrupt entry are ordinary bus accesses/);
});
