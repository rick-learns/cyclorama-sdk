// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// npm run coverage [-- --tier fast|node] [--enforce]
// Line/branch/function coverage from node's built-in test coverage (no dependencies): runs a test
// tier (default `node` = every test except the browser ones, whose code runs inside Chromium where
// node cannot see it) with --experimental-test-coverage and the lcov reporter, then writes
//   .tmp/coverage/lcov.info     (for any lcov viewer)
//   .tmp/coverage/summary.json  (total + per area)
//   .tmp/coverage/summary.md    (the table CI appends to the job summary)
// Thresholds (THRESHOLDS below) are REPORT-ONLY: a shortfall is printed, and fails the run
// only with --enforce. A failing test always fails the run. Coverage instrumentation slows the
// emulator several-fold, so this is a nightly job, not part of `npm run verify`.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { selectTier, testFiles, tierArgs, type Tier } from "./test-tier.ts";

/** Initial thresholds, a little under the first measurement (2026-09-26: lines 97.1-97.7 %,
 *  branches 92.2-92.3 %, functions 94.9-96.6 %), so a real drop shows up without flapping. */
export const THRESHOLDS = { lines: 95, branches: 90, functions: 93 };
export type Metric = keyof typeof THRESHOLDS;
export type FileCov = { file: string; lines: [number, number]; branches: [number, number]; functions: [number, number] };
export type Pct = Record<Metric, number>;
export type Summary = { total: Pct; areas: Record<string, Pct>; thresholds: Pct; below: string[]; files: number };

export function parseLcov(text: string): FileCov[] {
  const out: FileCov[] = [];
  let cur: FileCov | null = null;
  let seen = { LF: false, BRF: false, FNF: false };
  const da = [0, 0], br = [0, 0], fn = [0, 0];
  for (const raw of text.split(/\r?\n/)) {
    const i = raw.indexOf(":"), key = i < 0 ? raw : raw.slice(0, i), val = raw.slice(i + 1);
    if (key === "SF") {
      cur = { file: val.replace(/\\/g, "/"), lines: [0, 0], branches: [0, 0], functions: [0, 0] };
      seen = { LF: false, BRF: false, FNF: false }; da.fill(0); br.fill(0); fn.fill(0);
    } else if (!cur) continue;
    else if (key === "LF") { cur.lines[1] = +val; seen.LF = true; }
    else if (key === "LH") cur.lines[0] = +val;
    else if (key === "BRF") { cur.branches[1] = +val; seen.BRF = true; }
    else if (key === "BRH") cur.branches[0] = +val;
    else if (key === "FNF") { cur.functions[1] = +val; seen.FNF = true; }
    else if (key === "FNH") cur.functions[0] = +val;
    else if (key === "DA") { da[1]++; if (+val.split(",")[1] > 0) da[0]++; }
    else if (key === "BRDA") { br[1]++; const t = val.split(",")[3]; if (t !== "-" && +t > 0) br[0]++; }
    else if (key === "FNDA") { fn[1]++; if (+val.split(",")[0] > 0) fn[0]++; }
    else if (key === "end_of_record") {
      if (!seen.LF) cur.lines = [da[0], da[1]];
      if (!seen.BRF) cur.branches = [br[0], br[1]];
      if (!seen.FNF) cur.functions = [fn[0], fn[1]];
      out.push(cur); cur = null;
    }
  }
  return out;
}

export const areaOf = (file: string) => (file.startsWith("src/") ? file.split("/").slice(0, 2).join("/") : file.split("/")[0]);

const pct = ([hit, found]: [number, number]) => (found === 0 ? 100 : (hit / found) * 100);
function pctOf(files: FileCov[]): Pct {
  const sum = (k: "lines" | "branches" | "functions") => files.reduce<[number, number]>((a, f) => [a[0] + f[k][0], a[1] + f[k][1]], [0, 0]);
  return { lines: pct(sum("lines")), branches: pct(sum("branches")), functions: pct(sum("functions")) };
}
const fmt = (n: number) => `${n.toFixed(1)}%`;

export function summarise(files: FileCov[], thresholds: Pct = THRESHOLDS): Summary {
  const byArea = new Map<string, FileCov[]>();
  for (const f of files) byArea.set(areaOf(f.file), [...(byArea.get(areaOf(f.file)) ?? []), f]);
  const total = pctOf(files);
  const below = (Object.keys(thresholds) as Metric[]).filter(k => total[k] < thresholds[k]).map(k => `${k} ${fmt(total[k])} < ${thresholds[k]}%`);
  const areas = Object.fromEntries([...byArea.keys()].sort().map(a => [a, pctOf(byArea.get(a)!)]));
  return { total, areas, thresholds, below, files: files.length };
}

export function renderMarkdown(s: Summary): string {
  const row = (name: string, p: Pct) => `| ${name} | ${fmt(p.lines)} | ${fmt(p.branches)} | ${fmt(p.functions)} |`;
  return [
    "## Coverage (node built-in, report-only)", "",
    "| Area | Lines | Branches | Functions |", "|---|---|---|---|",
    row("total", s.total), ...Object.entries(s.areas).map(([a, p]) => row(a, p)), "",
    `Thresholds (report-only): lines ${s.thresholds.lines}%, branches ${s.thresholds.branches}%, functions ${s.thresholds.functions}%. ` +
      (s.below.length ? `**Below threshold:** ${s.below.join("; ")}.` : "All thresholds met."),
    `Files measured: ${s.files}. Browser-tier tests are not included (their code runs in Chromium).`, "",
  ].join("\n");
}

/** node --test flags for a coverage run writing lcov into `dir`. */
export function coverageArgs(dir: string): string[] {
  return [
    "--experimental-test-coverage", "--test-coverage-include=src/**", "--test-coverage-include=tools/**",
    "--test-reporter=spec", `--test-reporter-destination=${dir}/tests.log`,
    "--test-reporter=lcov", `--test-reporter-destination=${dir}/lcov.info`,
  ];
}

if (/(^|[\\/])coverage\.ts$/.test(process.argv[1] ?? "")) {
  const dir = ".tmp/coverage";
  const t = process.argv.indexOf("--tier");
  const tier = (t > 0 ? process.argv[t + 1] : "node") as Tier;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = selectTier(tier, testFiles());
  console.log(`coverage: running ${files.length} test files (tier ${tier}) with coverage; log in ${dir}/tests.log`);
  const r = spawnSync(process.execPath, tierArgs(files, coverageArgs(dir)), { stdio: "inherit" });
  const s = summarise(parseLcov(readFileSync(`${dir}/lcov.info`, "utf8")));
  const md = renderMarkdown(s);
  writeFileSync(`${dir}/summary.json`, JSON.stringify(s, null, 2) + "\n");
  writeFileSync(`${dir}/summary.md`, md);
  console.log("\n" + md);
  const testsFailed = r.status !== 0, enforce = process.argv.includes("--enforce");
  if (testsFailed) console.log(`coverage: FAIL, tests failed under coverage (exit ${r.status}); see ${dir}/tests.log`);
  if (s.below.length) console.log(`coverage: ${enforce ? "FAIL" : "WARN (report-only)"} below threshold: ${s.below.join("; ")}`);
  process.exitCode = testsFailed || (enforce && s.below.length) ? 1 : 0;
}
