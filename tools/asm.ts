// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// npm run asm -- input.asm -o out.rom [--sym out.sym] [--lst out.lst]
// Assembles a CYASM source into a Cyclorama cartridge ROM image. An `.include "x.art.inc"` or
// `"x.song.inc"` with no such file on disk is converted from x.art / x.song, as in the ROM build.
// Exits 1 (writing nothing) if there are errors.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assemble } from "../src/asm/assembler.ts";
import { sourceReader } from "./art.ts";

/** Write a file, creating its folder first (a fresh clone has no build/ or .tmp/). */
const write = (file: string, data: string | Uint8Array) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data); };

const USAGE = "usage: node tools/asm.ts input.asm -o out.rom [--sym out.sym] [--lst out.lst]";

type Options = { input: string; out: string; sym?: string; lst?: string };

function parseArgs(argv: string[]): Options {
  const opts: Partial<Options> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a file name`);
      return v;
    };
    if (a === "-o") opts.out = next();
    else if (a === "--sym") opts.sym = next();
    else if (a === "--lst") opts.lst = next();
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else if (opts.input === undefined) opts.input = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (opts.input === undefined || opts.out === undefined) throw new Error("input file and -o output are required");
  return opts as Options;
}

function main(): number {
  let opts: Options;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) {
    console.error(`asm: ${(e as Error).message}\n${USAGE}`);
    return 1;
  }

  const result = assemble(opts.input, sourceReader((p) => readFileSync(p)));
  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(`${e.file}:${e.line}: error: ${e.message}`);
    console.error(`asm: ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}; no output written`);
    return 1;
  }

  write(opts.out, result.rom);
  if (opts.sym !== undefined) {
    // A label as BB:HHHH (bank and address, manual ch. 8), a constant as its value HHHH.
    const hexN = (v: number, n: number) => (v & 0xffff).toString(16).toUpperCase().padStart(n, "0");
    const lines = [...result.symbols]
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name, v]) => { const bank = result.labelBanks.get(name); return `${bank === undefined ? "" : hexN(bank, 2) + ":"}${hexN(v, 4)} ${name}`; });
    write(opts.sym, lines.join("\n") + "\n");
  }
  if (opts.lst !== undefined) write(opts.lst, result.listing);
  console.log(`asm: ${opts.out} (${result.rom.length / 16384} banks, ${result.rom.length} bytes)`);
  return 0;
}

// process.exitCode rather than process.exit(): exiting immediately after
// writing to a pipe can abort Node on Windows.
process.exitCode = main();
