// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// I/O register map shared by emulator, assembler symbols and the manual.
import { test } from "node:test";
import assert from "node:assert/strict";
import { REGISTERS, reg, registerAt, CHIP_RANGES } from "../src/hw/registers.ts";

test("names and addresses are unique and word-aligned", () => {
  const names = new Set<string>(), addrs = new Set<number>();
  for (const r of REGISTERS) {
    assert.ok(!names.has(r.name), `duplicate name ${r.name}`); names.add(r.name);
    assert.ok(!addrs.has(r.addr), `duplicate addr ${r.addr.toString(16)}`); addrs.add(r.addr);
    assert.equal(r.addr & 1, 0, `${r.name} unaligned`);
    assert.ok(["r", "w", "rw"].includes(r.access), r.name);
    assert.ok(r.description.length > 10, `${r.name} needs a description`);
  }
});

test("every register lies inside its chip's address range", () => {
  for (const r of REGISTERS) {
    const [lo, hi] = CHIP_RANGES[r.chip];
    assert.ok(r.addr >= lo && r.addr <= hi, `${r.name} @${r.addr.toString(16)} outside ${r.chip}`);
  }
});

test("pinned addresses (spec golden values)", () => {
  const golden: Record<string, number> = {
    BANK: 0xe000, RAMCTL: 0xe002,
    VADDR: 0xf000, VDATA: 0xf002, VINC: 0xf004, VCTRL: 0xf006, VSTAT: 0xf008, VCOUNT: 0xf00a, LINECMP: 0xf00c,
    BG0SCX: 0xf010, BG0SCY: 0xf012, BG1SCX: 0xf014, BG1SCY: 0xf016, BG0MAP: 0xf018, BG1MAP: 0xf01a,
    OAMADDR: 0xf01c, OAMDATA: 0xf01e, CRAMADDR: 0xf020, CRAMDATA: 0xf022,
    L0X: 0xf030, L0Y: 0xf032, L0I: 0xf034, L0F: 0xf036, L3X: 0xf048, L3F: 0xf04e,
    AMBIENT: 0xf050, FIXED: 0xf052, PROBEX: 0xf054, PROBEY: 0xf056, PROBE: 0xf058,
    V0FREQ: 0xf080, V0WAVE: 0xf082, V0ENV: 0xf084, V0CTRL: 0xf086, V3FREQ: 0xf098, V3CTRL: 0xf09e,
    WAVE0: 0xf0a0, WAVE7: 0xf0ae, MASTERVOL: 0xf0b0,
    PAD1: 0xf0c0, PAD2: 0xf0c2,
    TRELOAD: 0xf0d0, TCOUNT: 0xf0d2, TCTRL: 0xf0d4, IE: 0xf0d8, IF: 0xf0da,
    DMASRC: 0xf0e0, DMADST: 0xf0e2, DMALEN: 0xf0e4, DMACTL: 0xf0e6,
  };
  for (const [name, addr] of Object.entries(golden)) assert.equal(reg(name).addr, addr, name);
});

test("light field has 4 lights x 4 registers; audio has 4 voices x 4 registers", () => {
  assert.equal(REGISTERS.filter(r => /^L[0-3][XYIF]$/.test(r.name)).length, 16);
  assert.equal(REGISTERS.filter(r => /^V[0-3](FREQ|WAVE|ENV|CTRL)$/.test(r.name)).length, 16);
  assert.equal(REGISTERS.filter(r => /^WAVE[0-7]$/.test(r.name)).length, 8);
});

test("registerAt finds registers and returns undefined for gaps", () => {
  assert.equal(registerAt(0xf058)?.name, "PROBE");
  assert.equal(registerAt(0xf0f8), undefined);
  assert.throws(() => reg("NOPE"));
});
