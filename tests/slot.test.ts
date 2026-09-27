// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// tools/slot.ts: machine-wide heavy-run slots shared by every worktree. n=1 serialises two
// concurrent runs, n=2 lets two overlap, a stale lock (dead PID) is reclaimed, the command's exit
// code is propagated and the slot is released afterwards. It must never hang a run: CI (one run
// per machine) and CYC_HEAVY_SLOTS=0 bypass it, and a wait longer than --max-wait-ms runs the
// command anyway with a warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDir, reclaimStale, tryAcquire } from "../tools/slot.ts";

const SLOT = join(process.cwd(), "tools", "slot.ts");
// Children must not inherit a CI or override variable from the machine running this suite.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CI|CYC_HEAVY_SLOTS|CYC_SLOT_MAX_WAIT_MS)$/i.test(k)));
// A child that logs start/end times of a "heavy run" to a file. For n=1 it lasts 1.5 s. For n=2 it
// is a barrier: it ends only once both runs have started (or after 20 s), so the overlap check
// does not depend on how fast two processes start under load (a fixed 1.5 s window flaked with
// four suites running at once).
const WORK = `const fs=require("fs");const f=process.argv[1],want=Number(process.argv[2]||0),t0=Date.now();fs.appendFileSync(f,"S "+Date.now()+"\\n");
const end=()=>fs.appendFileSync(f,"E "+Date.now()+"\\n");
if(!want)setTimeout(end,1500);else{const w=()=>{const s=fs.readFileSync(f,"utf8").split("\\n").filter(l=>l[0]==="S").length;if(s>=want||Date.now()-t0>20000)end();else setTimeout(w,20)};w()}`;

function runSlot(n: number, dir: string, log: string, barrier = 0): Promise<number | null> {
  return new Promise(res => {
    const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", SLOT, String(n), "--dir", dir, "--poll-ms", "50", "--", "node", "-e", WORK, log, String(barrier)], { stdio: "ignore", env: ENV });
    p.on("exit", code => res(code));
  });
}
function intervals(log: string): [number, number][] {
  const lines = readFileSync(log, "utf8").trim().split("\n").map(l => l.split(" "));
  const starts = lines.filter(l => l[0] === "S").map(l => Number(l[1])).sort();
  const ends = lines.filter(l => l[0] === "E").map(l => Number(l[1])).sort();
  return starts.map((s, i) => [s, ends[i]]);
}

