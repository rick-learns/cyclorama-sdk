// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// npm run budget [-- name... [--frames N] [--replays <dir>]]
// Resource budget report for each cartridge, measured by running the real ROM on the emulator. A
// name is a ROM of the project (roms/<name>/, conformance/<name>) or the path of a .asm or .scr
// program anywhere in the tree (reported under its file name):
//   cartridge  size, banks, CYCL header (0010-003F), the smallest board of manual ch. 4 it fits
//              (Standard 32-256 KiB from 1987-09-18, Deep 512 KiB-1 MiB from October 1990)
//   cpu        busy CPU cycles per frame against 59,736 (MASTER_PER_FRAME / MASTER_PER_CPU).
//              Busy = cycles of steps the CPU spends executing (including port waits and interrupt
//              entry); WAI idle cycles and DMA stalls are counted apart. Frames up to the first
//              WAI are start-up ("boot") and reported separately. After that, every displayed
//              frame must reach WAI again: one that never does has overrun its budget (a violation).
//              A frame that overruns with the display off throughout is a blanked load and is
//              only reported.
//   video      sprites on each visible line, evaluated at dot 0 from OAM and VCTRL with the rule
//              of manual 5.5 (hide bit, 0 <= y - Y < height, only while display and sprites are
//              on); lines with more than 16 are where the chip drops sprites and sets VSTAT bit 1.
//              Active lights per line (light field on, intensity != 0; latched at dot 0, 5.8/5.9).
//   audio      Cue voices keyed on / written (4 voices: 3 tone + 1 noise).
// Measurement is from outside the machine: Machine.step is wrapped on the instance and the CPU
// is a Tally that watches its own bus accesses; neither changes behaviour (the final state hash
// equals a plain run's). Input: the ROM's completion replay if one exists, otherwise no buttons.
// Completion replays: the same metered run also gives each replay's verdict (tools/replay.ts:
// ROM identity against the replay and the manifest, final state hash, win word), so a full
// check emulates every replay once; `--replays <dir>` reads replays from another folder.
// Writes build/budget/<name>.json; exits 1 if any ROM violates a limit or any replay fails.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";
import { LINES_PER_FRAME, MASTER_PER_CPU, MASTER_PER_FRAME, MASTER_PER_LINE, type Bus } from "../src/machine/types.ts";
import { buildOne, discoverRoms, loadScrim } from "./build-roms.ts";
import { judgeReplay, padsFromEntries, prepareReplay, REPLAY_DIR, replayFiles, runReplay, type ReplayFile, type ReplayResult } from "./replay.ts";
import { isCliEntry } from "./cli-entry.ts";

export const FRAME_CPU_CYCLES = MASTER_PER_FRAME / MASTER_PER_CPU;   // 59,736
const K = 1024, BANK = 16 * K;
export const LARGEST_RETAIL = 1024 * K;
const SPRITE_LIMIT = 16, LIGHT_LIMIT = 4, VOICES = 4;
const DMACTL = 0xf0e6, AUDIO_LO = 0xf080, WAVE_LO = 0xf0a0;   // voice registers F080-F09F
const DEEP_FROM = 0x19901001;                                      // BCD: change notice 2, October 1990

export type SizeClass = { board: "development" | "Standard" | "Deep"; bytes: number; banks: number; retail: boolean };
export type Stats = { max: number; mean: number; p95: number };

/** Smallest board (manual ch. 4) whose ROM holds `bytes`: retail sizes are powers of two from 32 KiB. */
export function sizeClass(bytes: number): SizeClass | null {
  if (bytes <= BANK) return { board: "development", bytes: BANK, banks: 1, retail: false };
  let size = 32 * K;
  while (size < bytes) size *= 2;
  if (size > LARGEST_RETAIL) return null;
  return { board: size <= 256 * K ? "Standard" : "Deep", bytes: size, banks: size / BANK, retail: true };
}

const bcd = (v: number) => v.toString(16).padStart(8, "0");

