// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// tools/coverage.ts: node's built-in coverage (lcov reporter) summarised per area, compared with
// the documented initial thresholds. Report-only until the owner turns on --enforce.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLcov, summarise, renderMarkdown, coverageArgs, THRESHOLDS, areaOf } from "../tools/coverage.ts";

const LCOV = [
  "TN:", "SF:src\\machine\\cpu.ts", "FNF:10", "FNH:9", "BRF:20", "BRH:15", "LF:100", "LH:90", "end_of_record",
  "TN:", "SF:src/asm/assembler.ts", "FNF:4", "FNH:2", "BRF:0", "BRH:0", "LF:50", "LH:25", "end_of_record",
  "TN:", "SF:tools/verify.ts", "FNF:0", "FNH:0", "BRF:2", "BRH:1", "LF:10", "LH:10", "end_of_record",
].join("\n");

test("lcov: per-file totals with posix paths", () => {
  const files = parseLcov(LCOV);
  assert.deepEqual(files.map(f => f.file), ["src/machine/cpu.ts", "src/asm/assembler.ts", "tools/verify.ts"]);
  assert.deepEqual(files[0], { file: "src/machine/cpu.ts", lines: [90, 100], branches: [15, 20], functions: [9, 10] });
});

test("lcov: counts DA/BRDA/FNDA records when the summary lines are missing", () => {
  const files = parseLcov(["SF:src/x.ts", "FN:1,a", "FN:2,b", "FNDA:3,a", "FNDA:0,b", "DA:1,1", "DA:2,0", "BRDA:1,0,0,1", "BRDA:1,0,1,-", "end_of_record"].join("\n"));
  assert.deepEqual(files[0], { file: "src/x.ts", lines: [1, 2], branches: [1, 2], functions: [1, 2] });
});

test("areas: src/<module> and tools", () => {
  assert.equal(areaOf("src/machine/video/render.ts"), "src/machine");
  assert.equal(areaOf("src/asm/assembler.ts"), "src/asm");
  assert.equal(areaOf("tools/canon/check.ts"), "tools");
});

test("summary: percentages per area and in total, and threshold verdicts", () => {
  const s = summarise(parseLcov(LCOV), { lines: 80, branches: 60, functions: 70 });
  assert.deepEqual(s.total, { lines: 125 / 160 * 100, branches: 16 / 22 * 100, functions: 11 / 14 * 100 });
  assert.equal(s.areas["src/machine"].lines, 90);
  assert.equal(s.areas["src/asm"].branches, 100, "no branches counts as fully covered");
  assert.deepEqual(s.below, ["lines 78.1% < 80%"]);
  const md = renderMarkdown(s);
  assert.match(md, /\| total \| 78\.1% \| 72\.7% \| 78\.6% \|/);
  assert.match(md, /\| src\/machine \| 90\.0% \| 75\.0% \| 90\.0% \|/);
  assert.match(md, /report-only/);
});

test("coverage args: built-in coverage over src/ and tools/, lcov to a file, tests excluded", () => {
  const a = coverageArgs(".tmp/coverage");
  assert.ok(a.includes("--experimental-test-coverage"));
  assert.ok(a.includes("--test-coverage-include=src/**") && a.includes("--test-coverage-include=tools/**"));
  assert.ok(a.includes("--test-reporter=lcov") && a.includes("--test-reporter-destination=.tmp/coverage/lcov.info"));
  assert.ok(THRESHOLDS.lines > 0 && THRESHOLDS.lines <= 100);
});
