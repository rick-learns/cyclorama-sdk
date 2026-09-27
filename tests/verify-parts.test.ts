// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// `node tools/verify.ts --part <static|emulation|browser>` (repeatable) runs one slice of the gate,
// so CI can run the slices as separate jobs and skip the ones a change cannot affect. No flag =
// every step = `npm run verify`, the whole gate, unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { logDir, PARTS, parseVerifyArgs, plan, runStep, SLOT_WAIT_MS, slotWaitMs, STEP_TABLE, steps, TREE } from "../tools/verify.ts";

const cmdOf = (parts: readonly string[]) => plan(parts as never, { allowDirty: false }).map(s => s[1].join(" "));
const labelsOf = (parts: readonly string[]) => plan(parts as never, { allowDirty: false }).map(s => s[0]);

test("every step belongs to exactly one part, and the parts together are the full gate", () => {
  assert.deepEqual(PARTS, ["static", "emulation", "browser"]);
  for (const s of STEP_TABLE) assert.ok(PARTS.includes(s.part), `${s.label}: part ${s.part}`);
  // Each step appears in exactly one single-part plan (tests are one step per tier).
  const owners = new Map<string, string[]>();
  for (const p of PARTS) for (const s of STEP_TABLE.filter(x => x.part === p)) owners.set(s.label, [...(owners.get(s.label) ?? []), p]);
  assert.equal(owners.size, STEP_TABLE.length, "step labels are unique");
  for (const [label, ps] of owners) assert.equal(ps.length, 1, `${label} is in ${ps.join(", ")}`);
  // All three parts = no flag = today's gate, step for step.
  assert.deepEqual(plan([...PARTS], { allowDirty: false }), plan([], { allowDirty: false }));
  assert.deepEqual(cmdOf(PARTS), steps.map(s => s[1].join(" ")));
});

test("the full gate: 13 steps ending with every test tier in one slotted run; budgets judge every replay", () => {
  const labels = labelsOf(PARTS);
  assert.deepEqual(labels.map(l => l.split(" ")[0]), ["doctor", "typecheck", "rebuild", "cartridge", "conformance", "canon", "skills", "SPDX", "museum", "official", "export:", "export-browser:", "all"]);
  // tools/budget.ts plays every replay file on its metered run and fails on a wrong hash, win or
  // frame count, so replay.ts is not a separate step (it stays for hand use). --frames would skip
  // replay judging, so the gate never passes it.
  const budget = steps.find(s => s[0].startsWith("cartridge"))![1];
  assert.ok(budget.some(a => a.endsWith("tools/budget.ts")) && !budget.includes("--frames"), budget.join(" "));
  assert.ok(!steps.some(s => s[1].some(a => a.endsWith("tools/replay.ts"))), "no separate replay step");
  const last = steps[steps.length - 1][1];
  assert.deepEqual(last.slice(-2), ["tools/test-tier.ts", "all"]);
  assert.ok(last.includes("tools/slot.ts"));
  assert.ok(!steps[0][1].includes("--no-browser"), "the full gate's doctor checks the browser runtime");
});

