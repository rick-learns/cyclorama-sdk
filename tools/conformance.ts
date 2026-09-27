// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// npm run conformance
// Conformance ROM runner. Each tests/conformance/*.asm is assembled with CYASM,
// run on the full machine until STOP (or a frame limit), and judged by machine
// state: the word at 8000 must be 600D (pass); otherwise it holds the number of
// the failing check. Runs twice to prove determinism (identical state hash).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assemble } from "../src/asm/assembler.ts";
import { sourceReader } from "./art.ts";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";
import { isCliEntry } from "./cli-entry.ts";

export type ConformanceResult = { name: string; pass: boolean; code: number; frames: number; hash: string; detail: string };
export const CONFORMANCE_DIR = "tests/conformance";
const PASS = 0x600d;

export function buildRom(file: string): Uint8Array {
  const r = assemble(file, sourceReader(p => (/[.](bin|chr|dat)$/.test(p) ? new Uint8Array(readFileSync(p)) : readFileSync(p, "utf8"))));
  if (r.errors.length) throw new Error(r.errors.map(e => `${e.file}:${e.line}: ${e.message}`).join("\n"));
  return r.rom;
}

export function runRom(rom: Uint8Array, maxFrames = 600, pads: (frame: number) => [number, number] = () => [0, 0]): { m: Machine; frames: number } {
  const m = new Machine(rom, { cpu: new Tally() });
  let frames = 0;
  while (frames < maxFrames && m.cpu.mode !== "stop") { const [a, b] = pads(frames); m.runFrame(a, b); frames++; }
  return { m, frames };
}

/**
 * Optional controller script declared in a ROM comment line: `; @pads 0:0 30:$08 60:$10` means
 * from frame N the controller-1 value is V until the next entry (0 before the first entry;
 * controller 2 is always 0). Values are decimal, $hex or 0xhex up to FFFF, passed through
 * unmasked (the machine keeps bits 7-0). Returns null when the source has no @pads line.
 */
export function padScript(source: string): ((frame: number) => [number, number]) | null {
  const PADS = /^\s*;\s*@pads\b/i;
  const lines = source.split(/\r?\n/).filter(l => PADS.test(l));
  if (lines.length === 0) return null;
  if (lines.length > 1) throw new Error("@pads: only one @pads line is allowed");
  const entries: [number, number][] = [];
  for (const tok of lines[0].replace(PADS, "").trim().split(/\s+/).filter(Boolean)) {
    const m = /^(\d+):(\$[0-9a-f]+|0x[0-9a-f]+|\d+)$/i.exec(tok);
    if (!m) throw new Error(`@pads: bad entry '${tok}' (expected frame:value)`);
    const frame = Number(m[1]), value = Number(m[2].replace(/^\$/, "0x"));
    if (value > 0xffff) throw new Error(`@pads: value ${m[2]} does not fit 16 bits`);
    if (entries.length && frame <= entries[entries.length - 1][0]) throw new Error(`@pads: frames must increase ('${tok}')`);
    entries.push([frame, value]);
  }
  if (entries.length === 0) throw new Error("@pads: no entries");
  return frame => {
    let v = 0;
    for (const [f, val] of entries) { if (f > frame) break; v = val; }
    return [v, 0];
  };
}

export function runConformance(file: string): ConformanceResult {
  const name = file.split(/[\/]/).pop()!.replace(/\.asm$/, "");
  const rom = buildRom(file);
  const pads = padScript(readFileSync(file, "utf8")) ?? undefined;
  const a = runRom(rom, 600, pads), b = runRom(rom, 600, pads);
  const code = a.m.bus.read16(0x8000);
  const stopped = a.m.cpu.mode === "stop";
  const same = a.m.hash() === b.m.hash();
  const pass = stopped && code === PASS && same;
  const detail = !stopped ? "did not reach STOP" : code !== PASS ? `failed check ${code}` : !same ? "non-deterministic" : "ok";
  return { name, pass, code, frames: a.frames, hash: a.m.hash(), detail };
}

export function conformanceFiles(dir = CONFORMANCE_DIR): string[] {
  return readdirSync(dir).filter(f => f.endsWith(".asm") && !f.startsWith("_")).sort().map(f => join(dir, f));
}

if (isCliEntry(import.meta.url)) {
  let bad = 0;
  for (const f of conformanceFiles()) {
    const r = runConformance(f);
    if (!r.pass) bad++;
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(28)} ${r.detail.padEnd(22)} frames=${r.frames} hash=${r.hash}`);
  }
  console.log(bad ? `\nconformance: ${bad} failing` : "\nconformance: all passing");
  process.exit(bad ? 1 : 0);
}
