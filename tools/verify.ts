// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// npm run verify — every non-interactive acceptance check, from a clean checkout.
// Steps grow as milestones land; each is a separate process so failures are isolated.
//   node tools/verify.ts [--allow-dirty] [--part <static|emulation|browser>]... [--list]
// Every step belongs to exactly one part (tests/verify-parts.test.ts). No --part = all of them =
// the whole gate. CI may run the parts as separate jobs.
//   static     toolchain, typecheck, ROM build, conformance, canon, skills, SPDX headers, page builds, fast tests
//   emulation  whole-game runs: budgets with completion replays (one metered run each), the slow test tier
//   browser    the browser test tier (headless Chromium)
// The open SDK export carries this file too: in a tree with EXPORT.json at its root, the steps marked `monorepo` (canon, skills, SPDX map, museum, app, the export itself)
// are left out, so the exported tree's `npm run verify` is its own gate.
// Hang protection: every step has a timeout (about 2x the slowest run seen); a step that outlives
// it is killed with its whole process tree and reported as FAIL … (timed out after …).
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isCI, MAX_WAIT_MS } from "./slot.ts";

/** Lines worth showing from a failing step: failures and errors, never passing tests that merely mention errors. */
export function failureLines(out: string): string[] {
  return out.split("\n")
    .filter(l => /FAIL|fail|Error|error|✖|not ok/.test(l) && !/^\s*(✔|PASS\b|ok\b)/.test(l))
    .slice(0, 25);
}

export const PARTS = ["static", "emulation", "browser"] as const;
export type Part = (typeof PARTS)[number];
type TestTier = "fast" | "slow" | "browser";
/** One gate step. `tier` marks a test tier: the selected tiers run together as the last step.
 *  `timeoutMin` overrides the default step timeout (DEFAULT_STEP_MIN). `monorepo`: the step needs
 *  files the open SDK export does not carry. */
export type StepSpec = { label: string; part: Part; cmd?: string[]; tier?: TestTier; timeoutMin?: number; monorepo?: true };
/** Which tree this is: the monorepo, or the open SDK export (EXPORT.json at the root). */
export type Tree = "monorepo" | "open";
export const TREE: Tree = existsSync(new URL("../EXPORT.json", import.meta.url)) ? "open" : "monorepo";
/** [label, command, timeout in ms]. */
export type PlannedStep = [string, string[], number];

// Step timeouts, ~2x the slowest run seen (hosted CI runs 36276164951, 36276647768 and
// 36277772516, and the self-hosted Mac, 2026-09-26). A slotted test run outside CI also gets
// tools/slot.ts's longest wait for a slot (after which it runs without one). Inside a test run,
// test-tier's --test-timeout (15 min per test) plus --test-force-exit names a hung file when the step allows that long.
export const MIN = 60_000;
const DEFAULT_STEP_MIN = 5;
/** How long tools/slot.ts may wait for a heavy-run slot: nothing under CI (it runs at once). */
export function slotWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  return isCI(env) ? 0 : Number(env.CYC_SLOT_MAX_WAIT_MS ?? MAX_WAIT_MS);
}
export const SLOT_WAIT_MS = slotWaitMs();
/** Minutes per test tier: fast 33 s in CI; slow 310 s (~435 s on the slower runner); browser
 *  113 s (86 s of it the app test). Several tiers in one run: the sum, capped at ALL_TESTS_MIN
 *  (the full run's slowest seen, 803.5 s in run 36277772516, x2 rounded up). */
const TIER_MIN: Record<TestTier, number> = { fast: 10, slow: 20, browser: 10 };
const ALL_TESTS_MIN = 30;