test("parts: static = doctor..builds + fast tier; emulation = budgets and replays, slow tier; browser = browser tier", () => {
  const firstWords = (p: string) => labelsOf([p]).map(l => l.split(" ")[0]);
  assert.deepEqual(firstWords("static"), ["doctor", "typecheck", "rebuild", "conformance", "canon", "skills", "SPDX", "museum", "official", "export:", "tests"]);
  assert.deepEqual(firstWords("emulation"), ["cartridge", "tests"]);
  assert.deepEqual(firstWords("browser"), ["export-browser:", "tests"]);
  const tail = (p: string[]) => { const c = plan(p as never, { allowDirty: false }).at(-1)![1]; return c.slice(c.indexOf("tools/test-tier.ts")); };
  assert.deepEqual(tail(["static"]), ["tools/test-tier.ts", "fast"]);
  assert.deepEqual(tail(["emulation"]), ["tools/test-tier.ts", "slow"]);
  assert.deepEqual(tail(["browser"]), ["tools/test-tier.ts", "browser"]);
  assert.deepEqual(tail(["static", "browser"]), ["tools/test-tier.ts", "fast,browser"], "selected tiers share one node --test run");
  // The fast tier alone is light (like npm run test:fast); slow and browser tiers take a heavy-run slot.
  assert.ok(!cmdOf(["static"]).at(-1)!.includes("tools/slot.ts"));
  assert.ok(cmdOf(["emulation"]).at(-1)!.includes("tools/slot.ts"));
  assert.ok(cmdOf(["browser"]).at(-1)!.includes("tools/slot.ts"));
  // Without the browser part nothing needs Chromium, so doctor skips its browser check.
  assert.ok(cmdOf(["static"])[0].endsWith("tools/doctor.ts --no-browser"));
  assert.ok(cmdOf(["static", "browser"])[0].endsWith("tools/doctor.ts"));
  assert.ok(plan(["static"], { allowDirty: true })[0][1].includes("--allow-dirty"));
  // Order follows the full gate, whatever order the flags came in.
  assert.deepEqual(labelsOf(["browser", "static"]), labelsOf(["static", "browser"]));
});

test("the open SDK tree (EXPORT.json): the same gate without the monorepo-only steps", () => {
  const open = (p: string[]) => plan(p as never, { allowDirty: false, tree: "open" }).map(([l]) => l.split(" ")[0]);
  assert.equal(TREE, existsSync("EXPORT.json") ? "open" : "monorepo", "EXPORT.json marks the open tree");
  assert.deepEqual(open([]), ["doctor", "typecheck", "rebuild", "cartridge", "conformance", "all"]);
  assert.deepEqual(open(["static", "emulation"]), ["doctor", "typecheck", "rebuild", "cartridge", "conformance", "tests"]);
  assert.deepEqual(open(["browser"]), ["tests"]);
  for (const s of STEP_TABLE.filter(x => x.monorepo)) assert.ok(!s.tier, `${s.label}: a test tier always runs`);
  assert.deepEqual(plan([], { allowDirty: false, tree: "monorepo" }), plan([], { allowDirty: false }), "the monorepo plan is the default");
});

test("arguments: --part is repeatable (also --part=x and x,y); unknown parts are refused", () => {
  assert.deepEqual(parseVerifyArgs([]), { parts: [], allowDirty: false, list: false });
  assert.deepEqual(parseVerifyArgs(["--part", "static", "--part=browser", "--allow-dirty"]), { parts: ["static", "browser"], allowDirty: true, list: false });
  assert.deepEqual(parseVerifyArgs(["--part", "emulation,browser", "--list"]), { parts: ["emulation", "browser"], allowDirty: false, list: true });
  assert.throws(() => parseVerifyArgs(["--part", "fast"]), /unknown part 'fast'/);
  assert.throws(() => parseVerifyArgs(["--part"]), /--part needs/);
  assert.throws(() => parseVerifyArgs(["--bogus"]), /unknown argument/);
});

test("CLI: --list prints the plan without running it; a bad part exits 2", () => {
  const run = (...a: string[]) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "tools/verify.ts", ...a], { encoding: "utf8" });
  const r = run("--part", "emulation", "--list");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cartridge resource budgets/);
  assert.match(r.stdout, /tools\/test-tier\.ts slow/);
  assert.doesNotMatch(r.stdout, /typecheck/);
  const bad = run("--part", "nope");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown part 'nope'/);
});

