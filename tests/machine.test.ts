// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Machine integration: bus decode, cartridge, video ports, interrupts, timer,
// DMA, input, frame timing, determinism and save states (spec-notes §1-§9).
// A scripted CPU drives bus accesses at controlled times.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Machine } from "../src/machine/machine.ts";
import type { Bus, CpuCore } from "../src/machine/types.ts";
import { MASTER_PER_FRAME, MASTER_PER_LINE } from "../src/machine/types.ts";
import { reg } from "../src/hw/registers.ts";

type Action = (bus: Bus) => number; // returns CPU cycles used
class ScriptCpu implements CpuCore {
  r = new Uint16Array(8); sp = 0xc000; pc = 0; f = 0; mode: "run" | "wait" | "stop" = "run";
  script: Action[] = []; i = 0; resets = 0; log: number[] = [];
  reset() { this.resets++; }
  step(bus: Bus) {
    const a = this.script[this.i];
    if (!a) return 1;
    this.i++;
    return a(bus) + bus.takeExtraCycles();
  }
  serialize() { return Uint8Array.of(this.i); }
  deserialize(b: Uint8Array) { this.i = b[0]; }
}

function makeRom(o: { banks?: number; ram?: boolean; magic?: boolean } = {}): Uint8Array {
  const banks = o.banks ?? 4, rom = new Uint8Array(banks * 16384).fill(0xff);
  if (o.magic !== false) rom.set([0x43, 0x59, 0x43, 0x4c], 0x10);           // "CYCL"
  rom[0x15] = banks - 1; rom[0x16] = o.ram ? 1 : 0;
  for (let b = 0; b < banks; b++) { rom[b * 16384 + 0x100] = b; rom[b * 16384 + 0x101] = 0xa0 + b; }
  return rom;
}
const A = (name: string) => reg(name).addr;
function machine(o: Parameters<typeof makeRom>[0] = {}) {
  const cpu = new ScriptCpu();
  const m = new Machine(makeRom(o), { cpu });
  return { m, cpu };
}
/** Run the script until it is exhausted (plus idle), returning the machine time of each action's start. */
function at(m: Machine, cpu: ScriptCpu, masterCycle: number, action: Action) {
  // idle until the given time, then act
  cpu.script.push(() => Math.ceil((masterCycle - m.masterCycle) / 6));
  cpu.script.push(action);
}

test("ROM bank 0 fixed, window defaults to bank 1, BANK wraps modulo bank count, ROM writes ignored", () => {
  const { m } = machine({ banks: 4 });
  const b = m.bus;
  assert.equal(b.read8(0x0100), 0);
  assert.equal(b.read8(0x4100), 1);
  b.write16(A("BANK"), 3); assert.equal(b.read16(0x4100), 0xa303);
  b.write16(A("BANK"), 6); assert.equal(b.read8(0x4100), 2);
  assert.equal(b.read16(A("BANK")), 6);
  b.write8(0x0100, 0x55); assert.equal(b.read8(0x0100), 0);
});

test("work RAM little-endian; unmapped and absent cartridge RAM read 0", () => {
  const { m } = machine();
  const b = m.bus;
  b.write16(0x8000, 0x1234); assert.equal(b.read8(0x8000), 0x34); assert.equal(b.read8(0x8001), 0x12);
  b.write16(0x8003, 0xbeef); assert.equal(b.read16(0x8002), 0xbeef); // odd word address aligns down
  b.write8(0xc000, 0x77); assert.equal(b.read8(0xc000), 0);
  assert.equal(b.read16(0xe800), 0); assert.equal(b.read16(0xf100), 0); assert.equal(b.read16(0xf0f0), 0);
});

test("cartridge RAM needs RAMCTL bit 0 for writes", () => {
  const { m } = machine({ ram: true });
  const b = m.bus;
  b.write8(0xc010, 0x42); assert.equal(b.read8(0xc010), 0);
  b.write16(A("RAMCTL"), 1); b.write8(0xc010, 0x42); assert.equal(b.read8(0xc010), 0x42);
  assert.equal(b.read16(A("RAMCTL")), 1);
});

