// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Machine-wide heavy-run slots: at most <n> heavy runs (full test suite,
// Playwright) at once across the main checkout and every agent worktree, so timing tests do not
// flake under CPU contention.
//   node tools/slot.ts <n> [--dir <path>] [--poll-ms <ms>] [--max-wait-ms <ms>] -- <command> [args...]
// Takes one of n lock directories under `<git common dir>/cyc-slots/` (shared by all worktrees),
// records {pid, started, cwd, command}, runs the command with inherited stdio, releases the slot
// and exits with the command's exit code. Waits (printing its position) while all slots are busy.
// A slot whose owner PID is gone, or older than 3 h, is reclaimed. Locks are directories because
// mkdir is atomic on every platform. A leading `node` runs with this Node binary; other commands
// are spawned without a shell (use `node <script>` rather than npm shims on Windows).
// It never hangs a run: under CI (one run per runner) or CYC_HEAVY_SLOTS=0 it runs the command
// directly; CYC_HEAVY_SLOTS=<n> overrides <n>; after --max-wait-ms (or CYC_SLOT_MAX_WAIT_MS,
// default 20 min) it runs the command without a slot and says so.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const STALE_MS = 3 * 60 * 60 * 1000;
export const MAX_WAIT_MS = 20 * 60 * 1000;

/** CI's usual truthy spellings (GitHub Actions sets CI=true). */
export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CI ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

interface Owner { pid: number; started: number; cwd: string; command: string }

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Remove slot directories whose owner is gone (dead PID, unreadable owner file, or too old). */
export function reclaimStale(dir: string, now = Date.now()): string[] {
  const reclaimed: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir).filter(n => n.startsWith("slot-")); } catch { return reclaimed; }
  for (const n of names) {
    let owner: Owner | null = null;
    try { owner = JSON.parse(readFileSync(join(dir, n, "owner.json"), "utf8")); } catch { owner = null; }
    const stale = owner ? !alive(owner.pid) || now - owner.started > STALE_MS : true;
    if (!stale) continue;
    // An owner file may be missing for a moment while a slot is being taken: only reclaim a
    // missing one if the directory is itself older than a few seconds.
    if (!owner) {
      try { if (now - statSync(join(dir, n)).mtimeMs < 5000) continue; } catch { continue; }
    }
    rmSync(join(dir, n), { recursive: true, force: true });
    reclaimed.push(n);
  }
  return reclaimed;
}

/** Try once to take a free slot; returns its path or null. */
export function tryAcquire(dir: string, n: number, command: string): string | null {
  mkdirSync(dir, { recursive: true });
  reclaimStale(dir);
  for (let i = 0; i < n; i++) {
    const slot = join(dir, `slot-${i}`);
    try { mkdirSync(slot); } catch { continue; }
    writeFileSync(join(slot, "owner.json"), JSON.stringify({ pid: process.pid, started: Date.now(), cwd: process.cwd(), command } satisfies Owner));
    return slot;
  }
  return null;
}

export function defaultDir(cwd = process.cwd()): string {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" });
  const common = r.status === 0 ? resolve(cwd, r.stdout.trim()) : resolve(cwd, ".tmp");
  return join(common, "cyc-slots");
}

function run(cmd: string[]): Promise<number> {
  const exe = cmd[0] === "node" ? process.execPath : cmd[0];
  return new Promise<number>(res => {
    const child = spawn(exe, cmd.slice(1), { stdio: "inherit" });
    child.on("error", e => { process.stderr.write(`[slot] cannot run ${cmd[0]}: ${e.message}\n`); res(127); });
    child.on("exit", (code, sig) => res(code ?? (sig ? 1 : 0)));
  });
}

const USAGE = "usage: node tools/slot.ts <n> [--dir <path>] [--poll-ms <ms>] [--max-wait-ms <ms>] -- <command> [args...]\n";

async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const sep = argv.indexOf("--");
  const opts = sep < 0 ? argv : argv.slice(0, sep);
  const cmd = sep < 0 ? [] : argv.slice(sep + 1);
  const override = env.CYC_HEAVY_SLOTS?.trim() || undefined;
  if (override !== undefined && !/^\d+$/.test(override)) {
    process.stderr.write(`[slot] CYC_HEAVY_SLOTS=${override} is not a whole number (0 = no slot)\n${USAGE}`);
    return 2;
  }
  const n = Number(override ?? opts[0]);
  const flag = (name: string) => { const i = opts.indexOf(name); return i > 0 ? opts[i + 1] : undefined; };
  const maxWait = Number(flag("--max-wait-ms") ?? env.CYC_SLOT_MAX_WAIT_MS ?? MAX_WAIT_MS);
  if (override === "0" && cmd.length) return run(cmd);
  if (!Number.isInteger(n) || n < 1 || !cmd.length || !(maxWait >= 0)) { process.stderr.write(USAGE); return 2; }
  if (isCI(env)) return run(cmd); // one run per CI runner: nothing to share, nothing to wait for
  const dir = flag("--dir") ?? defaultDir();
  const poll = Number(flag("--poll-ms") ?? 1000);
  const label = cmd.join(" ");
  const t0 = Date.now();
  let slot = tryAcquire(dir, n, label);
  let noted = -Infinity;
  while (!slot) {
    const waited = Date.now() - t0; // wall time: polls stretch under load
    if (waited >= maxWait) {
      process.stderr.write(`[slot] waited ${Math.round(waited / 1000)} s for one of ${n} heavy-run slot(s) (${dir}); running without a slot\n`);
      return run(cmd);
    }
    if (waited - noted >= 15000) { process.stderr.write(`[slot] all ${n} heavy-run slot(s) busy (${dir}); waiting...\n`); noted = waited; }
    await new Promise(r => setTimeout(r, Math.max(1, Math.min(poll, maxWait - waited))));
    slot = tryAcquire(dir, n, label);
  }
  const release = () => rmSync(slot!, { recursive: true, force: true });
  process.on("SIGINT", () => { release(); process.exitCode = 130; });
  try {
    return await run(cmd);
  } finally {
    release();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { process.stderr.write(`[slot] ${String(e)}\n`); process.exitCode = 1; });
}
