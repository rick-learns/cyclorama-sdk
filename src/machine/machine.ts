// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// The Avenell Cyclorama: bus, cartridge, Barndoor register block, interrupt
// controller, timer, DMA, input and the master-cycle scheduler that ties the
// CPU, video and audio together (docs/spec-notes.md §1-§9).
//
// Time is an integer count of master cycles since power-on. Every register
// access of an instruction happens at that instruction's start time.
import { REGISTERS } from "../hw/registers.ts";
import { createVideoState, renderLine, type VideoState } from "./video/render.ts";
import type { AudioCore, Bus, CpuCore } from "./types.ts";
import { Cue } from "./audio.ts";
import { MASTER_PER_CPU, MASTER_PER_FRAME, MASTER_PER_LINE } from "./types.ts";
import { decodeState, encodeState, romSha256, SaveStateError, type LoadStateOptions } from "./savestate.ts";
import { toHex } from "./sha256.ts";

export type MachineOptions = { cpu: CpuCore; audio?: AudioCore };

/** Read-only debugger view of the register block and latches (Machine.inspect). */
export type MachineInspection = {
  regs: Record<string, number>;   // stored value of every storage register, by name (a copy)
  IF: number; IE: number;
  bank: number;                   // bank shown in 4000-7FFF: BANK mod bank count
  line: number;                   // beam line now (what VCOUNT reads)
  vstat: number; probe: number;   // what VSTAT / PROBE would read, without clearing anything
  prescale: number;               // timer prescaler count
  pads: [number, number];         // PAD1, PAD2 as latched at the last VBLANK
};

/** Writable bits of each storage register (undefined bits read 0). */
const MASK: Record<string, number> = {
  BANK: 0xff, RAMCTL: 1,
  VADDR: 0x7fff, VINC: 0xff, VCTRL: 0x1f, LINECMP: 0x1ff, BG0SCX: 0x1ff, BG0SCY: 0xff, BG1SCX: 0x1ff, BG1SCY: 0xff,
  BG0MAP: 0xf, BG1MAP: 0xf, OAMADDR: 0x1fe, CRAMADDR: 0x1ff, AMBIENT: 7, FIXED: 7, PROBEX: 0xff, PROBEY: 0x1ff,
  TRELOAD: 0xffff, TCOUNT: 0xffff, TCTRL: 7, IE: 7,
  DMASRC: 0xfffe, DMADST: 0xffff, DMALEN: 0xffff,
};
for (let i = 0; i < 4; i++) Object.assign(MASK, { [`L${i}X`]: 0x3ff, [`L${i}Y`]: 0x3ff, [`L${i}I`]: 0xf, [`L${i}F`]: 0x37 });
const RESET: Record<string, number> = { BANK: 1, VINC: 2, LINECMP: 511, BG0MAP: 12, BG1MAP: 14, FIXED: 7 };
const READ_ONLY = new Set(["VSTAT", "VCOUNT", "PROBE", "PAD1", "PAD2"]);
const COMMAND = new Set(["DMACTL", "IF", "V0CTRL", "V1CTRL", "V2CTRL", "V3CTRL"]);
const PORTS = new Set(["VDATA", "OAMDATA", "CRAMDATA"]);
const IO_NAME = new Map<number, string>(REGISTERS.map(r => [r.addr, r.name]));
const VIDEO_REG = new Set(REGISTERS.filter(r => r.chip === "video").map(r => r.name));

const fnv = (h: number, bytes: Uint8Array) => { for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0; return h; };