test("VDATA reads/writes VRAM words and advances VADDR by VINC; byte access; wrap", () => {
  const { m } = machine();
  const b = m.bus;
  b.write16(A("VADDR"), 0x10); b.write16(A("VDATA"), 0xabcd); b.write16(A("VDATA"), 0x1234);
  assert.deepEqual([...m.video.vram.subarray(0x10, 0x14)], [0xcd, 0xab, 0x34, 0x12]);
  b.write16(A("VINC"), 64); b.write16(A("VADDR"), 0x7fe0); b.write16(A("VDATA"), 1);
  assert.equal(b.read16(A("VADDR")), 0x0020);
  b.write16(A("VADDR"), 0x10); b.write16(A("VINC"), 1);
  assert.equal(b.read8(A("VDATA")), 0xcd);          // even byte at VADDR, then +1
  assert.equal(b.read8(A("VDATA") + 1), 0xab);      // odd byte at VADDR=0x11
});

test("CRAMDATA (12-bit, +1) and OAMDATA (+2) ports", () => {
  const { m } = machine();
  const b = m.bus;
  b.write16(A("CRAMADDR"), 511); b.write16(A("CRAMDATA"), 0xfabc); b.write16(A("CRAMDATA"), 0x0123);
  assert.equal(m.video.cram[511], 0x0abc); assert.equal(m.video.cram[0], 0x0123);
  b.write16(A("CRAMADDR"), 511); assert.equal(b.read16(A("CRAMDATA")), 0x0abc);
  b.write16(A("OAMADDR"), 0x1fe); b.write16(A("OAMDATA"), 0x5566); b.write16(A("OAMDATA"), 0x7788);
  assert.deepEqual([m.video.oam[0x1fe], m.video.oam[0x1ff], m.video.oam[0], m.video.oam[1]], [0x66, 0x55, 0x88, 0x77]);
});

test("undefined register bits read 0; read-only registers ignore writes", () => {
  const { m } = machine();
  const b = m.bus;
  b.write16(A("L0I"), 0xffff); assert.equal(b.read16(A("L0I")), 0x000f);
  b.write16(A("L0F"), 0xffff); assert.equal(b.read16(A("L0F")), 0x0037);
  b.write16(A("AMBIENT"), 0xffff); assert.equal(b.read16(A("AMBIENT")), 7);
  b.write16(A("VCOUNT"), 99); assert.equal(b.read16(A("VCOUNT")), 0);
  b.write8(A("LINECMP") + 1, 0x01); b.write8(A("LINECMP"), 0x05); assert.equal(b.read16(A("LINECMP")), 0x105);
});

test("video port wait: 2 extra cycles during active display, none in vertical blank", () => {
  const { m, cpu } = machine();
  const extras: number[] = [];
  at(m, cpu, 100 * MASTER_PER_LINE, b => { b.write16(A("VDATA"), 1); extras.push(b.takeExtraCycles()); return 2; });
  at(m, cpu, 230 * MASTER_PER_LINE, b => { b.write16(A("VDATA"), 1); extras.push(b.takeExtraCycles()); return 2; });
  m.runFrame(0, 0);
  assert.deepEqual(extras, [2, 0]);
});

test("VCOUNT, VSTAT vblank bit, VBLANK IF at line 224 and LINE IF at dot 256 of LINECMP", () => {
  const { m, cpu } = machine();
  const seen: number[][] = [];
  cpu.script.push(b => { b.write16(A("LINECMP"), 50); return 2; });
  at(m, cpu, 50 * MASTER_PER_LINE + 1000, b => { seen.push([b.read16(A("VCOUNT")), b.read16(A("IF"))]); return 2; });
  at(m, cpu, 50 * MASTER_PER_LINE + 1030, b => { seen.push([b.read16(A("VCOUNT")), b.read16(A("IF"))]); b.write16(A("IF"), 2); return 2; });
  at(m, cpu, 223 * MASTER_PER_LINE + 1300, b => { seen.push([b.read16(A("VSTAT")) & 1, b.read16(A("IF")) & 1]); return 2; });
  at(m, cpu, 224 * MASTER_PER_LINE + 6, b => { seen.push([b.read16(A("VSTAT")) & 1, b.read16(A("IF")) & 1, b.read16(A("VCOUNT"))]); return 2; });
  m.runFrame(0, 0);
  assert.deepEqual(seen, [[50, 0], [50, 2], [0, 0], [1, 1, 224]]);
});

