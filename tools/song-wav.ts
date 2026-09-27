// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// node tools/song-wav.ts [cartridge.asm] [--song SONG_name] [--seconds N] [--out file.wav] [--skip-frame F]
// Renders a cartridge's music through the emulator into a 16-bit mono WAV at the Cue's own
// sample rate (47,940 Hz), starting at the first frame the Cue Sound Driver plays that song.
// Defaults: roms/sound-test/sound-test.asm, SONG_theme, 20 s, .tmp/sound-test.wav, no input.
// --skip-frame F presses START for one frame at frame F, for a cartridge that waits for START (a
// title screen, a start-up splash) before its music; without it the render simply waits for the song.
// Also exports tickCycles(): SND_TICK cycle measurement from outside the machine.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assemble } from "../src/asm/assembler.ts";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";
import { sourceReader } from "./art.ts";
import { SAMPLE_RATE } from "./song.ts";
import { isCliEntry } from "./cli-entry.ts";

export type TickStats = { max: number; mean: number; calls: number };
type Pads = (frame: number) => [number, number];

/**
 * Run `frames` frames and measure the CPU cycles of every call of the routine at `entry`
 * (from its first instruction to the return to its caller). Machine.step is wrapped on the
 * instance for the duration and restored; measuring does not change behaviour.
 */
export function tickCycles(m: Machine, entry: number, frames: number, before?: (f: number) => void, pads: Pads = () => [0, 0]): TickStats {
  const proto = Object.getPrototypeOf(m).step as Machine["step"];
  let inside = false, sp0 = 0, ret = 0, acc = 0, max = 0, sum = 0, calls = 0;
  m.step = (limit?: number) => {
    if (!inside && m.cpu.mode === "run" && m.cpu.pc === entry) { inside = true; sp0 = m.cpu.sp; ret = m.peek16(sp0); acc = 0; }
    const c = proto.call(m, limit);
    if (inside) {
      acc += c;
      if (m.cpu.pc === ret && m.cpu.sp === ((sp0 + 2) & 0xffff)) { inside = false; max = Math.max(max, acc); sum += acc; calls++; }
    }
    return c;
  };
  try {
    for (let f = 0; f < frames; f++) { before?.(f); const [a, b] = pads(f); m.runFrame(a, b); }
  } finally {
    delete (m as { step?: unknown }).step;
  }
  return { max, mean: calls ? sum / calls : 0, calls };
}

/** RIFF/WAVE bytes for signed 16-bit mono PCM. */
export function wavBytes(pcm: Int16Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length * 2), d = new DataView(out.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  str(0, "RIFF"); d.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, rate, true); d.setUint32(28, rate * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);
  str(36, "data"); d.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) d.setInt16(44 + 2 * i, pcm[i], true);
  return out;
}

/** Run a cartridge and return `seconds` of audio from the first frame it has played a row of `song`. */
export function renderSong(file: string, song: string, seconds: number, pads: Pads): { pcm: Int16Array; startFrame: number; tick: TickStats } {
  const r = assemble(file, sourceReader(p => (/[.](bin|chr|dat)$/.test(p) ? new Uint8Array(readFileSync(p)) : readFileSync(p, "utf8"))));
  if (r.errors.length) throw new Error(r.errors.map(e => `${e.file}:${e.line}: ${e.message}`).join("\n"));
  const ram = r.symbols.get("SND_RAM"), entry = r.symbols.get("SND_TICK"), header = r.symbols.get(song);
  if (ram === undefined || entry === undefined) throw new Error(`${file} does not include the Cue Sound Driver`);
  if (header === undefined) throw new Error(`${file} has no song ${song}`);
  const m = new Machine(r.rom, { cpu: new Tally() });
  let f = 0;
  // SND_SONG = the song's header and SND_ROWS > 0: its first row has played
  while (m.peek16(ram + 6) !== header || m.peek16(ram + 8) === 0) {
    if (f > 3000) throw new Error(`${song} did not start within 3000 frames`);
    const [a, b] = pads(f++); m.runFrame(a, b);
  }
  const startFrame = f;
  const want = Math.round(seconds * SAMPLE_RATE);
  m.audio.takeSamples();
  const tick = tickCycles(m, entry, Math.ceil(want / 800) + 1, undefined, k => pads(startFrame + k));
  const pcm = m.audio.takeSamples().slice(0, want);
  if (pcm.length < want) throw new Error("short render");
  return { pcm, startFrame, tick };
}

if (isCliEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const file = args.find(a => a.endsWith(".asm")) ?? "roms/sound-test/sound-test.asm";
  const seconds = Number(opt("--seconds", "20"));
  const out = opt("--out", ".tmp/sound-test.wav");
  const song = opt("--song", "SONG_theme");
  const skip = Number(opt("--skip-frame", "-1"));
  const { pcm, startFrame, tick } = renderSong(file, song, seconds, f => [f === skip ? 0x80 : 0, 0]);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, wavBytes(pcm, Math.round(SAMPLE_RATE)));
  let peak = 0; for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  console.log(`${out}: ${seconds} s from frame ${startFrame}, ${pcm.length} samples at ${Math.round(SAMPLE_RATE)} Hz, peak ${peak}; SND_TICK max ${tick.max} cycles (mean ${tick.mean.toFixed(0)}, ${tick.calls} ticks)`);
}
