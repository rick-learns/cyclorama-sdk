// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// The debugger example (examples/debug/trace.ts, docs/guide/debugger.md) runs and shows what the
// guide says: a breakpoint at the VBLANK handler, three steps, a watchpoint hit, sprite 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assemble } from "../src/asm/assembler.ts";
import { sourceReader } from "../tools/art.ts";

const hex4 = (v: number) => v.toString(16).toUpperCase().padStart(4, "0");

test("examples/debug/trace.ts: break at vblank, step PUSHM then the pad and position loads, watch LPAL, decode sprite 0", () => {
  const sym = assemble("examples/tutorial-1/step2.asm", sourceReader(p => readFileSync(p))).symbols;
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "examples/debug/trace.ts"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines[0], `break: breakpoint at ${hex4(sym.get("vblank")!)} (vblank), frame 0`);
  assert.match(lines[1], /SP BFFC /, "the interrupt entry pushed PC and F");
  assert.match(lines[2], new RegExp(`^step: ${hex4(sym.get("vblank")!)}  PUSHM R0-R3 .* SP BFF4 `), "PUSHM R0-R3: four words");
  assert.match(lines[3], /^step: [0-9A-F]{4}  LD R0, \[\$F0C0\] /, "PAD1");
  assert.match(lines[4], /^step: [0-9A-F]{4}  LD R1, \[\$8000\] +-> R0-R7 0000 0078 /, "LX = 120");
  assert.match(lines[5], new RegExp(`^watch: LPAL \\(${hex4(sym.get("LPAL")!)}\\) <- 0001 by the instruction at [0-9A-F]{4}, frame 4$`));
  assert.equal(lines[6], "sprite 0: x 120 y 104 tile 1 palette 1 size 16");
});