export function cartridgeReport(rom: Uint8Array) {
  const w = (a: number) => rom[a] | (rom[a + 1] << 8);
  const magic = String.fromCharCode(...rom.subarray(0x10, 0x14));
  const date = (w(0x32) | (w(0x34) << 16)) >>> 0, dateStr = bcd(date);
  let sum = 0;
  for (let a = 0; a + 1 < rom.length; a += 2) sum = (sum + (a === 0x38 ? 0 : w(a))) & 0xffff;
  const header = {
    magic, headerVersion: rom[0x14], sizeByte: rom[0x15], cartRam: rom[0x16], generation: rom[0x17],
    title: String.fromCharCode(...rom.subarray(0x18, 0x30)).trimEnd(),
    developer: "$" + w(0x30).toString(16).toUpperCase().padStart(4, "0"),
    releaseDate: `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`,
    version: `${(w(0x36) >> 8).toString(16)}.${(w(0x36) & 0xff).toString(16).padStart(2, "0")}`,
    checksum: w(0x38), checksumComputed: sum, checksumOk: w(0x38) === sum,
  };
  const banks = rom.length / BANK, cls = sizeClass(rom.length);
  const violations: string[] = [], notes: string[] = [];
  if (!Number.isInteger(banks) || banks < 1) violations.push(`cartridge: ${rom.length} bytes is not a whole number of 16 KiB banks`);
  if (!cls) violations.push(`cartridge: ${rom.length} bytes exceeds the largest board (Deep, 1 MiB)`);
  if (magic !== "CYCL") violations.push("cartridge: no CYCL header magic at 0010 (the console would lock it out)");
  else {
    if (!header.checksumOk) violations.push(`cartridge: header checksum $${header.checksum.toString(16)} != computed $${sum.toString(16)}`);
    if (Number.isInteger(banks) && header.sizeByte !== ((banks - 1) & 0xff)) violations.push(`cartridge: size byte 0015 = ${header.sizeByte}, image has ${banks} banks`);
    const deep = cls?.board === "Deep";
    if (cls && cls.retail && header.generation !== (deep ? 1 : 0)) violations.push(`cartridge: generation byte 0017 = ${header.generation} but the image needs a ${cls.board} board`);
    if (header.cartRam === 1 && !deep && header.generation !== 1) violations.push("cartridge: RAM is only offered on Deep boards (header 0016 = 1 on a Standard cartridge)");
    if ((deep || header.generation === 1) && date < DEEP_FROM) violations.push(`cartridge: Deep boards exist from October 1990, header date is ${header.releaseDate}`);
  }
  if (cls && !cls.retail) notes.push("16 KiB image: development and test boards only; retail cartridges are 32 KiB or larger");
  if (cls && cls.retail && cls.bytes !== rom.length) notes.push(`image is ${rom.length} bytes; ships on a ${cls.bytes / K} KiB ROM`);
  return { bytes: rom.length, banks, header, sizeClass: cls, fits: cls !== null, largestRetailBytes: LARGEST_RETAIL, violations, notes };
}

/** A Tally that reports its bus writes (audio registers, DMA starts) without changing them. */
class MeteredTally extends Tally {
  dmaStall = 0;                         // DMA stall cycles of the current step
  keyed = new Set<number>();
  written = new Set<number>();
  private pending = 0;
  private real: Bus | null = null;
  private view: Bus | null = null;

  private watch(bus: Bus): Bus {
    if (bus === this.real) return this.view!;
    const t = this;
    const onWrite = (a: number, v: number, byteHalf: -1 | 0 | 1, write: () => void) => {
      const reg = a & 0xfffe;
      if (reg === DMACTL) {                 // a DMA stall is the extra cycles this write alone adds
        t.pending += bus.takeExtraCycles();
        write();
        const stall = bus.takeExtraCycles();
        t.pending += stall; t.dmaStall += stall;
        return;
      }
      write();
      if (reg >= AUDIO_LO && reg < WAVE_LO) {
        const voice = (reg - AUDIO_LO) >> 3;
        t.written.add(voice);
        if ((reg & 7) === 6 && byteHalf !== 1 && v & 1) t.keyed.add(voice);
      }
    };
    this.real = bus;
    this.view = {
      read8: a => bus.read8(a), read16: a => bus.read16(a),
      write8: (a, v) => onWrite(a, v, (a & 1) as 0 | 1, () => bus.write8(a, v)),
      write16: (a, v) => onWrite(a, v, -1, () => bus.write16(a, v)),
      pendingInterrupts: () => bus.pendingInterrupts(),
      takeExtraCycles: () => { const e = t.pending + bus.takeExtraCycles(); t.pending = 0; return e; },
    };
    return this.view;
  }
  override reset(bus: Bus) { super.reset(this.watch(bus)); }
  override step(bus: Bus): number { this.pending = 0; return super.step(this.watch(bus)); }
}