export class Machine {
  readonly cpu: CpuCore;
  readonly audio: AudioCore;
  readonly rom: Uint8Array;
  readonly banks: number;
  readonly hasCartRam: boolean;
  readonly running: boolean;          // false when the lockout rejects the cartridge
  video: VideoState = createVideoState();
  wram = new Uint8Array(16384);
  cartRam = new Uint8Array(8192);
  framebuffer = new Uint32Array(256 * 224);
  masterCycle = 0;
  frame = 0;
  // system registers
  private r: Record<string, number> = {};
  private IF = 0;
  private overflow = 0;
  private probeReady = 0;
  private probeValue = 0;
  private pendingProbe = -1;
  private pad = [0, 0];
  private padInput = [0, 0];
  private prescale = 0;
  private extra = 0;
  private now = 0;                    // start time of the current instruction
  private nextEvent = 0;             // event e: line e >> 1; even e = dot 0, odd e = dot 256
  readonly bus: Bus;

  constructor(rom: Uint8Array, o: MachineOptions) {
    this.rom = rom;
    this.banks = Math.max(1, rom.length >> 14);
    this.hasCartRam = rom[0x16] === 1;
    this.running = rom[0x10] === 0x43 && rom[0x11] === 0x59 && rom[0x12] === 0x43 && rom[0x13] === 0x4c;
    this.cpu = o.cpu;
    this.audio = o.audio ?? new Cue();
    this.bus = this.makeBus();
    this.reset();
  }

  reset() {
    for (const [name, m] of Object.entries(MASK)) this.r[name] = (RESET[name] ?? 0) & m;
    for (const name of VIDEO_REG) if (name in this.r) this.video.regs[name] = this.r[name];
    this.IF = 0; this.overflow = 0; this.probeReady = 0; this.probeValue = 0; this.pendingProbe = -1;
    this.pad = [0, 0]; this.prescale = 0; this.extra = 0;
    this.audio.reset();
    if (this.running) this.cpu.reset(this.bus);
  }

  raiseInterrupt(bits: number) { this.IF |= bits & 7; }

  // ---------------------------------------------------------------- bus
  private makeBus(): Bus {
    const m = this;
    return {
      read8(a) { a &= 0xffff; return a >= 0xe000 ? (a & 1 ? m.ioRead(a & 0xfffe) >> 8 : m.ioRead(a) & 0xff) : m.memRead8(a); },
      read16(a) { a &= 0xfffe; return a >= 0xe000 ? m.ioRead(a) : m.memRead8(a) | (m.memRead8(a + 1) << 8); },
      write8(a, v) { a &= 0xffff; if (a >= 0xe000) m.ioWrite(a & 0xfffe, v & 0xff, (a & 1) as 0 | 1); else m.memWrite8(a, v & 0xff); },
      write16(a, v) { a &= 0xfffe; if (a >= 0xe000) m.ioWrite(a, v & 0xffff); else { m.memWrite8(a, v & 0xff); m.memWrite8(a + 1, (v >> 8) & 0xff); } },
      pendingInterrupts() { return m.IF & m.r.IE; },
      takeExtraCycles() { const e = m.extra; m.extra = 0; return e; },
    };
  }

  private memRead8(a: number): number {
    if (a < 0x4000) return this.rom[a] ?? 0xff;
    if (a < 0x8000) return this.rom[((this.r.BANK % this.banks) << 14) + (a - 0x4000)] ?? 0xff;
    if (a < 0xc000) return this.wram[a - 0x8000];
    if (a < 0xe000) return this.hasCartRam ? this.cartRam[a - 0xc000] : 0;
    return 0;
  }
  private memWrite8(a: number, v: number) {
    if (a >= 0x8000 && a < 0xc000) this.wram[a - 0x8000] = v;
    else if (a >= 0xc000 && a < 0xe000 && this.hasCartRam && this.r.RAMCTL & 1) this.cartRam[a - 0xc000] = v;
  }

  private line(t = this.now) { return Math.floor((t % MASTER_PER_FRAME) / MASTER_PER_LINE); }
  private activeDisplay(t = this.now) { const x = t % MASTER_PER_FRAME; return Math.floor(x / MASTER_PER_LINE) < 224 && (x % MASTER_PER_LINE) < 1024; }

