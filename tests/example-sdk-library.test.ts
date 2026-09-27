// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// docs/guide/sdk-library.md is measured, not written from the source: every routine of the SDK
// runtime (the ";@@" sections of src/scrim/runtime.inc, the entry labels of roms/lib/cuesound.inc
// and its README table) has a section; every cycle figure, formula and stack depth of the page
// equals what the emulator measures when a harness calls the routine; every register and flag the
// page says is preserved comes back unchanged for several input patterns; outputs (division,
// RANDOM, copies) are checked against models. The page's calling examples are the programs
// examples/sdk-library/runtime.scr and examples/sdk-library/driver.asm, which run here too.
//
// Harness: the routines are the ones linked into the compiled runtime.scr ROM (the compiler's own
// linkage). The test parks the machine, loads registers, SP, the return address and stacked
// arguments, sets PC to the routine and steps until it returns; cycles are the sum of the steps
// (DMA stalls and port waits included), from the routine's first instruction to the end of its
// RTS. Interrupts are off (IE = 0), so nothing else runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compile } from "../src/scrim/compile.ts";
import { assemble } from "../src/asm/assembler.ts";
import { sourceReader } from "../tools/art.ts";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";
import { MASTER_PER_CPU, MASTER_PER_FRAME } from "../src/machine/types.ts";

const PAGE_FILE = "docs/guide/sdk-library.md";
const RUNTIME_SCR = "examples/sdk-library/runtime.scr";
const DRIVER_ASM = "examples/sdk-library/driver.asm";
const read = sourceReader((p: string) => readFileSync(p, "utf8"));

type Rom = { rom: Uint8Array; sym: (n: string) => number };
function asRom(r: { errors: { file: string; line: number; message: string }[]; rom?: Uint8Array; symbols?: Map<string, number> }, what: string): Rom {
  if (r.errors.length || !r.rom || !r.symbols) throw new Error(`${what}: ` + r.errors.map(e => `${e.file}:${e.line}: ${e.message}`).join("\n"));
  const symbols = r.symbols;
  return { rom: r.rom, sym: n => { const v = symbols.get(n); if (v === undefined) throw new Error(`${what}: no symbol ${n}`); return v; } };
}
const RT = asRom(compile(RUNTIME_SCR, read), RUNTIME_SCR);
const DRV = asRom(assemble(DRIVER_ASM, read), DRIVER_ASM);
const S = RT.sym;
const SND_RAM = S("SND_RAM");
const FRAME = MASTER_PER_FRAME / MASTER_PER_CPU;          // 59,736 CPU cycles
const LINE224 = 224 * 228;                                 // 51,072: the first cycle of line 224

// ------------------------------------------------------------------------------------ harness

const IE = 0xf0d8, SP0 = 0xbf00, RET = 0x3ffe;
const FLAG: Record<string, number> = { Z: 1, N: 2, C: 4, V: 8, I: 16 };
/** Register and flag patterns every direct-call case runs under (inputs override R0/R1). */
const PATTERNS: { regs: number[]; f: number }[] = [
  { regs: [0x1010, 0x2121, 0x3232, 0x4343, 0x5454, 0x6565, 0x7676, 0x8787], f: 0x00 },
  { regs: [0xffff, 0x0000, 0xaaaa, 0x5555, 0x8001, 0x7ffe, 0x0f0f, 0xf0f0], f: 0x1f },
  { regs: [0x0000, 0x0001, 0x0002, 0x0003, 0x0004, 0x0005, 0x0006, 0x0007], f: 0x0a },
];

const snapshot = (() => {
  const m = new Machine(RT.rom, { cpu: new Tally() });
  for (let i = 0; i < 3; i++) m.runFrame(0, 0);
  m.bus.write16(IE, 0);
  return m.saveState();
})();
/** The runtime.scr ROM three frames after power-on, interrupts disabled. */
function fresh(): Machine { const m = new Machine(RT.rom, { cpu: new Tally() }); m.loadState(snapshot); return m; }
const cpuOf = (m: Machine) => m.cpu as Tally;
const poke16 = (m: Machine, a: number, v: number) => { m.wram[a - 0x8000] = v & 255; m.wram[a - 0x7fff] = (v >> 8) & 255; };

/** Let the machine idle to CPU cycle `c` of the next frame (0 = the first cycle of line 0). */
function park(m: Machine, c: number) {
  const target = (Math.floor(m.masterCycle / MASTER_PER_FRAME) + 1) * MASTER_PER_FRAME + c * MASTER_PER_CPU;
  cpuOf(m).mode = "wait";
  while (m.masterCycle < target) m.step(target);
  assert.equal(m.masterCycle, target);
}

