// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// npm run scrim -- input.scr -o out.rom [--asm out.asm] [--report]
// Compiles a SCRIM program to CYASM and assembles it into a Cyclorama cartridge ROM image.
// Exits 1 (writing nothing) if there are errors, printed as file:line:col: error: message.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { compile } from "../src/scrim/compile.ts";

/** Write a file, creating its folder first (a fresh clone has no build/ or .tmp/). */
const write = (file: string, data: string | Uint8Array) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data); };

const USAGE = "usage: node tools/scrim.ts input.scr -o out.rom [--asm out.asm] [--report]";

type Options = { input: string; out: string; asm?: string; report: boolean };

function parseArgs(argv: string[]): Options {
  const opts: Partial<Options> = { report: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a file name`);
      return v;
    };
    if (a === "-o") opts.out = next();
    else if (a === "--asm") opts.asm = next();
    else if (a === "--report") opts.report = true;
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
    console.error(`scrim: ${(e as Error).message}\n${USAGE}`);
    return 1;
  }
  const result = compile(opts.input, (p) => readFileSync(p));
  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(`${e.file}:${e.line}:${e.col}: error: ${e.message}`);
    console.error(`scrim: ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}; no output written`);
    return 1;
  }
  write(opts.out, result.rom!);
  if (opts.asm !== undefined) write(opts.asm, result.asm);
  if (opts.report) {
    console.log("procedure                       bytes  cycles (one pass, static worst case)");
    for (const r of result.report ?? []) console.log(`${r.name.padEnd(30)} ${String(r.bytes).padStart(6)}  ${String(r.cycles).padStart(6)}`);
  }
  console.log(`scrim: ${opts.out} (${result.rom!.length / 16384} banks, ${result.rom!.length} bytes)`);
  return 0;
}

// process.exitCode rather than process.exit(): exiting right after writing to a pipe can abort Node on Windows.
process.exitCode = main();