  private ioRead(a: number): number {
    const name = IO_NAME.get(a);
    if (!name) return 0;
    if (a >= 0xf080 && a < 0xf0c0) return this.audio.read(a) & 0xffff;
    const v = this.video;
    switch (name) {
      case "VDATA": { this.portWait(); const ad = this.r.VADDR & 0x7ffe; const w = v.vram[ad] | (v.vram[ad + 1] << 8); this.r.VADDR = (this.r.VADDR + this.r.VINC) & 0x7fff; return w; }
      case "OAMDATA": { this.portWait(); const ad = this.r.OAMADDR & 0x1fe; const w = v.oam[ad] | (v.oam[ad + 1] << 8); this.r.OAMADDR = (ad + 2) & 0x1fe; return w; }
      case "CRAMDATA": { this.portWait(); const w = v.cram[this.r.CRAMADDR]; this.r.CRAMADDR = (this.r.CRAMADDR + 1) & 0x1ff; return w; }
      case "VSTAT": { const s = (this.line() >= 224 ? 1 : 0) | (this.overflow << 1) | (this.probeReady << 2); this.overflow = 0; return s; }
      case "VCOUNT": return this.line();
      case "PROBE": { const p = this.probeValue | (this.probeReady << 15); this.probeReady = 0; return p; }
      case "PAD1": return this.pad[0];
      case "PAD2": return this.pad[1];
      case "IF": return this.IF;
      case "DMACTL": return 0;
      default: return this.r[name] ?? 0;
    }
  }

  /** Word write (half undefined) or byte write to the low (0) / high (1) half. */
  private ioWrite(a: number, value: number, half?: 0 | 1) {
    const name = IO_NAME.get(a);
    if (!name || READ_ONLY.has(name)) return;
    if (name === "RAMCTL" && !this.hasCartRam) return;     // no RAM: register absent (§84)
    if (a >= 0xf080 && a < 0xf0c0) { this.audio.advanceTo(this.now); this.audio.write(a, value, half); return; }
    if (COMMAND.has(name)) {
      if (half === 1) return;
      const cmd = value & 0xff;
      if (name === "IF") this.IF &= ~cmd & 7;
      else if (name === "DMACTL") this.dma(cmd & 3);
      return;
    }
    if (PORTS.has(name)) { this.portWrite(name, value, half); return; }
    const old = this.r[name] ?? 0;
    const merged = half === undefined ? value : half ? (old & 0xff) | ((value & 0xff) << 8) : (old & 0xff00) | (value & 0xff);
    this.r[name] = merged & (MASK[name] ?? 0xffff);
    if (name === "TCTRL") this.prescale = 0;
    if (VIDEO_REG.has(name)) this.video.regs[name] = this.r[name];
  }

  private portWait() { if (this.activeDisplay()) this.extra += 2; }

  private portWrite(name: string, value: number, half?: 0 | 1) {
    this.portWait();
    const v = this.video;
    if (name === "VDATA") {
      const ad = this.r.VADDR & 0x7ffe;
      if (half === undefined) { v.vram[ad] = value & 0xff; v.vram[ad + 1] = (value >> 8) & 0xff; }
      else v.vram[ad | half] = value & 0xff;
      this.r.VADDR = (this.r.VADDR + this.r.VINC) & 0x7fff;
    } else if (name === "OAMDATA") {
      const ad = this.r.OAMADDR & 0x1fe;
      if (half === undefined) { v.oam[ad] = value & 0xff; v.oam[ad + 1] = (value >> 8) & 0xff; }
      else v.oam[ad | half] = value & 0xff;
      this.r.OAMADDR = (ad + 2) & 0x1fe;
    } else {
      const i = this.r.CRAMADDR, old = v.cram[i];
      v.cram[i] = (half === undefined ? value : half ? (old & 0xff) | ((value & 0xff) << 8) : (old & 0xff00) | (value & 0xff)) & 0xfff;
      this.r.CRAMADDR = (i + 1) & 0x1ff;
    }
  }

