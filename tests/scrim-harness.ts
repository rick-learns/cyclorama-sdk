// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Shared helpers for the SCRIM compiler tests (not itself a test file).
// compile -> ROM -> run on the real machine until STOP -> inspect memory by symbol.
import { compile, type CompileResult } from "../src/scrim/compile.ts";
import { runRom } from "../tools/conformance.ts";
import type { Machine } from "../src/machine/machine.ts";

export type Files = Record<string, string | Uint8Array>;

export function compileSrc(src: string, files: Files = {}, main = "main.scr"): CompileResult {
  const all: Files = { [main]: src, ...files };
  return compile(main, (p) => {
    const v = all[p];
    if (v === undefined) throw new Error(`file not found: ${p}`);
    return v;
  });
}

export function build(src: string, files: Files = {}): CompileResult {
  const r = compileSrc(src, files);
  if (r.errors.length || !r.rom) {
    throw new Error(r.errors.map((e) => `${e.file}:${e.line}:${e.col}: ${e.message}`).join("\n") + "\n--- asm ---\n" + r.asm);
  }
  return r;
}

export type Run = {
  m: Machine;
  r: CompileResult;
  frames: number;
  stopped: boolean;
  addr(name: string): number;
  /** Unsigned word at symbol + 2*i. */
  w(name: string, i?: number): number;
  /** Signed word at symbol + 2*i. */
  s(name: string, i?: number): number;
  /** Byte at symbol + i. */
  b(name: string, i?: number): number;
  /** n unsigned words starting at symbol. */
  words(name: string, n: number): number[];
};

export function run(src: string, opts: { frames?: number; pads?: (f: number) => [number, number]; files?: Files } = {}): Run {
  const r = build(src, opts.files);
  const { m, frames } = runRom(r.rom!, opts.frames ?? 10, opts.pads);
  const addr = (name: string) => {
    const a = r.symbols?.get(name);
    if (a === undefined) throw new Error(`no symbol ${name}`);
    return a;
  };
  const w = (name: string, i = 0) => m.bus.read16(addr(name) + 2 * i);
  return {
    m, r, frames, stopped: m.cpu.mode === "stop", addr, w,
    s: (name, i = 0) => (w(name, i) << 16) >> 16,
    b: (name, i = 0) => m.bus.read8(addr(name) + i),
    words: (name, n) => Array.from({ length: n }, (_, i) => w(name, i)),
  };
}

export const u16 = (v: number) => ((v % 65536) + 65536) % 65536;
export const s16 = (v: number) => (u16(v) << 16) >> 16;
