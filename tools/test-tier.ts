// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// npm run test:fast | test:browser — run one tier of tests/**/*.test.ts (docs/guide/testing.md "Tiers").
//   node tools/test-tier.ts <fast|slow|browser|node|all>[,<tier>...] [--list] [<node --test flags>] [-- <flags>]
// Concurrency: CYC_TEST_CONCURRENCY, else 4 in agent worktrees (concurrencyArgs). The full run and
// the browser tier take a machine-wide heavy-run slot first (package.json, tools/verify.ts →
// tools/slot.ts).
// A file's tier comes from what it does, so new tests are classified without editing a list:
//   browser  imports playwright (headless Chromium)
//   slow     Node-only, but opts out of the fast loop with a `// test-tier: slow` line (whole-game
//            playthroughs, long audio renders)
//   fast     everything else
// `node` = fast + slow (no browser), `all` = every file (what `npm test` and verify run).
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isCI } from "./slot.ts";

export const TIERS = ["fast", "slow", "browser", "node", "all"] as const;
export type Tier = (typeof TIERS)[number];
export type FileTier = "fast" | "slow" | "browser";

const PLAYWRIGHT_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']playwright["']/;
const SLOW_MARKER = /^\/\/\s*test-tier:\s*slow\b/m;

/** The tier of one test file, from its source text. */
export function classify(source: string): FileTier {
  if (PLAYWRIGHT_IMPORT.test(source)) return "browser";
  return SLOW_MARKER.test(source) ? "slow" : "fast";
}

/** Every test file under tests/, as sorted posix paths (the set `node --test "tests/**\/*.test.ts"` runs). */
export function testFiles(dir = "tests"): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map(f => `${dir}/${f.replace(/\\/g, "/")}`)
    .filter(f => f.endsWith(".test.ts"))
    .sort();
}

export function selectTier(tier: Tier, files: string[], read: (f: string) => string = f => readFileSync(f, "utf8")): string[] {
  if (!TIERS.includes(tier)) throw new Error(`unknown tier '${tier}' (use ${TIERS.join(", ")})`);
  if (tier === "all") return [...files];
  return files.filter(f => {
    const t = classify(read(f));
    return tier === "node" ? t !== "browser" : t === tier;
  });
}

/** A comma-separated list of tiers (`fast,browser`, what `verify --part` asks for): the union, in
 *  suite order, each file once. */
export function selectTiers(spec: string, files: string[], read: (f: string) => string = f => readFileSync(f, "utf8")): string[] {
  const tiers = spec.split(",");
  for (const t of tiers) if (!TIERS.includes(t as Tier)) throw new Error(`unknown tier '${t}' (use ${TIERS.join(", ")}, or several joined by commas)`);
  const cache = new Map<string, string>();
  const cached = (f: string) => { if (!cache.has(f)) cache.set(f, read(f)); return cache.get(f)!; };
  const chosen = new Set(tiers.flatMap(t => selectTier(t as Tier, files, cached)));
  return files.filter(f => chosen.has(f));
}

/** node arguments for running `files` under the built-in test runner. */
export function tierArgs(files: string[], extra: string[] = []): string[] {
  return ["--disable-warning=ExperimentalWarning", "--test", ...extra, ...files];
}

/** `<tier> [--list] [flags] [-- flags]`: any flag other than --list passes through to node --test,
 *  because `npm run test:fast -- --test-name-pattern=x` arrives here without the `--`. */
export function parseCli(argv: string[]): { tier: string | undefined; list: boolean; extra: string[] } {
  const dash = argv.indexOf("--");
  const own = dash < 0 ? argv : argv.slice(0, dash), after = dash < 0 ? [] : argv.slice(dash + 1);
  return {
    tier: own.find(a => !a.startsWith("--")),
    list: own.includes("--list"),
    extra: [...own.filter(a => a.startsWith("--") && a !== "--list"), ...after],
  };
}

/** `--test-concurrency` for this run (docs/guide/testing.md "Tiers"). CYC_TEST_CONCURRENCY=<n> sets it
 *  (`default` = Node's own, cores - 1); otherwise agent worktrees (.claude/worktrees/*) use 4 because
 *  several agents share one machine, and CI and the main checkout keep Node's default. */
