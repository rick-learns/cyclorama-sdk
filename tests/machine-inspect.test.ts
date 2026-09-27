// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Read-only debugger views of the machine (Machine.inspect / peek8 / peek16):
// they must report what the CPU would see, and never change machine state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";
import { reg } from "../src/hw/registers.ts";
import { buildRom, runRom } from "../tools/conformance.ts";

const A = (name: string) => reg(name).addr;

function romWith(banks: number, ram: boolean) {
  const rom = new Uint8Array(banks * 16384).fill(0xff);
  rom.set([0x43, 0x59, 0x43, 0x4c], 0x10);
  rom[0x15] = banks - 1; rom[0x16] = ram ? 1 : 0;
  rom[0] = 0x40; rom[1] = 0;                      // reset vector 0040
  rom[0x40] = 0x80; rom[0x41] = 0x00;             // STOP (group 0 op 1)
  for (let b = 0; b < banks; b++) rom[b * 16384 + 0x123] = 0xb0 + b;
  return rom;
}

test("peek8/peek16 read memory exactly as the CPU bus does (bank window, work RAM, cartridge RAM)", () => {
  const m = new Machine(romWith(4, true), { cpu: new Tally() });
  m.bus.write16(A("RAMCTL"), 1);
  m.bus.write8(0x8010, 0x5a); m.bus.write8(0xc003, 0xa5);
  for (const bank of [0, 1, 2, 3, 5]) {
    m.bus.write16(A("BANK"), bank);
    for (const a of [0x0123, 0x4123, 0x8010, 0xc003, 0xe100, 0xf0f0]) assert.equal(m.peek8(a), m.bus.read8(a), `bank ${bank} addr ${a.toString(16)}`);
    assert.equal(m.peek16(0x4122), m.bus.read16(0x4122));
    assert.equal(m.inspect().bank, bank % 4);
  }
});

test("peek of I/O ports and latches has no side effects", () => {
  const m = new Machine(romWith(2, false), { cpu: new Tally() });
  m.bus.write16(A("VADDR"), 0x100); m.bus.write16(A("VDATA"), 0x1234); m.bus.write16(A("VADDR"), 0x100);
  m.bus.write16(A("CRAMADDR"), 5); m.bus.write16(A("CRAMDATA"), 0xabc); m.bus.write16(A("CRAMADDR"), 5);
  m.bus.write16(A("OAMADDR"), 8); m.bus.write16(A("OAMDATA"), 0x77); m.bus.write16(A("OAMADDR"), 8);
  const before = m.hash();
  assert.equal(m.peek16(A("VDATA")), 0x1234);
  assert.equal(m.peek16(A("CRAMDATA")), 0xabc);
  assert.equal(m.peek16(A("OAMDATA")), 0x77);
  assert.equal(m.peek8(A("VDATA") + 1), 0x12);
  assert.equal(m.peek16(A("VADDR")), 0x100);
  assert.equal(m.hash(), before, "peeks leave the state untouched");
  // and the real reads agree with the peeks
  assert.equal(m.bus.read16(A("VDATA")), 0x1234);
  assert.equal(m.bus.read16(A("CRAMDATA")), 0xabc);
});

test("inspect() reports registers, IF/IE, probe and VSTAT without clearing them, and returns a copy", () => {
  const rom = buildRom("roms/lantern-test/lantern-test.asm");
  const { m } = runRom(rom, 10);
  const before = m.hash();
  const s = m.inspect();
  assert.equal(s.IE, 1);
  assert.equal(s.regs.L0I, 6);
  assert.equal(s.regs.L0F, 0x24);
  assert.equal(s.regs.VCTRL, 1 | 2 | 8 | 16);
  assert.equal(s.regs.BANK, 1);
  assert.equal(s.line, Math.floor((m.masterCycle % 358416) / 1368));
  assert.equal(s.vstat, m.peek16(A("VSTAT")));
  assert.equal(s.probe, m.peek16(A("PROBE")));
  assert.equal(s.IF, m.peek16(A("IF")));
  s.regs.L0I = 3;
  assert.equal(m.inspect().regs.L0I, 6, "snapshot is a copy");
  assert.equal(m.hash(), before);
  // peeks agree with CPU reads for every stored register
  for (const name of ["BANK", "VCTRL", "L0X", "L0Y", "L0I", "L0F", "AMBIENT", "FIXED", "IE", "TCTRL", "BG0MAP"])
    assert.equal(m.peek16(A(name)), m.bus.read16(A(name)), name);
});