test("n=1 serialises two concurrent heavy runs; n=2 lets them overlap; slots are released", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cyc-slot-"));
  try {
    const log1 = join(dir, "one.log");
    assert.deepEqual(await Promise.all([runSlot(1, join(dir, "s1"), log1), runSlot(1, join(dir, "s1"), log1)]), [0, 0]);
    const [a, b] = intervals(log1);
    assert.ok(b[0] >= a[1], `second run started ${b[0] - a[1]} ms before the first ended`);
    assert.deepEqual(readdirSync(join(dir, "s1")), [], "slot released");

    const log2 = join(dir, "two.log");
    assert.deepEqual(await Promise.all([runSlot(2, join(dir, "s2"), log2, 2), runSlot(2, join(dir, "s2"), log2, 2)]), [0, 0]);
    // Both barrier runs end only after both have started, often in the same millisecond and in either
    // order, so compare the later start with the earlier end rather than pairing sorted times.
    const iv = intervals(log2), starts = iv.map(i => i[0]), ends = iv.map(i => i[1]);
    assert.ok(Math.max(...starts) <= Math.min(...ends), "with two slots both runs overlap");
    assert.ok(Math.max(...ends) - Math.min(...starts) < 20_000, "the runs ended because both started, not by the 20 s fallback");
    assert.deepEqual(readdirSync(join(dir, "s2")), [], "both slots released");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a stale slot (owner PID gone) is reclaimed; a live one is kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "cyc-slot-"));
  try {
    mkdirSync(join(dir, "slot-0"));
    writeFileSync(join(dir, "slot-0", "owner.json"), JSON.stringify({ pid: 2_000_000_000, started: Date.now(), cwd: "x", command: "dead" }));
    mkdirSync(join(dir, "slot-1"));
    writeFileSync(join(dir, "slot-1", "owner.json"), JSON.stringify({ pid: process.pid, started: Date.now(), cwd: "x", command: "live" }));
    assert.deepEqual(reclaimStale(dir), ["slot-0"]);
    assert.ok(existsSync(join(dir, "slot-1")));
    const got = tryAcquire(dir, 2, "me");
    assert.equal(got, join(dir, "slot-0"));
    assert.equal(tryAcquire(dir, 2, "again"), null, "both slots now held by live processes");
    // Too old counts as stale even if the PID exists (PID reuse).
    writeFileSync(join(dir, "slot-1", "owner.json"), JSON.stringify({ pid: process.pid, started: Date.now() - 4 * 3600_000, cwd: "x", command: "old" }));
    assert.deepEqual(reclaimStale(dir), ["slot-1"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("exit code is propagated, usage errors exit 2, and the default lock dir is shared by all worktrees", () => {
  const dir = mkdtempSync(join(tmpdir(), "cyc-slot-"));
  try {
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", SLOT, "1", "--dir", dir, "--", "node", "-e", "process.exitCode = 7"], { encoding: "utf8", env: ENV });
    assert.equal(r.status, 7);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", SLOT, "0", "--", "node", "-v"], { env: ENV }).status, 2);
    assert.equal(spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", SLOT, "2"], { env: ENV }).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const common = spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).stdout.trim();
  assert.ok(defaultDir().replace(/\\/g, "/").endsWith("/cyc-slots"));
  assert.ok(defaultDir().replace(/\\/g, "/").includes(common.replace(/\\/g, "/").replace(/^\.\//, "")));
});

/** Run the slot CLI synchronously; `live` pre-fills slot-0 with an owner that is alive (this test process). */
function cli(dir: string, n: string, extra: string[], env: Record<string, string | undefined> = {}, live = false) {
  if (live) { mkdirSync(join(dir, "slot-0"), { recursive: true }); writeFileSync(join(dir, "slot-0", "owner.json"), JSON.stringify({ pid: process.pid, started: Date.now(), cwd: "x", command: "live" })); }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", SLOT, n, "--dir", dir, "--poll-ms", "50", ...extra, "--", "node", "-e", "process.exitCode = 3"], { encoding: "utf8", env: { ...ENV, ...env }, timeout: 60_000 });
  return { ...r, ms: Date.now() - t0 };
}

test("never hangs: a wait past --max-wait-ms (or CYC_SLOT_MAX_WAIT_MS) runs the command anyway and leaves the busy slot alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "cyc-slot-"));
  try {
    const r = cli(join(dir, "a"), "1", ["--max-wait-ms", "300"], {}, true);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /waited .* running without a slot/);
    assert.ok(r.ms < 20_000, `took ${r.ms} ms`);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "a", "slot-0", "owner.json"), "utf8")).command, "live", "the live owner's slot is untouched");
    const e = cli(join(dir, "b"), "1", [], { CYC_SLOT_MAX_WAIT_MS: "300" }, true);
    assert.equal(e.status, 3, e.stderr);
    assert.match(e.stderr, /running without a slot/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a stale lock left by a killed run is reclaimed at once, without waiting", () => {
  const dir = mkdtempSync(join(tmpdir(), "cyc-slot-"));
  try {
    mkdirSync(join(dir, "slot-0"));
    writeFileSync(join(dir, "slot-0", "owner.json"), JSON.stringify({ pid: 2_000_000_000, started: Date.now(), cwd: "x", command: "killed" }));
    const r = cli(dir, "1", ["--max-wait-ms", "600000"]);
    assert.equal(r.status, 3, r.stderr);
    assert.doesNotMatch(r.stderr, /busy|without a slot/);
    assert.deepEqual(readdirSync(dir), [], "reclaimed, used and released");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CI and CYC_HEAVY_SLOTS=0 bypass the lock entirely; CYC_HEAVY_SLOTS=<n> overrides the command-line count", () => {
  const dir = mkdtempSync(join(tmpdir(), "cyc-slot-"));
  try {
    for (const env of [{ CI: "true" }, { CYC_HEAVY_SLOTS: "0" }]) {
      // All slots held by a live owner: a bypassed run must not wait at all.
      const d = join(dir, Object.keys(env)[0]);
      const r = cli(d, "1", ["--max-wait-ms", "600000"], env, true);
      assert.equal(r.status, 3, r.stderr);
      assert.doesNotMatch(r.stderr, /busy|without a slot/);
      assert.deepEqual(readdirSync(d), ["slot-0"], "no slot taken");
    }
    // CI=false is not CI.
    const f = cli(join(dir, "f"), "1", ["--max-wait-ms", "200"], { CI: "false" }, true);
    assert.match(f.stderr, /without a slot/);
    // argv says 2, env says 1: slot-0 is busy, so only the env count explains a wait.
    const o = cli(join(dir, "o"), "2", ["--max-wait-ms", "200"], { CYC_HEAVY_SLOTS: "1" }, true);
    assert.equal(o.status, 3);
    assert.match(o.stderr, /without a slot/);
    assert.equal(cli(join(dir, "x"), "2", [], { CYC_HEAVY_SLOTS: "many" }).status, 2, "a bad override is a usage error");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