const node = [process.execPath, "--disable-warning=ExperimentalWarning"];
// Resolved like any import (a git worktree finds the checkout's node_modules further up).
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
export const STEP_TABLE: StepSpec[] = [
  { part: "static", label: "doctor (toolchain, deps, browser, clean tree)" }, // command depends on the options: plan()
  { part: "static", label: "typecheck", cmd: [process.execPath, tsc, "-p", "tsconfig.json", "--noEmit"] },
  { part: "static", label: "rebuild all ROMs from source", cmd: [...node, "tools/build-roms.ts"] },
  // One metered run per replay file: the budget report plus the replay verdict (hash, win, frame
  // count), so tools/replay.ts is no longer a separate step (it stays for hand use). Never pass
  // --frames here: it skips replay judging. 15 min (loaded-Mac worst case was ~400 s before dedup).
  { part: "emulation", label: "cartridge resource budgets and completion replays (one metered run each)", cmd: [...node, "tools/budget.ts"], timeoutMin: 15 },
  { part: "static", label: "conformance ROMs (Node)", cmd: [...node, "tools/conformance.ts"] },
  { part: "static", label: "canon validation", cmd: [...node, "tools/canon-check.ts"], monorepo: true },
  { part: "static", label: "skills lint (frontmatter, names, size, links)", cmd: [...node, "tools/skills-lint.ts"], monorepo: true },
  { part: "static", label: "SPDX headers (each source file's licence tier, LICENSING.md)", cmd: [...node, "tools/spdx-lint.ts"], monorepo: true },
  { part: "static", label: "museum page build (single offline file)", cmd: [...node, "tools/build-museum.ts"], monorepo: true },
  { part: "static", label: "official app build (single offline file)", cmd: [...node, "tools/build-app.ts"], monorepo: true },
  // The open SDK export: write it to .tmp/, commit it as a fresh
  // one-commit repository and run its own verify there, inside this run's heavy-run slot. Its
  // static + emulation gate is in the static part, which CI never skips: the export depends on
  // nearly every open file, so no path is safe for it. Its browser tests (the same files as this
  // tree's browser tier) run in the browser part.
  { part: "static", label: "export: the open SDK tree's own verify (static + emulation)", monorepo: true, timeoutMin: 20,
    cmd: [...node, "tools/slot.ts", "2", "--", "node", "--disable-warning=ExperimentalWarning", "tools/export-open.ts", "--verify", ".tmp/open-sdk", "--part", "static", "--part", "emulation"] },
  { part: "browser", label: "export-browser: the open SDK tree's browser tests", monorepo: true, timeoutMin: 10,
    cmd: [...node, "tools/slot.ts", "2", "--", "node", "--disable-warning=ExperimentalWarning", "tools/export-open.ts", "--verify", ".tmp/open-sdk-browser", "--part", "browser"] },
  { part: "static", label: "fast test tier", tier: "fast" },
  { part: "emulation", label: "slow test tier", tier: "slow" },
  { part: "browser", label: "browser test tier", tier: "browser" },
];

/** The steps to run for `parts` (empty = all), in gate order. The selected test tiers share one
 *  `node --test` run (so files of different tiers overlap, as in `npm test`); with every tier it is
 *  exactly the historical `all tests` step. */
export function plan(parts: Part[], opts: { allowDirty: boolean; tree?: Tree }): PlannedStep[] {
  const want = new Set<Part>(parts.length ? parts : PARTS);
  const chosen = STEP_TABLE.filter(s => want.has(s.part) && !(s.monorepo && opts.tree === "open"));
  const out: PlannedStep[] = [];
  for (const s of chosen) {
    if (s.tier) continue;
    const ms = (s.timeoutMin ?? DEFAULT_STEP_MIN) * MIN;
    if (s.label.startsWith("doctor")) {
      // Nothing outside the browser part launches Chromium, so its CI jobs install none.
      out.push([s.label, [...node, "tools/doctor.ts", ...(opts.allowDirty ? ["--allow-dirty"] : []), ...(want.has("browser") ? [] : ["--no-browser"])], ms]);
    } else out.push([s.label, s.cmd!, ms + (s.cmd!.includes("tools/slot.ts") ? SLOT_WAIT_MS : 0)]);
  }
  const tiers = chosen.flatMap(s => (s.tier ? [s.tier] : []));
  const testMin = Math.min(ALL_TESTS_MIN, tiers.reduce((sum, t) => sum + TIER_MIN[t], 0));
  if (tiers.length === 3) {
    // Every tier, inside one of 2 machine-wide heavy-run slots (bypassed in CI, never waits forever);
    // test-tier adds --test-concurrency (CYC_TEST_CONCURRENCY, else 4 in agent worktrees).
    out.push(["all tests (unit, ROM manifest hashes, golden frames, browser, replays)",
      [...node, "tools/slot.ts", "2", "--", "node", "--disable-warning=ExperimentalWarning", "tools/test-tier.ts", "all"], testMin * MIN + SLOT_WAIT_MS]);
  } else if (tiers.length) {
    const run = ["node", "--disable-warning=ExperimentalWarning", "tools/test-tier.ts", tiers.join(",")];
    // The fast tier alone is light (like npm run test:fast); whole games and Chromium take a slot.
    const light = tiers.join() === "fast";
    out.push([`tests (${tiers.join(" + ")} tier)`, light ? [process.execPath, ...run.slice(1)] : [...node, "tools/slot.ts", "2", "--", ...run],
      testMin * MIN + (light ? 0 : SLOT_WAIT_MS)]);
  }
  return out;
}

export function parseVerifyArgs(argv: string[]): { parts: Part[]; allowDirty: boolean; list: boolean } {
  const parts: Part[] = [];
  let allowDirty = false, list = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--allow-dirty") allowDirty = true;
    else if (a === "--list") list = true;
    else if (a === "--part" || a.startsWith("--part=")) {
      const v = a === "--part" ? argv[++i] : a.slice("--part=".length);
      if (!v) throw new Error(`--part needs one of ${PARTS.join(", ")}`);
      for (const p of v.split(",")) {
        if (!PARTS.includes(p as Part)) throw new Error(`unknown part '${p}' (use ${PARTS.join(", ")})`);
        if (!parts.includes(p as Part)) parts.push(p as Part);
      }
    } else throw new Error(`unknown argument '${a}' (use --allow-dirty, --part <${PARTS.join("|")}>, --list)`);
  }
  return { parts, allowDirty, list };
}