type Call = { cycles: number; stack: number; before: number[]; after: number[]; f0: number; f1: number; writes: number[]; end: number };
/** Call `entry` with registers, flags and stacked arguments; step until it returns. */
function call(m: Machine, entry: number, o: { regs?: number[]; args?: number[]; f?: number; lean?: boolean } = {}): Call {
  const cpu = cpuOf(m);
  const regs = o.regs ?? PATTERNS[0].regs, args = o.args ?? [];
  for (let i = 0; i < 8; i++) cpu.r[i] = regs[i] & 0xffff;
  cpu.sp = SP0; cpu.pc = entry; cpu.mode = "run"; cpu.f = o.f ?? 0; cpu.eiDelay = false;
  poke16(m, SP0, RET);
  args.forEach((v, i) => poke16(m, SP0 + 2 + 2 * i, v));
  const before = o.lean ? undefined : m.wram.slice(), r0 = [...cpu.r], f0 = cpu.f;
  let cycles = 0, minSp = SP0, steps = 0;
  while (!(cpu.pc === RET && cpu.sp === SP0 + 2)) {
    cycles += m.step();
    if (cpu.sp < minSp) minSp = cpu.sp;
    if (cpu.mode !== "run" || ++steps > 1e6) throw new Error(`call of ${entry.toString(16)} did not return`);
  }
  const writes: number[] = [];
  if (before) for (let i = 0; i < before.length; i++) {
    const a = 0x8000 + i;
    if (before[i] !== m.wram[i] && (a < minSp || a >= SP0 + 2 + 2 * args.length)) writes.push(a);
  }
  return { cycles, stack: SP0 + 2 - minSp, before: r0, after: [...cpu.r], f0, f1: cpu.f, writes, end: m.masterCycle / MASTER_PER_CPU };
}

/** A driver entry with R0 = value (assembly convention). */
const snd = (m: Machine, name: string, r0 = 0) => call(m, S(name), { regs: [r0, 1, 2, 3, 4, 5, 6, 7] });

// ------------------------------------------------------------------------------------ the page