  private dma(target: number) {
    if (!target) return;                   // target 0: no transfer, no stall (spec-notes §83)
    let len = this.r.DMALEN;
    this.extra += 4 + (this.activeDisplay() ? 4 : 2) * len;
    const v = this.video;
    let src = this.r.DMASRC, dst = this.r.DMADST;
    while (len > 0) {
      const w = src < 0xe000 ? this.memRead8(src) | (this.memRead8(src + 1) << 8) : 0;
      if (target === 1) { v.vram[dst & 0x7ffe] = w & 0xff; v.vram[(dst & 0x7ffe) + 1] = w >> 8; dst = (dst + 2) & 0xffff; }
      else if (target === 2) { v.oam[dst & 0x1fe] = w & 0xff; v.oam[(dst & 0x1fe) + 1] = w >> 8; dst = (dst + 2) & 0xffff; }
      else { v.cram[dst & 0x1ff] = w & 0xfff; dst = (dst + 1) & 0xffff; }
      src = (src + 2) & 0xfffe; len--;
    }
    this.r.DMASRC = src; this.r.DMADST = dst; this.r.DMALEN = 0;
  }

  // ---------------------------------------------------------------- time
  private tickTimer(cycles: number) {
    if (!(this.r.TCTRL & 1)) return;
    const div = [1, 16, 64, 256][(this.r.TCTRL >> 1) & 3];
    this.prescale += cycles;
    while (this.prescale >= div) {
      this.prescale -= div;
      if (this.r.TCOUNT === 0) { this.r.TCOUNT = this.r.TRELOAD; this.IF |= 4; }
      else this.r.TCOUNT = (this.r.TCOUNT - 1) & 0xffff;
    }
  }

  /** Run every video event with time <= t. */
  private eventsUpTo(t: number) {
    for (;;) {
      const e = this.nextEvent, line = e >> 1, when = line * MASTER_PER_LINE + (e & 1 ? 1024 : 0);
      if (when > t) return;
      this.nextEvent++;
      if (e & 1) this.dot256(line); else this.dot0(line);
    }
  }

  private dot0(abs: number) {
    const y = abs % 262;
    if (y < 224) {
      const info = renderLine(this.video, y, this.framebuffer.subarray(y * 256, y * 256 + 256));
      if (info.overflow) this.overflow = 1;
      this.pendingProbe = info.probe ? info.probe.base | (info.probe.shade << 8) : -1;
    } else this.pendingProbe = -1;
    if (y === 224) { this.IF |= 1; this.pad[0] = this.padInput[0] & 0xff; this.pad[1] = this.padInput[1] & 0xff; }
  }

  private dot256(abs: number) {
    const y = abs % 262;
    if (y === this.r.LINECMP) this.IF |= 2;
    if (this.pendingProbe >= 0) { this.probeValue = this.pendingProbe; this.probeReady = 1; this.pendingProbe = -1; }
  }

  /** Idle CPU cycles until the first step boundary at or after the next video event or `limit`,
   *  and no later than the step on which the timer underflows (at least 1). */
  private idleCycles(limit: number): number {
    const e = this.nextEvent, when = (e >> 1) * MASTER_PER_LINE + (e & 1 ? 1024 : 0);
    let n = Math.ceil((Math.min(when, limit) - this.masterCycle) / MASTER_PER_CPU);
    if (this.r.TCTRL & 1) {
      const div = [1, 16, 64, 256][(this.r.TCTRL >> 1) & 3];
      n = Math.min(n, div - this.prescale + this.r.TCOUNT * div);
    }
    return n > 1 ? n : 1;
  }

  /** Run one frame: until the machine clock reaches the start of the next frame. */
  runFrame(pad1: number, pad2: number) {
    this.padInput = [pad1, pad2];
    const end = (this.frame + 1) * MASTER_PER_FRAME;
    while (this.masterCycle < end) this.step(end);
    this.audio.advanceTo(end);
    this.frame++;
  }