/** Where a run's step logs go (relative to the repository root): the full gate owns
 *  `.tmp/verify/`; a part run writes `.tmp/verify/<parts>/`, so CI's single job, which runs the
 *  selected parts as separate steps, keeps the logs of a part that failed before the next one ran. */
export function logDir(parts: Part[]): string {
  const want = PARTS.filter(p => parts.includes(p));
  return want.length === 0 || want.length === PARTS.length ? ".tmp/verify/" : `.tmp/verify/${want.join("+")}/`;
}

/** The monorepo's full gate as run by `npm run verify` (kept for callers that list its steps). */
export const steps: PlannedStep[] = plan([], { allowDirty: process.argv.includes("--allow-dirty") });

/** Kill a step and everything it started. POSIX: the step leads its own process group (spawned
 *  detached), so one signal reaches slot.ts, test-tier, node --test and its workers, whose inherited
 *  pipes would otherwise keep the step "running". Windows: taskkill walks the tree. */
function killTree(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
}

export type StepResult = { ok: boolean; status: number | null; line: string; out: string };

/** Run one step with a timeout; `line` is its PASS/FAIL summary line. */
export function runStep(label: string, cmd: string[], timeoutMs: number): Promise<StepResult> {
  const t0 = Date.now();
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  return new Promise(resolveStep => {
    const chunks: Buffer[] = [];
    let timedOut = false, done = false, spawnError = "";
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"], shell: false, detached: process.platform !== "win32", windowsHide: true });
    child.stdout.on("data", (b: Buffer) => chunks.push(b));
    child.stderr.on("data", (b: Buffer) => chunks.push(b));
    const timer = setTimeout(() => { timedOut = true; if (child.pid !== undefined) killTree(child.pid); }, timeoutMs);
    // A detached step no longer shares the terminal's process group, so Ctrl-C (or a CI cancel)
    // reaching verify is passed on to the step's tree before verify exits.
    const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const onSignal = (sig: NodeJS.Signals) => { if (child.pid !== undefined) killTree(child.pid); process.exit(sig === "SIGINT" ? 130 : 143); };
    if (process.platform !== "win32") for (const s of SIGNALS) process.on(s, onSignal);
    let grace: NodeJS.Timeout | undefined;
    const finish = (status: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer); if (grace) clearTimeout(grace);
      for (const s of SIGNALS) process.off(s, onSignal);
      let out = Buffer.concat(chunks).toString("utf8") + spawnError;
      const ok = status === 0 && !timedOut;
      if (timedOut) out += `\nverify: step '${label}' timed out after ${secs(timeoutMs)} and was killed with its process tree\n`;
      const line = `${ok ? "PASS" : "FAIL"}  ${label}  (${timedOut ? `timed out after ${secs(timeoutMs)}` : secs(Date.now() - t0)})`;
      resolveStep({ ok, status, line, out });
    };
    child.on("error", e => { spawnError = `\n${e}`; finish(null); });
    // `close` waits for the pipes; if a stray grandchild still holds them after the step exited,
    // stop waiting after 10 s rather than hang.
    child.on("exit", code => { grace = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code); }, 10_000); });
    child.on("close", code => finish(code));
  });
}

// Exact file name, so importing failureLines (tests/verify-summary.test.ts) never runs the gate.
if (/(^|[\\/])verify\.ts$/.test(process.argv[1] ?? "")) await main(process.argv.slice(2));

async function main(argv: string[]) {
  let args: ReturnType<typeof parseVerifyArgs>;
  try { args = parseVerifyArgs(argv); } catch (e) {
    console.error(`verify: ${(e as Error).message}`);
    process.exitCode = 2;
    return;
  }
  const todo = plan(args.parts, { ...args, tree: TREE });
  const scope = (TREE === "open" ? " (the open SDK tree)" : "") + (args.parts.length && args.parts.length < PARTS.length ? ` (parts: ${args.parts.join(", ")}; not the full gate)` : "");
  if (args.list) {
    for (const [label, cmd, ms] of todo) console.log(`${label}  [timeout ${Math.round(ms / MIN)} min]\n    ${cmd.slice(1).join(" ")}`);
    return;
  }
  if (scope) console.log(`verify${scope}`);
  // Full output of every step goes to .tmp/verify/ (gitignored; CI uploads it when a run fails).
  const rel = logDir(args.parts);
  const dir = new URL(`../${rel}`, import.meta.url);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  let failed = 0;
  for (const [i, [label, cmd, ms]] of todo.entries()) {
    const r = await runStep(label, cmd, ms);
    if (!r.ok) failed++;
    const log = `${String(i + 1).padStart(2, "0")}-${label.split(" ")[0].replace(/\W+/g, "-")}.log`;
    writeFileSync(new URL(log, dir), `$ ${cmd.join(" ")}\nexit ${r.status}\n\n${r.out}`);
    console.log(r.line);
    if (!r.ok) console.log(failureLines(r.out).join("\n") + `\n(full log: ${rel}${log})`);
  }
  console.log(failed ? `\nverify: ${failed} step(s) failed${scope}` : `\nverify: all checks passed${scope}`);
  process.exitCode = failed ? 1 : 0; // not process.exit(): see tools/test-tier.ts (Windows pipe assertion)
}