/** Register names of light i: X, Y, I, F. */
const LIGHT_REGS = [0, 1, 2, 3].map(i => [`L${i}X`, `L${i}Y`, `L${i}I`, `L${i}F`]);
const sx = (v: number, bits: number) => (v & (1 << (bits - 1)) ? (v & ((1 << bits) - 1)) - (1 << bits) : v & ((1 << bits) - 1));
const stats = (xs: number[]): Stats => {
  if (!xs.length) return { max: 0, mean: 0, p95: 0 };
  const s = [...xs].sort((a, b) => a - b);
  return { max: s[s.length - 1], mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), p95: s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] };
};
const pct = (x: number) => Math.round(x / FRAME_CPU_CYCLES * 1000) / 10;

export type BudgetOptions = { frames: number; pads?: ((f: number) => [number, number]) | undefined; name?: string; input?: string };
export type BudgetReport = ReturnType<typeof budgetReport>;
export type BudgetMeter = ReturnType<typeof budgetMeter>;

/**
 * A metered power-on machine, driven one frame at a time. `frame(pad1, pad2)` is one runFrame with
 * the per-frame accounting; `report()` is the budget report of every frame so far. The next
 * frame's accounting starts as soon as a frame ends, so steps a harness takes between frames
 * (a test stepping on until the CPU is back in WAI, say) count toward the next frame exactly as
 * they would inside its runFrame: an interactive run metered this way reports what budgetReport
 * reports for the same input (tests/budget.test.ts).
 */