  /** Execute one CPU step (or idle to `limit` when the CPU is locked out). Returns CPU cycles. */
  step(limit = Infinity): number {
    this.eventsUpTo(this.masterCycle);
    if (!this.running) { const t = Math.min(limit, (Math.floor(this.masterCycle / MASTER_PER_LINE) + 1) * MASTER_PER_LINE); this.masterCycle = t; this.eventsUpTo(t); return 0; }
    this.audio.advanceTo(this.masterCycle);
    this.now = this.masterCycle;
    this.extra = 0;
    if (this.cpu.mode === "wait" && (this.IF & this.r.IE & 7) === 0) {
      // WAI with nothing pending: by the CpuCore contract each CPU step would be one idle cycle
      // that changes nothing, until the next video event (VBLANK, LINE), a timer underflow or
      // `limit`. Take those cycles in one step; time, the timer and events land exactly where
      // one-cycle steps would put them (tests/machine-speed.test.ts). Speed only.
      const cycles = this.idleCycles(limit);
      this.masterCycle += cycles * MASTER_PER_CPU;
      this.tickTimer(cycles);
      return cycles;
    }
    const cycles = this.cpu.step(this.bus) + this.bus.takeExtraCycles();
    this.masterCycle += Math.max(cycles, 0) * MASTER_PER_CPU;
    this.tickTimer(cycles);
    return cycles;
  }

  // ---------------------------------------------------------------- debugger views (read-only)
  /** Snapshot of the register block and latches for debuggers. Reading it has no side effects. */
  inspect(): MachineInspection {
    return {
      regs: { ...this.r }, IF: this.IF, IE: this.r.IE, bank: this.r.BANK % this.banks,
      line: this.line(this.masterCycle), vstat: this.vstatValue(this.masterCycle), probe: this.probeValue | (this.probeReady << 15),
      prescale: this.prescale, pads: [this.pad[0], this.pad[1]],
    };
  }

  /** The byte a CPU read of `a` would return now, with no side effects (ports do not advance, latches do not clear). */
  peek8(a: number): number {
    a &= 0xffff;
    return a >= 0xe000 ? (a & 1 ? this.ioPeek(a & 0xfffe) >> 8 : this.ioPeek(a) & 0xff) : this.memRead8(a);
  }

  /** The word a CPU read of `a & FFFE` would return now, with no side effects. */
  peek16(a: number): number {
    a &= 0xfffe;
    return a >= 0xe000 ? this.ioPeek(a) : this.memRead8(a) | (this.memRead8(a + 1) << 8);
  }

  private vstatValue(t: number) { return (this.line(t) >= 224 ? 1 : 0) | (this.overflow << 1) | (this.probeReady << 2); }

  private ioPeek(a: number): number {
    const name = IO_NAME.get(a);
    if (!name) return 0;
    if (a >= 0xf080 && a < 0xf0c0) return this.audio.read(a) & 0xffff;
    const v = this.video;
    switch (name) {
      case "VDATA": { const ad = this.r.VADDR & 0x7ffe; return v.vram[ad] | (v.vram[ad + 1] << 8); }
      case "OAMDATA": { const ad = this.r.OAMADDR & 0x1fe; return v.oam[ad] | (v.oam[ad + 1] << 8); }
      case "CRAMDATA": return v.cram[this.r.CRAMADDR];
      case "VSTAT": return this.vstatValue(this.masterCycle);
      case "VCOUNT": return this.line(this.masterCycle);
      case "PROBE": return this.probeValue | (this.probeReady << 15);
      case "PAD1": return this.pad[0];
      case "PAD2": return this.pad[1];
      case "IF": return this.IF;
      case "DMACTL": return 0;
      default: return this.r[name] ?? 0;
    }
  }

