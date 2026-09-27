// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// The debugger's DOM-free core (src/web/debugger/session.ts): stepping by
// instruction or frame, PC breakpoints and write watchpoints, all without
// changing what the machine computes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DebugSession } from "../src/web/debugger/session.ts";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";
import { disassemble } from "../src/asm/disassembler.ts";
import { assemble } from "../src/asm/assembler.ts";
import { sourceReader } from "../tools/art.ts";
import { buildRom } from "../tools/conformance.ts";

const FILE = "roms/lantern-test/lantern-test.asm";
const rom = buildRom(FILE);
const sym = assemble(FILE, sourceReader(p => readFileSync(p, "utf8"))).symbols;
const VBLANK = sym.get("vblank")!, MAIN = sym.get("main")!;
const NONE: [number, number] = [0, 0];

function reference(frames: number) {
  const m = new Machine(rom, { cpu: new Tally() });
  for (let f = 0; f < frames; f++) m.runFrame(0, 0);
  return m;
}

test("stepping instruction by instruction and frame by frame computes exactly what runFrame does", () => {
  const s = new DebugSession(rom);
  s.breakpoints.add(0xfffe);                              // never hit: forces the stepwise path
  let steps = 0;
  while (s.machine.frame < 3) { s.stepInstruction(NONE); steps++; }
  assert.ok(steps > 1000, `${steps} steps`);
  while (s.machine.frame < 8) assert.equal(s.advanceFrame(NONE), null);
  assert.equal(s.machine.hash(), reference(8).hash());
  s.breakpoints.clear();
  s.advanceFrame(NONE);                                   // fast path
  assert.equal(s.machine.hash(), reference(9).hash());
});

test("a PC breakpoint stops at the VBLANK handler, and resuming stops there again one frame later", () => {
  const s = new DebugSession(rom);
  s.breakpoints.add(VBLANK);
  let hit = null;
  for (let f = 0; f < 5 && !hit; f++) hit = s.advanceFrame(NONE);
  assert.deepEqual(hit, { kind: "breakpoint", pc: VBLANK });
  assert.equal(s.machine.cpu.pc, VBLANK);
  assert.equal(s.machine.cpu.mode, "run");
  const frame = s.machine.frame;
  let again = s.advanceFrame(NONE);
  if (!again) again = s.advanceFrame(NONE);
  assert.deepEqual(again, { kind: "breakpoint", pc: VBLANK });
  assert.equal(s.machine.frame, frame + 1);
});

test("step instruction advances PC by the decoded instruction length", () => {
  const s = new DebugSession(rom);
  s.breakpoints.add(VBLANK);
  while (!s.advanceFrame(NONE));
  for (let k = 0; k < 4; k++) {
    const pc = s.machine.cpu.pc;
    const [line] = disassemble(rom, pc, 1);
    s.stepInstruction(NONE);
    assert.equal(s.machine.cpu.pc, pc + line.words.length * 2, line.text);
  }
});

test("step instruction out of WAI runs the idle cycles until the CPU resumes", () => {
  const s = new DebugSession(rom);
  s.breakpoints.add(MAIN + 2);                            // BRA main, right after WAI
  while (!s.advanceFrame(NONE));
  s.stepInstruction(NONE);                                // BRA main
  s.stepInstruction(NONE);                                // WAI: enters wait
  assert.equal(s.machine.cpu.mode, "wait");
  s.stepInstruction(NONE);                                // idles until VBLANK is taken
  assert.equal(s.machine.cpu.mode, "run");
  assert.equal(s.machine.cpu.pc, VBLANK);
});

test("a write watchpoint stops after the write, reporting address, value and the writing instruction", () => {
  const s = new DebugSession(rom);
  s.watchpoints.add(0xf030);                              // L0X
  let hit = null;
  for (let f = 0; f < 5 && !hit; f++) hit = s.advanceFrame(NONE);
  assert.ok(hit && hit.kind === "watch", JSON.stringify(hit));
  assert.equal(hit.addr, 0xf030);
  assert.equal(hit.value, 120 + 8);
  assert.equal(disassemble(rom, hit.pc, 1)[0].text, "ST R3, [$F030]");
  assert.equal(s.machine.cpu.pc, hit.pc + 4);
  s.watchpoints.clear(); s.watchpoints.add(0x8001);       // high byte of PX: a word write covers it
  hit = null;
  for (let f = 0; f < 5 && !hit; f++) hit = s.advanceFrame(NONE);
  assert.ok(hit && hit.kind === "watch");
  assert.equal(hit.addr, 0x8001);
});

test("save and load state through the session restore the exact machine", () => {
  const s = new DebugSession(rom);
  for (let f = 0; f < 3; f++) s.advanceFrame(NONE);
  const saved = s.machine.saveState(), h = s.machine.hash();
  s.advanceFrame(NONE);
  s.machine.loadState(saved);
  assert.equal(s.machine.hash(), h);
});

test("loadStored: a state that does not fit is reported, never thrown, and changes nothing; old v1 debugger saves still load", () => {
  const s = new DebugSession(rom);
  for (let f = 0; f < 5; f++) s.advanceFrame(NONE);
  const mine = s.machine.saveState(), at5 = s.machine.hash();
  s.advanceFrame(NONE);
  const at6 = s.machine.hash();
  // cut short: refused with the player-facing message, machine untouched
  assert.match(s.loadStored(mine.slice(0, 40), "LANTERN TEST") ?? "", /incomplete/);
  assert.equal(s.machine.hash(), at6);
  // another ROM build (one byte differs, so its SHA-256 differs): refused and kept
  const other = rom.slice(); other[other.length - 1] ^= 0xff;
  assert.match(s.loadStored(new Machine(other, { cpu: new Tally() }).saveState(), "LANTERN TEST") ?? "", /different version of LANTERN TEST/);
  assert.equal(s.machine.hash(), at6);
  // its own v2 state loads
  assert.equal(s.loadStored(mine, "LANTERN TEST"), null);
  assert.equal(s.machine.hash(), at5);
  // a debugger save written before v2 (v1, no ROM identity) still loads
  const v1 = new Uint8Array(readFileSync("tests/fixtures/savestate-v1/lantern-test.v1.state"));
  assert.equal(s.loadStored(v1, "LANTERN TEST"), null);
});