test("hang protection: every step has a generous timeout (~2x the slowest seen); slotted steps add the slot wait outside CI", () => {
  const byLabel = (parts: string[]) => new Map(plan(parts as never, { allowDirty: false }).map(([l, , t]) => [l.split(" ")[0], t]));
  const full = byLabel([]);
  const min = 60_000;
  for (const [label, t] of full) assert.ok(Number.isInteger(t) && t >= 5 * min, `${label}: ${t} ms`);
  assert.equal(full.get("cartridge"), 15 * min, "budgets + replays: 139.5 s budgets slowest seen in CI (run 36277772516) before dedup, ~400 s loaded Mac");
  assert.equal(full.get("deterministic"), undefined, "replays are judged on the budget step's metered run");
  assert.equal(full.get("typecheck"), 5 * min);
  assert.equal(full.get("export:"), 20 * min + SLOT_WAIT_MS, "the open export's own static + emulation gate, in a heavy-run slot");
  assert.equal(full.get("export-browser:"), 10 * min + SLOT_WAIT_MS);
  // Full test run: 803.5 s slowest seen in CI (run 36277772516); ~2x that, plus tools/slot.ts's
  // longest wait for a slot (none under CI, where slot.ts runs the command at once).
  assert.equal(full.get("all"), 30 * min + SLOT_WAIT_MS);
  assert.equal(byLabel(["static"]).get("tests"), 10 * min, "the fast tier alone takes no slot");
  assert.equal(byLabel(["emulation"]).get("tests"), 20 * min + SLOT_WAIT_MS);
  assert.equal(byLabel(["browser"]).get("tests"), 10 * min + SLOT_WAIT_MS);
  assert.equal(byLabel(["static", "browser"]).get("tests"), 20 * min + SLOT_WAIT_MS, "several tiers: the sum, capped at the full run's");
  assert.equal(slotWaitMs({ CI: "true" }), 0);
  assert.equal(slotWaitMs({}), 20 * min, "tools/slot.ts MAX_WAIT_MS");
  assert.equal(slotWaitMs({ CYC_SLOT_MAX_WAIT_MS: "1000" }), 1000);
});

test("a step that outlives its timeout is killed and reported as FAIL … timed out, naming the step", async () => {
  const r = await runStep("sleeper step", [process.execPath, "-e", "setTimeout(() => {}, 20000)"], 300);
  assert.equal(r.ok, false);
  assert.match(r.line, /^FAIL {2}sleeper step {2}\(timed out after 0\.3 s\)/);
  assert.match(r.out, /timed out after 0\.3 s/);
  const ok = await runStep("quick step", [process.execPath, "-e", "console.log('hi')"], 10_000);
  assert.equal(ok.ok, true);
  assert.match(ok.line, /^PASS {2}quick step {2}\(\d+\.\d s\)$/);
  assert.match(ok.out, /^hi$/m);
  assert.equal((await runStep("failing step", [process.execPath, "-e", "process.exit(3)"], 10_000)).ok, false);
});

test("a timed-out step's grandchildren die with it (slot.ts → test-tier → node --test → workers hold the pipes)", async () => {
  // The child starts a grandchild that inherits stdout and sleeps; killing only the child would
  // leave the pipe open and the step hanging until the grandchild's 30 s sleep ended.
  const src = "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' }); setTimeout(() => {}, 30000)";
  const t0 = Date.now();
  const r = await runStep("tree step", [process.execPath, "-e", src], 500);
  assert.equal(r.ok, false);
  assert.match(r.line, /timed out/);
  assert.ok(Date.now() - t0 < 10_000, `returned after ${Date.now() - t0} ms`);
});

test("logs: the full gate writes .tmp/verify/; a part run its own subfolder, so one CI job running the parts as steps keeps every part's logs", () => {
  assert.equal(logDir([]), ".tmp/verify/");
  assert.equal(logDir([...PARTS]), ".tmp/verify/");
  assert.equal(logDir(["static"]), ".tmp/verify/static/");
  assert.equal(logDir(["browser", "static"]), ".tmp/verify/static+browser/");
});

test("doctor --no-browser skips only the browser check (the static CI job installs no Chromium)", () => {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "tools/doctor.ts", "--no-browser", "--allow-dirty"], { encoding: "utf8" });
  assert.match(r.stdout, /SKIP\s+browser runtime/);
  assert.match(r.stdout, /(PASS|FAIL)\s+node version/);
});