test("IF: write 1 clears; high-byte writes ignored; IE masks pendingInterrupts", () => {
  const { m } = machine();
  const b = m.bus;
  m.raiseInterrupt(7);
  b.write8(A("IF") + 1, 0xff); assert.equal(b.read16(A("IF")), 7);
  b.write8(A("IF"), 1); assert.equal(b.read16(A("IF")), 6);
  assert.equal(b.pendingInterrupts(), 0);
  b.write16(A("IE"), 4); assert.equal(b.pendingInterrupts(), 4);
});

test("timer: prescaler 16, underflow from 0 reloads and sets IF bit 2", () => {
  const { m, cpu } = machine();
  cpu.script.push(b => { b.write16(A("TRELOAD"), 3); b.write16(A("TCOUNT"), 1); b.write16(A("TCTRL"), 1 | (1 << 1)); return 2; });
  cpu.script.push(() => 16);   // 16 cycles -> one tick: 1 -> 0
  cpu.script.push(b => { assert.equal(b.read16(A("TCOUNT")), 0); assert.equal(b.read16(A("IF")) & 4, 0); return 12; }); // 2+16+12 = 30 cycles: one tick so far
  cpu.script.push(() => { return 16; });          // tick: 0 -> reload 3, IF
  cpu.script.push(b => { assert.equal(b.read16(A("TCOUNT")), 3); assert.equal(b.read16(A("IF")) & 4, 4); return 2; });
  m.runFrame(0, 0);
  assert.equal(cpu.i, 5);
});

test("DMA to VRAM/CRAM/OAM: data, pointer advance, cost decided at transfer start, E000+ source reads 0", () => {
  const { m, cpu } = machine();
  const b0 = m.bus;
  b0.write16(0x8000, 0x1111); b0.write16(0x8002, 0x2222); b0.write16(0x8004, 0x0fed);
  const costs: number[] = [];
  const dma = (src: number, dst: number, len: number, target: number) => (b: Bus) => {
    b.write16(A("DMASRC"), src); b.write16(A("DMADST"), dst); b.write16(A("DMALEN"), len); b.write16(A("DMACTL"), target);
    costs.push(b.takeExtraCycles()); return 2;
  };
  at(m, cpu, 10 * MASTER_PER_LINE, dma(0x8000, 0x100, 2, 1));       // active display: 4 + 4*2
  at(m, cpu, 240 * MASTER_PER_LINE, dma(0x8004, 5, 1, 3));          // vblank: 4 + 2*1
  at(m, cpu, 241 * MASTER_PER_LINE, dma(0xf000, 0x10, 1, 2));        // I/O source reads 0
  at(m, cpu, 242 * MASTER_PER_LINE, dma(0x8000, 0, 0, 1));           // zero length still 4
  m.runFrame(0, 0);
  assert.deepEqual(costs, [12, 6, 6, 4]);
  assert.deepEqual([...m.video.vram.subarray(0x100, 0x104)], [0x11, 0x11, 0x22, 0x22]);
  assert.equal(m.video.cram[5], 0x0fed);
  assert.deepEqual([m.video.oam[0x10], m.video.oam[0x11]], [0, 0]);
  assert.equal(m.bus.read16(A("DMALEN")), 0);
});

test("pads are sampled at line 224 and held; high bits read 0", () => {
  const { m, cpu } = machine();
  const seen: number[] = [];
  at(m, cpu, 100 * MASTER_PER_LINE, b => { seen.push(b.read16(A("PAD1"))); return 2; });
  at(m, cpu, 230 * MASTER_PER_LINE, b => { seen.push(b.read16(A("PAD1")), b.read16(A("PAD2"))); return 2; });
  m.runFrame(0x1ff, 0x80);
  assert.deepEqual(seen, [0, 0xff, 0x80]);
});

test("probe: ready and value at dot 256 of PROBEY; reading PROBE clears ready", () => {
  const { m, cpu } = machine();
  cpu.script.push(b => { b.write16(A("VCTRL"), 1 | 16); b.write16(A("AMBIENT"), 5); b.write16(A("PROBEX"), 7); b.write16(A("PROBEY"), 20); return 2; });
  const seen: number[] = [];
  at(m, cpu, 20 * MASTER_PER_LINE + 1000, b => { seen.push(b.read16(A("VSTAT")) & 4); return 2; });
  at(m, cpu, 20 * MASTER_PER_LINE + 1030, b => { seen.push(b.read16(A("VSTAT")) & 4, b.read16(A("PROBE")), b.read16(A("VSTAT")) & 4); return 2; });
  m.runFrame(0, 0);
  assert.deepEqual(seen, [0, 4, 0x8000 | (5 << 8), 0]);
});