  // ---------------------------------------------------------------- state
  private scalars(): Uint32Array {
    const regNames = Object.keys(MASK).sort();
    return Uint32Array.from([
      this.masterCycle % 2 ** 32, Math.floor(this.masterCycle / 2 ** 32), this.frame, this.IF, this.overflow, this.probeReady, this.probeValue,
      this.pendingProbe & 0xffffffff, this.pad[0], this.pad[1], this.prescale, this.nextEvent, 0,
      ...regNames.map(n => this.r[n]),
    ]);
  }

  private stateParts(): Uint8Array[] {
    return [new Uint8Array(this.scalars().buffer), this.wram, this.cartRam, this.video.vram, this.video.oam, new Uint8Array(this.video.cram.buffer.slice(0)), this.cpu.serialize(), this.audio.serialize()];
  }

  /** SHA-256 of this machine's ROM (lower-case hex), as in roms/manifest.json. Computed once per ROM. */
  get romSha256(): string { return toHex(romSha256(this.rom)); }

  /** A v2 save state: it names this ROM by SHA-256 (src/machine/savestate.ts, docs/spec-notes.md "Save-state format"). */
  saveState(): Uint8Array { return encodeState(this.stateParts(), romSha256(this.rom)); }

  /** The same state in the v1 layout (no ROM identity): what hash() covers and v1 fixtures hold. */
  saveStateV1(): Uint8Array { return encodeState(this.stateParts(), null); }

  /**
   * Load a save state, or throw SaveStateError and change nothing. Everything is validated first:
   * header, version, ROM identity (a v1 state only with `allowUnverifiedV1`), part count and
   * lengths, register and palette ranges, and the CPU and audio parts (deserialized into fresh
   * instances); only then is the machine written.
   */
  loadState(b: Uint8Array, o: LoadStateOptions = {}) {
    const [sc, wram, cartRam, vram, oam, cramBytes, cpu, audio] = decodeState(b, { rom: romSha256(this.rom), lengths: this.stateParts().map(p => p.length) }, o);
    const s = new Uint32Array(sc.buffer), cram = new Uint16Array(cramBytes.buffer), names = Object.keys(MASK).sort();
    const bad = (what: string) => new SaveStateError("corrupt", `save state ${what} is out of range`);
    if (s[12] !== 0) throw bad("reserved word");
    names.forEach((name, i) => { if (s[13 + i] & ~MASK[name]) throw bad(`register ${name}`); });
    if (cram.some(v => v > 0xfff)) throw bad("palette RAM");
    for (const [dev, part, what] of [[this.cpu, cpu, "CPU"], [this.audio, audio, "audio"]] as const) {
      try { new (dev.constructor as new () => { deserialize(b: Uint8Array): void })().deserialize(part); }
      catch (e) { throw new SaveStateError("corrupt", `save state ${what} part: ${(e as Error).message}`); }
    }
    this.masterCycle = s[0] + s[1] * 2 ** 32; this.frame = s[2]; this.IF = s[3]; this.overflow = s[4]; this.probeReady = s[5]; this.probeValue = s[6];
    this.pendingProbe = s[7] | 0; this.pad = [s[8], s[9]]; this.prescale = s[10]; this.nextEvent = s[11];
    names.forEach((name, i) => { this.r[name] = s[13 + i]; if (VIDEO_REG.has(name)) this.video.regs[name] = s[13 + i]; });
    this.wram.set(wram); this.cartRam.set(cartRam); this.video.vram.set(vram); this.video.oam.set(oam);
    this.video.cram.set(cram);
    this.cpu.deserialize(cpu); this.audio.deserialize(audio);
  }

  /** FNV-1a hash of the complete machine state (the v1 layout, no ROM identity), as 8 hex digits. */
  hash(): string {
    return fnv(2166136261, this.saveStateV1()).toString(16).padStart(8, "0");
  }
}