export function budgetMeter(rom: Uint8Array) {
  const cpu = new MeteredTally();
  const m = new Machine(rom, { cpu });
  // per-frame accumulators
  let busy = 0, waited = false, stopped = false, mainLoop = false;
  const busyFrames: number[] = [], bootBusy: number[] = [];
  let idle = 0, dma = 0, overrunFrames = 0, blankedOverrunFrames = 0, stopFrames = 0;
  // video
  let displayOn = false, nextLine = 0, maxSprites = 0, linesOver = 0, overflowFrames = 0, frameOverflow = false;
  let maxLights = 0, lightChangeFrames = 0, frameLightKeyed = false, frameLightChanged = false;
  const lightKey = new Int32Array(16).fill(-1);             // the last lit line's light key (see evalLine)

  const evalLine = (y: number) => {
    const v = m.video, r = v.regs, ctrl = r.VCTRL;
    if (!(ctrl & 1)) return;
    displayOn = true;
    if (ctrl & 8) {
      let n = 0;
      for (let i = 0; i < 64; i++) {
        const o = i * 8;
        if (v.oam[o + 6] & 2) continue;
        const d = y - sx(v.oam[o] | (v.oam[o + 1] << 8), 9);
        if (d >= 0 && d < (v.oam[o + 6] & 1 ? 16 : 8)) n++;
      }
      if (n > maxSprites) maxSprites = n;
      if (n > SPRITE_LIMIT) { linesOver++; frameOverflow = true; }
    }
    if (ctrl & 16) {
      // The line's light key: X, Y, I, F of each active light (intensity != 0), -1s for the others.
      let n = 0, changed = false;
      for (let i = 0; i < 4; i++) {
        const k = LIGHT_REGS[i], on = sx(r[k[2]], 4) !== 0;
        if (on) n++;
        for (let j = 0; j < 4; j++) { const val = on ? r[k[j]] : -1; if (val !== lightKey[i * 4 + j]) { changed = true; lightKey[i * 4 + j] = val; } }
      }
      if (n > maxLights) maxLights = n;
      if (frameLightKeyed && changed) frameLightChanged = true;
      frameLightKeyed = true;
    }
  };

  const step = m.step.bind(m);
  m.step = (limit = Infinity) => {
    // Lines whose dot 0 is due are drawn at the start of this step, from the state as it is now.
    while (nextLine * MASTER_PER_LINE <= m.masterCycle) { const y = nextLine % LINES_PER_FRAME; if (y < 224) evalLine(y); nextLine++; }
    const before = m.cpu.mode;
    cpu.dmaStall = 0;
    const cycles = step(limit);
    const after = m.cpu.mode;
    if (!m.running) return cycles;
    if (before === "stop") stopped = true;
    else if (before === "wait" && after === "wait") { idle += cycles; waited = true; }
    else {
      busy += cycles - cpu.dmaStall; dma += cpu.dmaStall;
      if (after === "wait") { waited = true; mainLoop = true; }
      if (after === "stop") stopped = true;
    }
    return cycles;
  };

  // Accounting of the frame to come starts where the last frame ended (see budgetMeter above).
  let frames = 0, wasStopped = false, wasMain = false;
  const startFrame = () => {
    busy = 0; waited = false; stopped = m.cpu.mode === "stop"; frameOverflow = false; frameLightChanged = false; frameLightKeyed = false; displayOn = false;
    wasStopped = stopped; wasMain = mainLoop;
  };
  startFrame();

  const frame = (a: number, b: number) => {
    m.runFrame(a, b);
    frames++;
    if (wasStopped) stopFrames++;
    else if (!wasMain) bootBusy.push(busy);                 // start-up, before the main loop's first WAI
    else {
      busyFrames.push(busy);
      if (!waited && !stopped) { if (displayOn) overrunFrames++; else blankedOverrunFrames++; }
    }
    if (frameOverflow) overflowFrames++;
    if (frameLightChanged) lightChangeFrames++;
    startFrame();
  };

  /** The budget report of every frame metered so far. */
  const report = (opts: { name?: string | undefined; input?: string } = {}) => {
    const cart = cartridgeReport(rom);
    const bs = stats(busyFrames), boot = stats(bootBusy);
    const violations = [...cart.violations];
    if (!m.running) violations.push("cpu: the console locked the cartridge out (no CYCL magic); nothing was measured");
    else {
      if (overrunFrames) violations.push(`cpu: ${overrunFrames} displayed frame(s) never reached WAI after the main loop started (game logic overran its frame)`);
      if (!mainLoop && m.cpu.mode !== "stop") violations.push("cpu: never reached WAI in the whole run: no idle time, so no measurable headroom");
    }
    if (maxSprites > SPRITE_LIMIT) violations.push(`video: up to ${maxSprites} sprites on a line (limit ${SPRITE_LIMIT}): sprites dropped on ${linesOver} line(s) in ${overflowFrames} frame(s)`);
    const audio = { method: "measured: CPU writes to the Cue registers", keyedVoices: [...cpu.keyed].sort(), writtenVoices: [...cpu.written].sort(), channelsUsed: cpu.keyed.size, channelLimit: VOICES };
    return {
      rom: opts.name ?? cart.header.title, frames, input: opts.input ?? "interactive",
      pass: violations.length === 0, violations, notes: cart.notes,
      cartridge: { bytes: cart.bytes, banks: cart.banks, header: cart.header, sizeClass: cart.sizeClass, fits: cart.fits, largestRetailBytes: cart.largestRetailBytes },
      cpu: {
        method: "measured: cycles of emulator steps by CPU mode; DMA stalls from the extra cycles of DMACTL writes",
        cyclesPerFrame: FRAME_CPU_CYCLES, mainLoopFrames: busyFrames.length, busy: bs,
        percentOfBudget: { max: pct(bs.max), mean: pct(bs.mean), p95: pct(bs.p95) },
        overrunFrames, blankedOverrunFrames,
        bootFrames: bootBusy.length, bootBusy: boot, stoppedFrames: stopFrames,
        idleCycles: idle, dmaStallCycles: dma, reachedMainLoop: mainLoop, stopped: m.cpu.mode === "stop",
      },
      video: {
        method: "measured: OAM and video registers at dot 0 of every visible line (manual 5.5, 5.8)",
        spriteLimitPerLine: SPRITE_LIMIT, maxSpritesOnLine: maxSprites, linesOverLimit: linesOver, overflowFrames,
        lightLimit: LIGHT_LIMIT, maxActiveLightsPerLine: maxLights, framesWithMidFrameLightChanges: lightChangeFrames,
      },
      audio,
      hash: m.hash(),
    };
  };
  return { m, frame, report };
}

/** Power on and meter `opts.frames` frames of input; the report and the machine as it ends. */
export function budgetRun(rom: Uint8Array, opts: BudgetOptions) {
  const meter = budgetMeter(rom);
  const pads = opts.pads ?? (() => [0, 0] as [number, number]);
  for (let f = 0; f < opts.frames; f++) { const [a, b] = pads(f); meter.frame(a, b); }
  return { report: meter.report({ name: opts.name, input: opts.input ?? (opts.pads ? "scripted" : "no buttons") }), machine: meter.m };
}

