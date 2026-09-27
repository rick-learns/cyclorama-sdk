// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// npm run replay [-- --dir <folder>]
// Deterministic completion replays. replays/<name>.replay.json records controller input that
// wins a cartridge, played against the exact retail ROM:
//   { "rom": "<name in roms/manifest.json>", "romSha256": "<hex>",
//     "pads": [[frame, pad1, pad2], ...],  run-length: each value holds from its frame until the
//                                           next entry; both controllers read 0 before the first
//     "frames": N,
//     "expect": { "hash": "<Machine.hash() after N frames>",
//                 "win": { "addr": "$8xxx", "value": "$xxxx" }, "note": "<the ending, in words>" } }
// runReplay rebuilds the ROM from source, requires its SHA-256 to equal both romSha256 and the
// manifest entry, runs a power-on Machine for exactly N frames of that input and passes only if
// the final state hash matches and the work-RAM word at win.addr (a variable the game itself uses
// for its ending, never a debug flag) holds win.value. The replayer only feeds the controllers:
// it never writes machine state or the ROM.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildOne, discoverRoms, loadScrim, sha256, type RomSource } from "./build-roms.ts";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";

export type PadEntry = [frame: number, pad1: number, pad2: number];
export type ReplayFile = {
  rom: string; romSha256: string; pads: PadEntry[]; frames: number;
  expect: { hash: string; win: { addr: string; value: string }; note: string };
};
export type ReplayResult = { name: string; pass: boolean; hash: string; winValue: number; detail: string };
/** Where the ROM and its reference hash come from (tests substitute a fixture and its own manifest). */
export type ReplayOptions = { source?: RomSource; manifest?: string; dir?: string };

export const REPLAY_DIR = "replays";
const hex = (v: number) => "$" + v.toString(16).toUpperCase().padStart(4, "0");

/** Run-length controller input as a per-frame function. Throws on malformed entries.
 *  Lookups keep a cursor: a run of increasing frames costs O(1) each (amortised); a lookup
 *  before the previous one finds its entry by binary search. */
export function padsFromEntries(entries: PadEntry[]): (frame: number) => [number, number] {
  let last = -1;
  for (const e of entries) {
    if (!Array.isArray(e) || e.length !== 3 || !e.every(Number.isInteger)) throw new Error(`pads: bad entry ${JSON.stringify(e)}`);
    if (e[0] <= last) throw new Error(`pads: frames must increase (${e[0]} after ${last})`);
    if (e[1] < 0 || e[1] > 255 || e[2] < 0 || e[2] > 255) throw new Error(`pads: values must be 0-255 (${JSON.stringify(e)})`);
    last = e[0];
  }
  const n = entries.length;
  let i = -1, prev = -Infinity;           // entries[i] is in force at frame `prev` (-1: none yet)
  return frame => {
    if (frame < prev) {                   // backward: the last entry at or before `frame`
      let lo = -1, hi = n - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (entries[mid][0] <= frame) lo = mid; else hi = mid - 1; }
      i = lo;
    } else while (i + 1 < n && entries[i + 1][0] <= frame) i++;
    prev = frame;
    if (i < 0) return [0, 0];
    const e = entries[i];
    return [e[1], e[2]];
  };
}

/** A win address must be RAM the game owns: work RAM (8000-BFFF) or cartridge RAM (C000-DFFF). */
function parseWin(win: { addr: string | number; value: string | number }): { addr: number; value: number } {
  const num = (v: string | number) => (typeof v === "number" ? v : Number(String(v).replace(/^\$/, "0x")));
  const addr = num(win.addr), value = num(win.value);
  if (!Number.isInteger(addr) || addr < 0x8000 || addr > 0xdffe || addr & 1) throw new Error(`win.addr ${win.addr} must be an even RAM address 8000-DFFE`);
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error(`win.value ${win.value} must be 0000-FFFF`);
  return { addr, value };
}

/** Read a RAM word without touching the bus (no side effects). */
function ramWord(m: Machine, addr: number): number {
  const [mem, off] = addr < 0xc000 ? [m.wram, addr - 0x8000] : [m.cartRam, addr - 0xc000];
  return mem[off] | (mem[off + 1] << 8);
}

/** Power on a clean machine and play `frames` frames of input. */
export function play(rom: Uint8Array, pads: PadEntry[], frames: number): Machine {
  const input = padsFromEntries(pads);
  const m = new Machine(rom, { cpu: new Tally() });
  for (let f = 0; f < frames; f++) { const [a, b] = input(f); m.runFrame(a, b); }
  return m;
}

async function romFor(name: string, o: ReplayOptions): Promise<{ rom: Uint8Array; manifestSha?: string }> {
  const src = o.source ?? discoverRoms().find(s => s.name === name);
  if (!src) throw new Error(`no ROM source named '${name}'`);
  if (src.lang === "scrim") await loadScrim();
  const manifest = JSON.parse(readFileSync(o.manifest ?? "roms/manifest.json", "utf8"));
  return { rom: buildOne(src), manifestSha: manifest.roms?.[name]?.sha256 };
}

