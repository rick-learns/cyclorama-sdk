// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Every example program under examples/ (a .asm or .scr file directly in an example's folder, not
// starting with "_") builds with the SDK's own toolchain, twice to the same bytes, runs from
// power-on deterministically, stays within the machine's budgets, and has a test of its own that
// names it (what it draws, how it answers input). The docs quote these files (tools/doc-check.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { buildOne, sha256, type RomSource } from "../tools/build-roms.ts";
import { budgetReport } from "../tools/budget.ts";
import { runRom } from "../tools/conformance.ts";

export function examplePrograms(): RomSource[] {
  if (!existsSync("examples")) return [];
  const out: RomSource[] = [];
  for (const d of readdirSync("examples", { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort())
    for (const f of readdirSync(`examples/${d}`).sort()) {
      const m = /^([^_].*)\.(asm|scr)$/.exec(f);
      if (m) out.push({ name: `${d}/${m[1]}`, file: `examples/${d}/${f}`, lang: m[2] === "scr" ? "scrim" : "asm" });
    }
  return out;
}

const programs = examplePrograms();
const testSources = readdirSync("tests").filter(f => f.endsWith(".test.ts") && f !== "sdk-examples.test.ts").map(f => readFileSync(`tests/${f}`, "utf8"));

test("there are example programs", () => assert.ok(programs.length > 0, "examples/ holds at least one program"));

for (const p of programs) {
  test(`example ${p.name}: builds reproducibly, runs deterministically within budget, and has its own test`, () => {
    const a = buildOne(p), b = buildOne(p);
    assert.equal(sha256(a), sha256(b), "two builds, one ROM");
    const r1 = runRom(a, 120), r2 = runRom(b, 120);
    assert.equal(r1.m.hash(), r2.m.hash(), "same state after 120 frames");
    const report = budgetReport(a, { frames: 120 });
    assert.deepEqual(report.violations, [], "within the machine's budgets");
    assert.ok(testSources.some(s => s.includes(p.file)), `a test names ${p.file} and checks what it does`);
  });
}