export function budgetReport(rom: Uint8Array, opts: BudgetOptions) {
  return budgetRun(rom, opts).report;
}

if (isCliEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const fi = args.indexOf("--frames");
  const framesArg = fi >= 0 ? Number(args.splice(fi, 2)[1]) : undefined;
  const di = args.indexOf("--replays");
  const replayDir = di >= 0 ? args.splice(di, 2)[1] : REPLAY_DIR;
  const all = discoverRoms();
  const names = args.length ? args : all.filter(s => !s.name.startsWith("conformance/")).map(s => s.name);
  let bad = 0, badReplays = 0;
  const judged = new Set<string>();
  const say = (v: ReplayResult, name = v.name) => {
    if (!v.pass) badReplays++;
    console.log(`${v.pass ? "PASS" : "FAIL"}  ${name.padEnd(24)} completion replay: hash=${v.hash || "-"}  ${v.detail}`);
  };
  for (const arg of names) {
    const path = /\.(asm|scr)$/.test(arg) && existsSync(arg) ? arg : undefined;
    const name = path ? basename(path).replace(/\.(asm|scr)$/, "") : arg;
    const src = path ? { name, file: path, lang: path.endsWith(".scr") ? "scrim" as const : "asm" as const } : all.find(s => s.name === name);
    if (!src) { console.log(`FAIL  ${name}: no such ROM (roms/<name>/, conformance/<name>, or a .asm/.scr path)`); bad++; continue; }
    if (src.lang === "scrim") await loadScrim();
    const replayFile = join(replayDir, `${name.replace(/\//g, "__")}.replay.json`);
    const replay = existsSync(replayFile) ? JSON.parse(readFileSync(replayFile, "utf8")) as ReplayFile : null;
    const frames = framesArg ?? replay?.frames ?? 600;
    // The completion replay's verdict (tools/replay.ts: ROM identity, final state hash, win word)
    // comes from this same metered run, which computes exactly what a plain run computes.
    const prep = replay && framesArg === undefined && replay.rom === name ? await prepareReplay(replayFile) : null;
    const run = budgetRun(prep?.ready ? prep.rom : buildOne(src), {
      frames, name, pads: replay ? padsFromEntries(replay.pads) : undefined,
      input: replay ? `completion replay ${replayFile.replace(/\\/g, "/")}` : "no buttons",
    });
    const r = run.report;
    const verdict = prep ? (prep.ready ? judgeReplay(prep, run.machine) : prep.result) : null;
    if (prep) judged.add(replayFile);
    const out = join("build/budget", `${name}.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(verdict ? { ...r, replay: { file: replayFile.replace(/\\/g, "/"), ...verdict } } : r, null, 2) + "\n");
    if (!r.pass) bad++;
    const c = r.cartridge;
    console.log(`${r.pass ? "OK  " : "FAIL"}  ${name.padEnd(24)} ${String(c.bytes / K).padStart(4)} KiB -> ${c.sizeClass ? `${c.sizeClass.board} ${c.sizeClass.bytes / K} KiB` : "no board"}` +
      `  cpu max ${r.cpu.percentOfBudget.max}% p95 ${r.cpu.percentOfBudget.p95}%  sprites/line ${r.video.maxSpritesOnLine}/16` +
      `  lights ${r.video.maxActiveLightsPerLine}/4  voices ${r.audio.channelsUsed}/4  (${frames} frames, ${r.input})`);
    for (const v of r.violations) console.log(`        ${v}`);
    if (verdict) say(verdict, name);
  }
  // Checking every ROM, or given --replays: every replay file in the folder is judged, as
  // tools/replay.ts would, including one whose ROM is gone or which is named after another ROM.
  const rest = (!args.length || di >= 0) && framesArg === undefined ? replayFiles(replayDir).filter(f => !judged.has(f)) : [];
  for (const f of rest) say(await runReplay(f));
  const replays = judged.size + rest.length;
  console.log(bad ? `\nbudget: ${bad} ROM(s) over budget` : `\nbudget: ${names.length} ROM(s) within budget; reports in build/budget/`);
  if (replays) console.log(badReplays ? `replay: ${badReplays} failing` : `replay: all ${replays} passing`);
  process.exit(bad || badReplays ? 1 : 0);
}