/** A replay whose file is well formed and whose rebuilt ROM is the exact ROM it was recorded on
 *  (replay sha = manifest sha = build), ready to be played. */
export type ReadyReplay = { ready: true; replay: ReplayFile; rom: Uint8Array; win: { addr: number; value: number } };

/** Every check of runReplay that comes before playing: the file, the ROM rebuild and both SHA-256s. */
export async function prepareReplay(file: string, o: ReplayOptions = {}): Promise<ReadyReplay | { ready: false; result: ReplayResult }> {
  const r = JSON.parse(readFileSync(file, "utf8")) as ReplayFile;
  const name = r.rom;
  const fail = (detail: string) => ({ ready: false as const, result: { name, pass: false, hash: "", winValue: -1, detail } });
  let built: Awaited<ReturnType<typeof romFor>>, win: { addr: number; value: number };
  try {
    if (!Number.isInteger(r.frames) || r.frames < 1) throw new Error(`frames must be a positive integer`);
    win = parseWin(r.expect.win);
    padsFromEntries(r.pads);
    built = await romFor(name, o);
  } catch (e) { return fail((e as Error).message); }
  const sha = sha256(built.rom);
  if (sha !== r.romSha256) return fail(`ROM sha256 ${sha.slice(0, 12)}… does not match the replay's ${String(r.romSha256).slice(0, 12)}…`);
  if (built.manifestSha === undefined) return fail(`'${name}' is not in the ROM manifest`);
  if (sha !== built.manifestSha) return fail(`ROM sha256 ${sha.slice(0, 12)}… does not match the manifest's ${built.manifestSha.slice(0, 12)}…`);
  return { ready: true, replay: r, rom: built.rom, win };
}

/** The verdict on a machine that has played exactly the replay's input from power-on for its
 *  frame count (play(), or the budget tool's metered run, which computes the same state). */
export function judgeReplay(p: ReadyReplay, m: Machine): ReplayResult {
  const { replay: r, win } = p;
  const hash = m.hash(), winValue = ramWord(m, win.addr);
  const problems = [];
  if (m.frame !== r.frames) problems.push(`played ${m.frame} frames, the replay has ${r.frames}`);
  if (winValue !== win.value) problems.push(`win: [${hex(win.addr)}] = ${hex(winValue)}, expected ${hex(win.value)}`);
  if (hash !== r.expect.hash) problems.push(`state hash ${hash}, expected ${r.expect.hash}`);
  return { name: r.rom, pass: problems.length === 0, hash, winValue, detail: problems.join("; ") || "ok" };
}

export async function runReplay(file: string, o: ReplayOptions = {}): Promise<ReplayResult> {
  const p = await prepareReplay(file, o);
  if (!p.ready) return p.result;
  return judgeReplay(p, play(p.rom, p.replay.pads, p.replay.frames));
}

/** Record a replay from a scripted input sequence; refuses input that does not reach the win. Returns the file written. */
export async function recordReplay(name: string, pads: PadEntry[], frames: number,
  win: { addr: string | number; value: string | number; note: string }, o: ReplayOptions = {}): Promise<string> {
  const w = parseWin(win);
  const { rom } = await romFor(name, o);
  const m = play(rom, pads, frames);
  const got = ramWord(m, w.addr);
  if (got !== w.value) throw new Error(`${name}: input does not reach the win state ([${hex(w.addr)}] = ${hex(got)} after ${frames} frames, expected ${hex(w.value)})`);
  const out: ReplayFile = {
    rom: name, romSha256: sha256(rom), pads, frames,
    expect: { hash: m.hash(), win: { addr: hex(w.addr), value: hex(w.value) }, note: win.note },
  };
  const dir = o.dir ?? REPLAY_DIR;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name.replace(/\//g, "__")}.replay.json`);
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  return file;
}

export function replayFiles(dir = REPLAY_DIR): string[] {
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".replay.json")).sort().map(f => join(dir, f)) : [];
}

// Exact file name: a mere endsWith("replay.ts") also matched importers such as slice-replay.ts.
if (/(^|[\\/])replay\.ts$/.test(process.argv[1] ?? "")) {
  const i = process.argv.indexOf("--dir");
  const files = replayFiles(i > 0 ? process.argv[i + 1] : REPLAY_DIR);
  if (files.length === 0) { console.log("replay: no replay files"); process.exit(0); }
  let bad = 0;
  for (const f of files) {
    const r = await runReplay(f);
    if (!r.pass) bad++;
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(24)} hash=${r.hash || "-"}  ${r.detail}`);
  }
  console.log(bad ? `\nreplay: ${bad} failing` : `\nreplay: all ${files.length} passing`);
  process.exit(bad ? 1 : 0);
}