export function concurrencyArgs(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string[] {
  const v = env.CYC_TEST_CONCURRENCY?.trim();
  if (v) {
    if (v === "default") return [];
    if (!/^[1-9]\d*$/.test(v)) throw new Error(`CYC_TEST_CONCURRENCY=${v}: use a whole number >= 1, or 'default'`);
    return [`--test-concurrency=${v}`];
  }
  if (isCI(env)) return [];
  return /[\\/]\.claude[\\/]worktrees[\\/]/.test(cwd + "/") ? ["--test-concurrency=4"] : [];
}

/** Hang protection: `--test-timeout`, so a hung emulator loop or browser wait fails and names its
 *  file instead of holding a heavy-run slot and a CI job, plus `--test-force-exit`, so the file's
 *  process then exits even while a timer, socket or browser keeps its event loop alive. Node 24
 *  bounds each TEST, not each file (Node 23 also bounded the file-level test), and without
 *  force-exit a timed-out test with a live interval kept its process running (measured
 *  2026-09-27: killed at 20 s without the flag, exit 1 in 1 s with it). 15 min must exceed the
 *  slowest single test (a whole-game completion test took 166 s in CI and over 180 s in a loaded run on the Mac,
 *  where a 180 s default killed four files). verify's step timeouts sit above it.
 *  CYC_TEST_TIMEOUT_MS=<ms> changes it; an explicit --test-timeout among the flags wins. */
export const DEFAULT_TEST_TIMEOUT_MS = 900_000;
export function timeoutArgs(extra: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const force = extra.includes("--test-force-exit") ? [] : ["--test-force-exit"];
  if (extra.some(a => a === "--test-timeout" || a.startsWith("--test-timeout="))) return force;
  const v = env.CYC_TEST_TIMEOUT_MS?.trim() || String(DEFAULT_TEST_TIMEOUT_MS);
  if (!/^[1-9]\d*$/.test(v)) throw new Error(`CYC_TEST_TIMEOUT_MS=${v}: use a whole number of milliseconds`);
  return [`--test-timeout=${v}`, ...force];
}

/** spec on stdout as usual, plus tools/test-tier-reporter.ts on stderr (warns about fast-tier files
 *  over 5 s). A caller that picks its own reporters gets exactly those. */
export function reporterArgs(extra: string[]): string[] {
  if (extra.some(a => a === "--test-reporter" || a.startsWith("--test-reporter="))) return [];
  return ["--test-reporter=spec", "--test-reporter-destination=stdout",
    `--test-reporter=${new URL("./test-tier-reporter.ts", import.meta.url).href}`, "--test-reporter-destination=stderr"];
}

/** CLI. Returns the exit code instead of calling process.exit: on Windows, exiting while a write to
 *  a pipe is still pending trips a libuv assertion (UV_HANDLE_CLOSING) and turns a clean run into a crash. */
function main(argv: string[]): number {
  const { tier, list, extra } = parseCli(argv);
  let files: string[];
  try {
    if (!tier) throw new Error("no tier given");
    files = selectTiers(tier, testFiles());
  } catch (e) {
    console.error(`test-tier: ${(e as Error).message}\nusage: node tools/test-tier.ts <${TIERS.join("|")}>[,<tier>...] [--list] [-- <node --test flags>]`);
    return 2;
  }
  if (list) { console.log(files.join("\n")); return 0; }
  if (files.length === 0) { console.error(`test-tier: no files in tier '${tier}'`); return 1; }
  let conc: string[], timeout: string[];
  try { conc = concurrencyArgs(); timeout = timeoutArgs(extra); } catch (e) { console.error(`test-tier: ${(e as Error).message}`); return 2; }
  console.log(`test-tier: ${tier} (${files.length} files${conc.length ? `, ${conc[0]}` : ""}${timeout.length ? `, ${timeout[0]}` : ""})`);
  // Ours first, so an explicit --test-concurrency among the extra flags wins (last one counts).
  return spawnSync(process.execPath, tierArgs(files, [...conc, ...timeout, ...reporterArgs(extra), ...extra]), { stdio: "inherit" }).status ?? 1;
}

if (/(^|[\\/])test-tier\.ts$/.test(process.argv[1] ?? "")) process.exitCode = main(process.argv.slice(2));
