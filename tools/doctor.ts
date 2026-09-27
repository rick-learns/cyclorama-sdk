// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// npm run doctor [-- --allow-dirty] [--no-browser]
// Checks the toolchain before any work: pinned Node version, exact installed dependency versions,
// a launchable headless browser runtime (not with --no-browser), and a clean git working tree
// (reported but allowed with --allow-dirty).
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type Level = "PASS" | "WARN" | "FAIL";

export function doctorExit(results: { level: Level }[]): number {
  return results.some(r => r.level === "FAIL") ? 1 : 0;
}

async function main(): Promise<void> {
  const require = createRequire(import.meta.url);
  const root = new URL("..", import.meta.url);
  const results: { name: string; level: Level; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail: string) => results.push({ name, level: ok ? "PASS" : "FAIL", detail });

  // 1. Node version
  const pinned = readFileSync(new URL(".nvmrc", root), "utf8").trim();
  check("node version", process.versions.node === pinned, `running ${process.versions.node}, pinned ${pinned}`);

  // 2. Dependencies installed at exact pinned versions
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  for (const [name, want] of Object.entries<string>(pkg.devDependencies ?? {})) {
    let have = "missing";
    try { have = require(`${name}/package.json`).version; } catch { /* missing */ }
    check(`dep ${name}`, have === want, `installed ${have}, pinned ${want}`);
  }

  // 3. Browser test runtime (`--no-browser`: verify parts that launch no browser, e.g. the static CI job)
  const skipped: string[] = [];
  if (process.argv.includes("--no-browser")) skipped.push("browser runtime");
  else try {
    const { chromium } = await import("playwright");
    const exe = chromium.executablePath();
    if (!existsSync(exe)) throw new Error(`chromium not installed at ${exe}`);
    const browser = await chromium.launch({ headless: true });
    const version = browser.version();
    await browser.close();
    check("browser runtime", true, `chromium ${version}`);
  } catch (e) {
    check("browser runtime", false, String((e as Error).message).split("\n")[0]);
  }

  // 4. Clean repository state
  const allowDirty = process.argv.includes("--allow-dirty");
  try {
    const status = execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim();
    const clean = status === "";
    check("git clean", clean || allowDirty, clean ? "working tree clean" : `${status.split("\n").length} uncommitted path(s)${allowDirty ? " (allowed)" : ""}`);
  } catch (e) {
    check("git clean", false, "not a git repository");
  }

  for (const r of results) console.log(`${r.level}  ${r.name.padEnd(22)} ${r.detail}`);
  for (const s of skipped) console.log(`SKIP  ${s.padEnd(22)} not checked (--no-browser)`);
  const failed = results.filter(r => r.level === "FAIL").length, warned = results.filter(r => r.level === "WARN").length;
  console.log(failed ? `\ndoctor: ${failed} check(s) failed` : `\ndoctor: all checks passed${warned ? ` (${warned} warning(s))` : ""}`);
  process.exit(doctorExit(results));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