test("sprite overflow bit is sticky until VSTAT is read", () => {
  const { m, cpu } = machine();
  cpu.script.push(b => { b.write16(A("VCTRL"), 1 | 8); return 2; }); // OAM zeroed: 64 sprites at (0,0)
  m.runFrame(0, 0);
  cpu.script.push(b => { assert.equal(b.read16(A("VSTAT")) & 2, 2); assert.equal(b.read16(A("VSTAT")) & 2, 0); return 2; });
  cpu.i = cpu.script.length - 1;
  m.runFrame(0, 0);
});

test("lockout: a ROM without the CYCL magic never runs the CPU", () => {
  const { m, cpu } = machine({ magic: false });
  cpu.script.push(() => { throw new Error("CPU ran"); });
  m.runFrame(0, 0);
  assert.equal(m.running, false);
});

test("frames are exactly 358,416 master cycles; overrun is carried into the next frame", () => {
  const { m, cpu } = machine();
  at(m, cpu, MASTER_PER_FRAME - 6, () => 10);  // straddles the boundary by 54 master cycles
  m.runFrame(0, 0);
  assert.equal(m.frame, 1);
  assert.equal(m.masterCycle, MASTER_PER_FRAME + 54);
  m.runFrame(0, 0);
  assert.equal(m.frame, 2);
  assert.ok(m.masterCycle >= 2 * MASTER_PER_FRAME);
});

test("framebuffer shows CRAM[FIXED*64] with the display disabled", () => {
  const { m } = machine();
  m.video.cram[7 * 64] = 0x0f00;
  m.runFrame(0, 0);
  assert.equal(m.framebuffer[0], 0xff0000);
  assert.equal(m.framebuffer[256 * 224 - 1], 0xff0000);
});

test("save state round trip reproduces the same hash and continues identically", () => {
  const run = () => {
    const { m, cpu } = machine({ ram: true });
    for (let k = 0; k < 40; k++) cpu.script.push(b => { b.write16(0x8000 + k * 2, k * 77); b.write16(A("VDATA"), k); return 30 + k; });
    return { m, cpu };
  };
  const a = run(); a.m.runFrame(1, 2);
  const saved = a.m.saveState();
  const h1 = a.m.hash();
  a.m.runFrame(3, 4); const h2 = a.m.hash();
  const b = run(); b.m.loadState(saved);
  assert.equal(b.m.hash(), h1);
  b.m.runFrame(3, 4);
  assert.equal(b.m.hash(), h2);
  const c = run(); c.m.runFrame(1, 2); c.m.runFrame(3, 4);
  assert.equal(c.m.hash(), h2); // determinism
});

test("the Cue audio chip is attached by default: registers reach it and one frame yields its samples", () => {
  const { m, cpu } = machine();
  cpu.script.push(b => { b.write16(A("MASTERVOL"), 15); b.write16(A("V0FREQ"), 601); b.write16(A("V0WAVE"), 2); b.write16(A("V0ENV"), 15); b.write16(A("V0CTRL"), 1); return 2; });
  cpu.script.push(b => { assert.equal(b.read16(A("V0CTRL")) & 0x0f01, 0x0f01); return 2; });
  m.runFrame(0, 0);
  const s = m.audio.takeSamples();
  assert.equal(s.length, Math.floor(358416 / 448)); // samples with timestamp 448(k+1) <= 358416
  assert.ok(s.some(v => v !== 0));
});

test("DMACTL target 0 does nothing: no stall (spec-notes §83)", () => {
  const { m } = machine();
  const b = m.bus;
  b.write16(A("DMALEN"), 10); b.write16(A("DMACTL"), 0);
  assert.equal(b.takeExtraCycles(), 0);
  assert.equal(b.read16(A("DMALEN")), 10);
});

test("RAMCTL does not exist without cartridge RAM (spec-notes §84)", () => {
  const { m } = machine({ ram: false });
  m.bus.write16(A("RAMCTL"), 1);
  assert.equal(m.bus.read16(A("RAMCTL")), 0);
});