const PAGE = readFileSync(PAGE_FILE, "utf8");
type Section = { name: string; text: string };
const SECTIONS: Section[] = (() => {
  const out: Section[] = [];
  const lines = PAGE.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = /^### (.+)$/.exec(lines[i]);
    if (!h) continue;
    let j = i + 1;
    while (j < lines.length && !/^#{2,3} /.test(lines[j])) j++;
    out.push({ name: h[1].replace(/`/g, "").trim(), text: lines.slice(i + 1, j).join("\n") });
  }
  return out;
})();
const section = (name: string) => {
  const s = SECTIONS.find(x => x.name === name);
  assert.ok(s, `${PAGE_FILE} has a section "### \`${name}\`"`);
  return s;
};
/** Rows of the first table in `text` whose header row is `header`. */
function table(text: string, header: string): string[][] {
  const lines = text.split("\n");
  const i = lines.findIndex(l => l.trim() === header);
  if (i < 0) return [];
  const rows: string[][] = [];
  for (let j = i + 2; j < lines.length && lines[j].startsWith("|"); j++) rows.push(lines[j].trim().slice(1, -1).split("|").map(c => c.trim()));
  return rows;
}
/** A cycles cell: `a + b × x + ...` (integers may have thousands commas). */
function evalCycles(cell: string, vars: Record<string, number>): number {
  let sum = 0;
  for (const term of cell.replace(/`/g, "").split(" + ")) {
    const t = /^([\d,]+)(?: × ([a-z]))?$/.exec(term.trim());
    assert.ok(t, `cannot read the cycles cell "${cell}"`);
    const k = Number(t[1].replace(/,/g, ""));
    if (t[2] === undefined) sum += k;
    else { assert.ok(t[2] in vars, `"${cell}": the harness has no value for ${t[2]}`); sum += k * vars[t[2]]; }
  }
  return sum;
}
/** Registers and flags named on a `**Label:**` line of a section. */
function named(text: string, label: string): Set<string> {
  const line = text.split("\n").find(l => l.startsWith(`- **${label}:**`));
  assert.ok(line !== undefined, `a "- **${label}:**" line`);
  const out = new Set<string>();
  for (const r of line.matchAll(/R(\d)(?:-R(\d))?/g)) for (let i = +r[1]; i <= +(r[2] ?? r[1]); i++) out.add(`R${i}`);
  const f = /flags? ((?:[ZNCVI] ?)+)/.exec(line);
  if (f) for (const x of f[1].trim().split(" ")) out.add(x);
  return out;
}
const stackOf = (text: string) => {
  const s = /^- \*\*Stack:\*\*\D*(\d+) bytes/m.exec(text);
  assert.ok(s, "a \"- **Stack:** n bytes\" line");
  return Number(s[1]);
};

// ------------------------------------------------------------------------------------ cases

type Sample = {
  vars?: Record<string, number>;
  setup?: (m: Machine) => void;
  regs?: Record<number, number>;
  args?: number[];
  ram?: [number, number][];                    // work RAM the call may write, [from, to)
  check?: (m: Machine, r: Call) => void;
};
type Measured = { cycles: number; stack: number };
type Case = { label: string; samples?: Sample[]; measure?: () => Measured[] };

const MEMDST = 0x9000, MEMSRC = 0x9100;
const fillSrc = (m: Machine) => { for (let i = 0; i < 512; i++) m.wram[MEMSRC - 0x8000 + i] = (i * 7 + 3) & 255; };
const popcount = (x: number) => { let n = 0; for (x &= 0xffff; x; x >>= 1) n += x & 1; return n; };
const s16 = (x: number) => (x << 16) >> 16;

const divu = (a: number, b: number): Sample => ({
  regs: { 0: a, 1: b }, vars: { b: popcount(b ? Math.floor(a / b) : 0) },
  check: (_m, r) => assert.deepEqual(r.after.slice(0, 2), b ? [Math.floor(a / b), a % b] : [0, a], `__divu ${a} / ${b}`),
});
const divs = (a: number, b: number): Sample => {
  const q = b ? (Math.trunc(a / b) & 0xffff) : 0, rem = b ? s16((a - s16(q) * b) & 0xffff) : a;
  return {
    regs: { 0: a & 0xffff, 1: b & 0xffff }, vars: { b: popcount(Math.abs(s16(q))) },
    check: (_m, r) => assert.deepEqual(r.after.slice(0, 2).map(s16), [s16(q), rem], `__divs ${a} / ${b}`),
  };
};
const memcpy = (dst: number, src: number, n: number, vars: Record<string, number>): Sample => ({
  setup: fillSrc, args: [dst, src, n], vars, ram: [[dst, dst + n]],
  check: m => { for (let i = 0; i < n; i++) assert.equal(m.wram[dst - 0x8000 + i], ((src - MEMSRC + i) * 7 + 3) & 255, `MEMCPY byte ${i} of ${n}`); },
});
const memset = (n: number): Sample => ({
  args: [MEMDST, 0x12a5, n], vars: { n }, ram: [[MEMDST, MEMDST + n]],
  setup: m => { m.wram[MEMDST - 0x8000 + n] = 0x5a; },
  check: m => {
    for (let i = 0; i < n; i++) assert.equal(m.wram[MEMDST - 0x8000 + i], 0xa5);
    assert.equal(m.wram[MEMDST - 0x8000 + n], 0x5a, "the byte after the block is untouched");
  },
});
const vramCopy = (c: number, w: number): Sample => ({
  setup: m => { fillSrc(m); park(m, c); }, args: [0x0400, MEMSRC, w], vars: { w },
  check: m => {
    for (let i = 0; i < 2 * w; i++) assert.equal(m.video.vram[0x0400 + i], (i * 7 + 3) & 255, `VRAM byte ${i}`);
    assert.equal(m.inspect().regs.VCTRL & 1, 0, "measured with the display off (the rate follows the beam alone)");
  },
});
const rnd = S("__rnd");
const random = (state: number): Sample => ({
  setup: m => poke16(m, rnd, state), ram: [[rnd, rnd + 2]],
  check: m => assert.equal(m.peek16(rnd), (state >> 1) ^ (state & 1 ? 0xb400 : 0)),
});
const seed = (v: number): Sample => ({ args: [v], ram: [[rnd, rnd + 2]], check: (m, r) => { assert.equal(m.peek16(rnd), v || 0xace1); assert.equal(r.after[0], v || 0xace1); } });
const waitVblank = (c: number, vars: Record<string, number> = {}): Sample => ({
  setup: m => park(m, c), vars,
  check: (m, r) => {
    const after = (r.end % FRAME) - LINE224;
    assert.ok(after >= 18 && after <= 31, `returned ${after} cycles after line 224 began`);
    assert.equal(m.peek16(0xf00a), 224);
    assert.equal(r.after[0], 224, "R0 = the VCOUNT it read");
  },
});
const k = (c: number) => Math.max(0, Math.ceil((51060 - c) / 14));

// Driver state set-ups (each starts from SND_INIT).
const RAM_SND: [number, number][] = [[SND_RAM, SND_RAM + 272]];
const FX = 0x9800;                            // an effect header built in RAM: voice 2, priority p
const fxHeader = (m: Machine, priority: number) => {
  const inst = m.peek16(S("SFX_blip") + 4);
  [2, priority, 1, 0, inst & 255, inst >> 8, 0x48, 0xff].forEach((b, i) => { m.wram[FX - 0x8000 + i] = b; });
};
const state = (...steps: [string, string?][]) => (m: Machine) => {
  snd(m, "SND_INIT");
  for (const [entry, arg] of steps) snd(m, entry, arg === undefined ? 0 : S(arg));
};
const tracks = (m: Machine) => [...Array(8).keys()].filter(t => m.peek16(SND_RAM + 16 + 32 * t) !== 0);

// The Sound Test measurement of roms/lib/README.md: the cartridge from frame 17, pads A, -, B, -,
// C, -, Left, - repeating, every SND_TICK metered (the method of tools/song-wav.ts tickCycles).
let soundTest: { max1200: number; max3600: number; stack: number } | undefined;
function soundTestTicks() {
  if (soundTest) return soundTest;
  const st = asRom(assemble("roms/sound-test/sound-test.asm", read), "sound-test");
  const m = new Machine(st.rom, { cpu: new Tally() });
  for (let f = 0; f < 17; f++) m.runFrame(0, 0);
  const entry = st.sym("SND_TICK"), proto = Machine.prototype.step;
  let inside = false, sp0 = 0, ret = 0, acc = 0, max = 0, minSp = 0, stack = 0;
  m.step = (limit?: number) => {
    const cpu = cpuOf(m);
    if (!inside && cpu.mode === "run" && cpu.pc === entry) { inside = true; sp0 = cpu.sp; ret = m.peek16(sp0); acc = 0; minSp = sp0; }
    const c = proto.call(m, limit);
    if (inside) {
      acc += c;
      if (cpu.sp < minSp) minSp = cpu.sp;
      if (cpu.pc === ret && cpu.sp === ((sp0 + 2) & 0xffff)) { inside = false; max = Math.max(max, acc); stack = Math.max(stack, sp0 + 2 - minSp); }
    }
    return c;
  };
  let max1200 = 0;
  for (let f = 0; f < 3600; f++) {
    m.runFrame([0x10, 0, 0x20, 0, 0x40, 0, 0x04, 0][f % 8], 0);
    if (f === 1199) max1200 = max;
  }
  soundTest = { max1200, max3600: max, stack };
  return soundTest;
}

const CASES: Record<string, Case[]> = {
  __divu: [
    { label: "divisor 0", samples: [divu(5, 0), divu(0, 0), divu(65535, 0)] },
    { label: "divisor 1-65,535 (b = the number of 1 bits in the quotient)", samples: [divu(1000, 7), divu(0, 5), divu(65535, 1), divu(65535, 3), divu(65535, 65535), divu(32768, 32769), divu(40000, 3), divu(12345, 0x8000)] },
  ],
  __divs: [
    { label: "divisor 0", samples: [divs(5, 0), divs(-5, 0), divs(-32768, 0)] },
    { label: "divisor not 0 (b = the number of 1 bits in the quotient's magnitude)", samples: [divs(-1000, 7), divs(1000, -7), divs(-1000, -7), divs(-32768, -1), divs(32767, 1), divs(-1, 1), divs(7, 1000), divs(-32768, 3)] },
  ],
  MEMCPY: [
    { label: "n = 0", samples: [memcpy(MEMDST, MEMSRC, 0, {}), memcpy(MEMDST + 1, MEMSRC, 0, {})] },
    { label: "dst, src and n even, n = 2 × w: word moves", samples: [1, 2, 5, 8, 64].map(w => memcpy(MEMDST, MEMSRC, 2 * w, { w })) },
    { label: "otherwise: byte moves", samples: [memcpy(MEMDST, MEMSRC, 1, { n: 1 }), memcpy(MEMDST, MEMSRC, 7, { n: 7 }), memcpy(MEMDST + 1, MEMSRC, 10, { n: 10 }), memcpy(MEMDST, MEMSRC + 1, 16, { n: 16 }), memcpy(MEMDST, MEMSRC, 33, { n: 33 })] },
  ],
  MEMSET: [
    { label: "n = 0", samples: [memset(0)] },
    { label: "n ≥ 1", samples: [1, 2, 5, 10, 100].map(memset) },
  ],
  VRAM_COPY: [
    { label: "DMACTL written outside active display", samples: [[230 * 228, 0], [230 * 228, 1], [230 * 228, 8], [230 * 228, 100], [10 * 228 + 139, 1], [10 * 228 + 139, 8]].map(([c, w]) => vramCopy(c, w)) },
    { label: "DMACTL written during active display", samples: [[10 * 228, 0], [10 * 228, 1], [10 * 228, 8], [10 * 228, 100], [10 * 228 + 138, 8], [0, 3]].map(([c, w]) => vramCopy(c, w)) },
  ],
  RANDOM: [
    { label: "state bit 0 = 0", samples: [random(0xace0), random(0x5670), random(2)] },
    { label: "state bit 0 = 1", samples: [random(0xace1), random(1987), random(0xffff)] },
  ],
  SEED_RANDOM: [
    { label: "seed not 0", samples: [seed(1987), seed(1), seed(0xffff)] },
    { label: "seed 0", samples: [seed(0)] },
  ],
  WAIT_VBLANK: [
    { label: "called at CPU cycle c of the frame, c < 51,072 (k = ⌈(51,060 − c) / 14⌉, at least 0)", samples: [0, 1, 100, 20000, 51046, 51047, 51060, 51061, 51071].map(c => waitVblank(c, { k: k(c) })) },
    { label: "called at the first cycle of line 224 (c = 51,072)", samples: [waitVblank(51072)] },
    { label: "called at the last cycle of the frame (c = 59,735)", samples: [waitVblank(59735)] },
  ],
  SND_INIT: [
    { label: "any state", samples: [{ setup: state() }, { setup: state(["SND_PLAY_SONG", "SONG_tune"], ["SND_SFX", "SFX_blip"]) }] },
  ],
  SND_PLAY_SONG: [
    {
      label: "v = voices the song uses, t = 1 if it has a wavetable, a and m as for SND_STOP", samples: [
        { setup: state(), regs: { 0: S("SONG_tune") }, vars: { v: 4, t: 1, a: 0, m: 0 } },
        { setup: state(), regs: { 0: S("SONG_jingle") }, vars: { v: 1, t: 0, a: 0, m: 0 } },
        { setup: state(["SND_PLAY_SONG", "SONG_tune"]), regs: { 0: S("SONG_tune") }, vars: { v: 4, t: 1, a: 4, m: 0 } },
        { setup: state(["SND_PLAY_SONG", "SONG_tune"]), regs: { 0: S("SONG_jingle") }, vars: { v: 1, t: 0, a: 4, m: 0 } },
        { setup: state(["SND_PLAY_SONG", "SONG_jingle"]), regs: { 0: S("SONG_jingle") }, vars: { v: 1, t: 0, a: 1, m: 0 } },
        { setup: state(["SND_PLAY_SONG", "SONG_tune"], ["SND_SFX", "SFX_blip"]), regs: { 0: S("SONG_tune") }, vars: { v: 4, t: 1, a: 3, m: 1 } },
        { setup: state(["SND_PLAY_SONG", "SONG_tune"], ["SND_SFX", "SFX_blip"], ["SND_SFX", "SFX_thud"]), regs: { 0: S("SONG_jingle") }, vars: { v: 1, t: 0, a: 2, m: 2 } },
      ],
    },
  ],
  SND_STOP: [
    {
      label: "a = music tracks playing on a voice of their own, m = music tracks whose voice an effect has", samples: [
        { setup: state(), vars: { a: 0, m: 0 } },
        { setup: state(["SND_PLAY_SONG", "SONG_jingle"]), vars: { a: 1, m: 0 } },
        { setup: state(["SND_PLAY_SONG", "SONG_tune"]), vars: { a: 4, m: 0 } },
        { setup: state(["SND_PLAY_SONG", "SONG_tune"], ["SND_SFX", "SFX_blip"]), vars: { a: 3, m: 1 } },
        { setup: state(["SND_PLAY_SONG", "SONG_tune"], ["SND_SFX", "SFX_blip"], ["SND_SFX", "SFX_thud"]), vars: { a: 2, m: 2 } },
        { setup: state(["SND_SFX", "SFX_blip"]), vars: { a: 0, m: 0 } },
      ],
    },
  ],
  SND_SFX: [
    { label: "no effect on its voice", samples: [{ setup: state(), regs: { 0: S("SFX_blip") } }, { setup: state(["SND_PLAY_SONG", "SONG_tune"]), regs: { 0: S("SFX_thud") } }] },
    {
      label: "an effect of the same or lower priority on its voice: replaced", samples: [
        { setup: state(["SND_SFX", "SFX_blip"]), regs: { 0: S("SFX_blip") } },
        { setup: m => { state(["SND_SFX", "SFX_blip"])(m); fxHeader(m, 9); }, regs: { 0: FX } },
      ],
    },
    { label: "an effect of higher priority on its voice: ignored", samples: [{ setup: m => { state(["SND_SFX", "SFX_blip"])(m); fxHeader(m, 0); }, regs: { 0: FX }, check: m => assert.equal(m.peek8(SND_RAM + 16 + 32 * 6 + 23), 1, "the playing effect keeps its priority") }] },
  ],
  SND_TICK: [
    { label: "nothing playing", samples: [{ setup: state() }] },
    { label: "the first tick after SND_PLAY_SONG with SONG_tune: four notes key on", samples: [{ setup: state(["SND_PLAY_SONG", "SONG_tune"]) }] },
    { label: "the Sound Test measurement of the README: worst tick of the first 1,200 frames", measure: () => { const r = soundTestTicks(); return [{ cycles: r.max1200, stack: r.stack }]; } },
    {
      label: "the same input: worst tick of 3,600 frames", measure: () => {
        const r = soundTestTicks();
        assert.equal(r.stack, stackOf(section("SND_TICK").text), "the Sound Test run reaches the stack depth the page gives");
        return [{ cycles: r.max3600, stack: r.stack }];
      },
    },
  ],
  SND_TEMPO: [
    { label: "rate 0 (the song's own)", samples: [{ setup: state(), regs: { 0: 0 } }, { setup: state(["SND_PLAY_SONG", "SONG_tune"]), regs: { 0: 0 }, check: m => assert.equal(m.peek16(SND_RAM + 2), 9240) }] },
    { label: "rate 1-55,440", samples: [1, 100, 55440].map(r => ({ setup: state(), regs: { 0: r }, check: (m: Machine) => assert.equal(m.peek16(SND_RAM + 2), r) })) },
    { label: "rate above 55,440 (55,440 is used)", samples: [55441, 65535].map(r => ({ setup: state(), regs: { 0: r }, check: (m: Machine) => assert.equal(m.peek16(SND_RAM + 2), 55440) })) },
  ],
  SND_FADE: [
    { label: "n = 0 (cancel)", samples: [{ setup: state(), regs: { 0: 0 } }] },
    { label: "n = 1-255", samples: [1, 4, 255].map(n => ({ setup: state(), regs: { 0: n } })) },
    { label: "n above 255 (255 is used)", samples: [256, 65535].map(n => ({ setup: state(), regs: { 0: n }, check: (m: Machine) => assert.equal(m.peek8(SND_RAM + 11), 255) })) },
  ],
  SND_STATUS: [
    {
      label: "any state", samples: [
        { setup: state(), check: (_m, r) => assert.equal(r.after[0], 0) },
        { setup: state(["SND_PLAY_SONG", "SONG_tune"], ["SND_SFX", "SFX_blip"]), check: (_m, r) => assert.equal(r.after[0], 0x4f) },
        { setup: state(["SND_PLAY_SONG", "SONG_jingle"], ["SND_SFX", "SFX_thud"]), check: (_m, r) => assert.equal(r.after[0], 0x81) },
      ],
    },
  ],
};
/** Work RAM each routine may write (outside the stack), when a sample does not say. */
const DEFAULT_RAM: Record<string, [number, number][]> = {
  RANDOM: [[rnd, rnd + 2]], SEED_RANDOM: [[rnd, rnd + 2]],
  SND_TEMPO: [[SND_RAM + 2, SND_RAM + 4]],            // SND_RATE
  SND_FADE: [[SND_RAM + 10, SND_RAM + 13]],           // SND_MVOL, SND_FADE_N, SND_FADE_C
  SND_STATUS: [],
};

/** Run one sample under every pattern: cycles and stack of each run; registers, flags and RAM checked. */
function runSample(routine: string, s: Sample, preserved: Set<string>): Measured[] {
  const out: Measured[] = [];
  for (const [p, pat] of PATTERNS.entries()) {
    const m = fresh();
    s.setup?.(m);
    const regs = pat.regs.map((v, i) => s.regs?.[i] ?? v);
    const r = call(m, S(routine), { regs, args: s.args ?? [], f: pat.f });
    const at = `${routine} pattern ${p}`;
    for (let i = 0; i < 8; i++) if (preserved.has(`R${i}`)) assert.equal(r.after[i], r.before[i], `${at}: R${i} preserved`);
    for (const [f, bit] of Object.entries(FLAG)) if (preserved.has(f)) assert.equal(r.f1 & bit, r.f0 & bit, `${at}: flag ${f} preserved`);
    const ram = s.ram ?? DEFAULT_RAM[routine] ?? (routine.startsWith("SND_") ? RAM_SND : []);
    for (const a of r.writes) assert.ok(ram.some(([lo, hi]) => a >= lo && a < hi), `${at}: writes ${a.toString(16)}, outside the stack and the RAM the page names`);
    s.check?.(m, r);
    out.push({ cycles: r.cycles, stack: r.stack });
  }
  return out;
}

// ------------------------------------------------------------------------------------ tests

const RUNTIME_NAMES = [...readFileSync("src/scrim/runtime.inc", "utf8").matchAll(/^;@@\s+(\w+)/gm)].map(x => x[1]);
const DRIVER_SRC = readFileSync("roms/lib/cuesound.inc", "utf8");
const DRIVER_LABELS = [...DRIVER_SRC.matchAll(/^([A-Z][A-Z_]*|Snd[A-Za-z]+):/gm)].map(x => x[1]);
const README = readFileSync("roms/lib/README.md", "utf8");
const README_ENTRIES = [...README.matchAll(/^\| `(SND_[A-Z_]+)` \|/gm)].map(x => x[1]);
const WRAPPERS = DRIVER_LABELS.filter(n => n.startsWith("Snd"));
const ENTRIES = DRIVER_LABELS.filter(n => n.startsWith("SND_") && n !== "SND_FREQS");

test("the routines come from the sources: runtime.inc sections, the driver's labels and its README table", () => {
  assert.deepEqual(RUNTIME_NAMES, ["__divu", "__divs", "MEMCPY", "MEMSET", "VRAM_COPY", "RANDOM", "SEED_RANDOM", "WAIT_VBLANK"]);
  assert.deepEqual([...README_ENTRIES].sort(), [...ENTRIES].sort(), "the README table lists exactly the driver's entry labels");
  assert.deepEqual([...new Set([...README.matchAll(/`(Snd[A-Z]\w+)`/g)].map(x => x[1]))].sort(), [...WRAPPERS].sort(), "the README names every stack-convention entry");
  assert.equal(WRAPPERS.length, 8);
  assert.ok(DRIVER_LABELS.includes("SND_FREQS"));
});

test("every routine has a section in the page, with a measured case for every row", () => {
  for (const name of [...RUNTIME_NAMES, ...ENTRIES, "SND_FREQS"]) section(name);
  for (const name of [...RUNTIME_NAMES, ...ENTRIES]) {
    const rows = table(section(name).text, "| Case | Cycles |").map(r => r[0]);
    assert.deepEqual(rows, (CASES[name] ?? []).map(c => c.label), `${name}: the page's cases are the harness's cases, in order`);
  }
  const wrappers = table(section("Stack-convention entries").text, "| Entry | Jumps to | Extra cycles |").map(r => r[0].replace(/`/g, ""));
  assert.deepEqual(wrappers, WRAPPERS, "every stack-convention entry has a row");
});

for (const name of [...RUNTIME_NAMES, ...ENTRIES]) {
  test(`${name}: the page's cycles, stack depth and preserved registers are what the emulator measures`, () => {
    const sec = section(name);
    const preserved = named(sec.text, "Preserves"), changed = named(sec.text, "Changes");
    const all = ["R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "Z", "N", "C", "V", "I"];
    assert.deepEqual([...preserved, ...changed].sort(), [...all].sort(), `${name}: Preserves and Changes name every register and flag once`);
    const rows = new Map(table(sec.text, "| Case | Cycles |").map(r => [r[0], r[1]] as const));
    let deepest = 0;
    for (const c of CASES[name]) {
      const cell = rows.get(c.label);
      assert.ok(cell !== undefined, `${name}: row "${c.label}"`);
      const results = c.measure ? c.measure().map(r => ({ r, vars: {} })) : c.samples!.flatMap(s => runSample(name, s, preserved).map(r => ({ r, vars: s.vars ?? {} })));
      for (const { r, vars } of results) {
        assert.equal(r.cycles, evalCycles(cell, vars), `${name} "${c.label}" ${JSON.stringify(vars)}: page says ${cell}`);
        deepest = Math.max(deepest, r.stack);
      }
    }
    assert.equal(stackOf(sec.text), deepest, `${name}: the deepest stack use measured`);
  });
}

test("stack-convention entries: the argument from [SP+2], R1-R7 kept, the cost of the entry plus the stated extra", () => {
  const rows = table(section("Stack-convention entries").text, "| Entry | Jumps to | Extra cycles |");
  const sec = section("Stack-convention entries");
  const preserved = named(sec.text, "Preserves");
  assert.deepEqual([...preserved].filter(x => x.startsWith("R")).sort(), ["R1", "R2", "R3", "R4", "R5", "R6", "R7"]);
  for (const [w, to, extra] of rows.map(r => r.map(c => c.replace(/`/g, "")))) {
    const arg: Record<string, number> = { SND_PLAY_SONG: S("SONG_tune"), SND_SFX: S("SFX_blip"), SND_TEMPO: 20000, SND_FADE: 4 };
    for (const [p, pat] of PATTERNS.entries()) {
      const a = fresh(), b = fresh();
      state()(a); state()(b);
      const direct = call(a, S(to), { regs: [arg[to] ?? 0, ...pat.regs.slice(1)], f: pat.f });
      const viaStack = call(b, S(w), { regs: pat.regs, args: [arg[to] ?? 0], f: pat.f });
      assert.equal(viaStack.cycles, direct.cycles + Number(extra), `${w} pattern ${p}: ${to} + ${extra}`);
      assert.deepEqual(viaStack.after.slice(1), viaStack.before.slice(1), `${w}: R1-R7 kept`);
      if (to === "SND_STATUS") assert.equal(viaStack.after[0], direct.after[0], `${w}: the same result in R0`);
      const drv = (m: Machine) => Array.from(m.wram.subarray(SND_RAM - 0x8000, SND_RAM - 0x8000 + 272));
      assert.deepEqual(drv(b), drv(a), `${w}: the same effect on the driver as ${to}`);
      assert.equal(viaStack.stack, direct.stack, `${w}: no stack of its own`);
    }
  }
});

test("SND_FREQS: the page's size of the note table is the source's", () => {
  const body = DRIVER_SRC.slice(DRIVER_SRC.indexOf("SND_FREQS:"));
  const words = [...body.matchAll(/^\s+\.word\s+(.*?)\s*(?:;.*)?$/gm)].flatMap(x => x[1].split(","));
  assert.equal(words.length, 108);
  const m = fresh();
  assert.equal(m.peek16(S("SND_FREQS") + 2 * 57), 601, "A-4 (note 57) = 601");
  assert.match(section("SND_FREQS").text, /108 words \(216 bytes\)/);
});

test("division outputs: truncation, remainder sign, division by zero, -32768 / -1 (runtime.inc)", () => {
  const m = fresh();
  const du = (a: number, b: number) => call(m, S("__divu"), { regs: [a, b, 0, 0, 0, 0, 0, 0], lean: true }).after.slice(0, 2);
  const ds = (a: number, b: number) => call(m, S("__divs"), { regs: [a & 0xffff, b & 0xffff, 0, 0, 0, 0, 0, 0], lean: true }).after.slice(0, 2).map(s16);
  for (let i = 0; i < 400; i++) {
    const a = (i * 40503 + 17) & 0xffff, b = (i * 2654435761 >>> 20) & (i % 3 ? 0xff : 0xffff);
    assert.deepEqual(du(a, b), b ? [Math.floor(a / b), a % b] : [0, a], `${a} / ${b}`);
    const sa = s16(a), sb = s16(b);
    const q = sb ? s16(Math.trunc(sa / sb) & 0xffff) : 0;
    assert.deepEqual(ds(sa, sb), sb ? [q, s16((sa - q * sb) & 0xffff)] : [0, sa], `${sa} / ${sb}`);
  }
  assert.deepEqual(du(1234, 0), [0, 1234], "unsigned / 0: quotient 0, remainder = dividend");
  assert.deepEqual(ds(-1234, 0), [0, -1234], "signed / 0: quotient 0, remainder = dividend");
  assert.deepEqual(ds(-32768, -1), [-32768, 0], "-32768 / -1 wraps to -32768");
  assert.deepEqual(ds(-7, 2), [-3, -1], "toward zero; the remainder takes the dividend's sign");
  assert.deepEqual(ds(7, -2), [-3, 1]);
});

test("RANDOM: the Galois LFSR (taps B400) from a seed, deterministic, period 65,535; seed 0 becomes ACE1", () => {
  const m = fresh();
  call(m, S("SEED_RANDOM"), { args: [1987], lean: true });
  let s = 1987;
  for (let i = 0; i < 2000; i++) {
    s = (s >> 1) ^ (s & 1 ? 0xb400 : 0);
    assert.equal(call(m, S("RANDOM"), { lean: true }).after[0], s, `value ${i + 1} from seed 1987`);
  }
  // the whole period, from the model (the emulator matched it for 2,000 values above)
  let x = 1987, n = 0;
  do { x = (x >> 1) ^ (x & 1 ? 0xb400 : 0); n++; } while (x !== 1987);
  assert.equal(n, 65535);
  call(m, S("SEED_RANDOM"), { args: [0], lean: true });
  assert.equal(m.peek16(rnd), 0xace1);
  const again = fresh();
  call(again, S("SEED_RANDOM"), { args: [1987], lean: true });
  const a = [0, 1, 2].map(() => call(again, S("RANDOM"), { lean: true }).after[0]);
  const b = fresh();
  call(b, S("SEED_RANDOM"), { args: [1987], lean: true });
  assert.deepEqual([0, 1, 2].map(() => call(b, S("RANDOM"), { lean: true }).after[0]), a, "same seed, same sequence");
});

test("MEMCPY: overlapping blocks copy correctly when dst < src, on both paths", () => {
  for (const [dst, src, n] of [[MEMSRC - 2, MEMSRC, 40], [MEMSRC - 1, MEMSRC, 41]]) {
    const m = fresh();
    fillSrc(m);
    const want = Array.from(m.wram.subarray(src - 0x8000, src - 0x8000 + n));
    call(m, S("MEMCPY"), { args: [dst, src, n] });
    assert.deepEqual(Array.from(m.wram.subarray(dst - 0x8000, dst - 0x8000 + n)), want);
  }
});

test("WAIT_VBLANK returns 18 to 31 cycles after line 224 begins, from every phase of its loop", () => {
  const seen = new Set<number>();
  for (let c = 50990; c < 51072; c++) {
    const m = fresh();
    park(m, c);
    const r = call(m, S("WAIT_VBLANK"), { lean: true });
    seen.add((r.end % FRAME) - LINE224);
  }
  assert.equal(Math.min(...seen), 18);
  assert.equal(Math.max(...seen), 31);
  assert.match(PAGE, /18 to 31 cycles\s+after line 224 begins/);
});

test(`${RUNTIME_SCR} computes what its comments say and plays the song`, () => {
  const m = new Machine(RT.rom, { cpu: new Tally() });
  for (let f = 0; f < 3; f++) m.runFrame(0, 0);
  const w = (n: string, i = 0) => m.peek16(S(n) + 2 * i);
  assert.deepEqual([w("q"), w("r"), s16(w("sq")), s16(w("sr"))], [142, 6, -142, -6]);
  const source = [0x0123, 0x4567, 0x89ab, 0xcdef, 0x1111, 0x2222, 0x3333, 0x4444];
  assert.deepEqual([...Array(8).keys()].map(i => w("copy", i)), source, "MEMCPY copied 16 bytes");
  assert.deepEqual([...Array(6).keys()].map(i => m.peek8(S("fill") + i)), [0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0]);
  assert.deepEqual([...Array(8).keys()].map(i => m.video.vram[2 * i] | (m.video.vram[2 * i + 1] << 8)), source, "VRAM 0000-000F");
  let s = 1987;
  const want = [0, 1, 2].map(() => (s = (s >> 1) ^ (s & 1 ? 0xb400 : 0)));
  assert.deepEqual([0, 1, 2].map(i => w("rnd", i)), want, "RANDOM after SEED_RANDOM(1987)");
  const hex = (v: number) => v.toString(16).toUpperCase().padStart(4, "0");
  assert.ok(section("RANDOM").text.includes(want.map(hex).join(", ")), `the page gives the values ${want.map(hex).join(", ")}`);
  assert.equal(w("status"), 0x4f, "music on voices 0-3, an effect on voice 2");
  assert.ok(w("frames") >= 2, "onVblank runs every frame");
  assert.deepEqual(tracks(m).filter(t => t < 4), [0, 1, 2, 3], "the song plays on");
  assert.ok(m.peek16(SND_RAM + 8) > 0, "rows are playing");
});

test(`${DRIVER_ASM}: the song from power-on; A an effect, B the jingle, START a fade`, () => {
  const D = DRV.sym, ram = D("SND_RAM");
  const run = (press: number, frames: number) => {
    const m = new Machine(DRV.rom, { cpu: new Tally() });
    for (let f = 0; f < frames; f++) m.runFrame(f === 10 ? press : 0, 0);
    return m;
  };
  const active = (m: Machine) => [...Array(8).keys()].filter(t => m.peek16(ram + 16 + 32 * t) !== 0);
  const idle = run(0, 12);
  assert.deepEqual(active(idle), [0, 1, 2, 3]);
  assert.equal(idle.peek16(ram + 6), D("SONG_tune"));
  assert.deepEqual(active(run(0x10, 12)), [0, 1, 2, 3, 6], "A: an effect on voice 2 (track 6)");
  const b = run(0x20, 12);
  assert.equal(b.peek16(ram + 6), D("SONG_jingle"));
  assert.deepEqual(active(b), [0], "B: the jingle, on voice 0 alone");
  const fading = run(0x80, 30);
  assert.ok(fading.peek16(0xf0b0) < 15, "START: the master volume steps down");
  const faded = run(0x80, 10 + 4 * 15 + 5);
  assert.equal(faded.peek16(0xf0b0), 15, "faded out: full volume again");
  assert.deepEqual(active(faded), [], "and the music stopped");
});
