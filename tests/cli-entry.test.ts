// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// CLI entry detection (tools/cli-entry.ts): a tool runs its command line only when it IS the
// script node was started with, never when a look-alike (tools/foo-budget.ts) imports it. The
// endsWith("budget.ts") guard it replaces matched any file whose name ended that way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isCliEntry } from "../tools/cli-entry.ts";

const BUDGET_URL = new URL("../tools/budget.ts", import.meta.url).href;
const BUDGET = fileURLToPath(BUDGET_URL);

test("isCliEntry: the module's own file (absolute or relative to the cwd) is the entry; look-alikes and no script are not", () => {
  assert.equal(isCliEntry(BUDGET_URL, BUDGET), true);
  assert.equal(isCliEntry(BUDGET_URL, relative(process.cwd(), BUDGET)), true);
  assert.equal(isCliEntry(BUDGET_URL, join(BUDGET, "..", "foo-budget.ts")), false);
  assert.equal(isCliEntry(BUDGET_URL, join(BUDGET, "..", "..", "budget.ts")), false);
  assert.equal(isCliEntry(BUDGET_URL, join(tmpdir(), "tools", "budget.ts")), false);
  assert.equal(isCliEntry(BUDGET_URL, `${BUDGET}.bak`), false);
  assert.equal(isCliEntry(BUDGET_URL, undefined), false);
  assert.equal(isCliEntry(BUDGET_URL, ""), false);
});

test("a look-alike script named *-budget.ts that imports tools/budget.ts does not run the budget CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "cyc-cli-entry-"));
  try {
    const lookAlike = join(dir, "foo-budget.ts");
    writeFileSync(lookAlike, `import ${JSON.stringify(pathToFileURL(BUDGET).href)};\nconsole.log("look-alike done");\n`);
    // A ROM name that does not exist: the budget CLI would print "FAIL  no-such-rom" and exit 1.
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", lookAlike, "no-such-rom"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.equal(r.stdout.trim(), "look-alike done", r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no tool detects its CLI run with endsWith on process.argv[1]", () => {
  const toolsDir = fileURLToPath(new URL("../tools/", import.meta.url));
  const offenders = readdirSync(toolsDir, { recursive: true, encoding: "utf8" })
    .filter(f => f.endsWith(".ts"))
    .filter(f => /argv\[1\][^\n]*\.endsWith\(/.test(readFileSync(join(toolsDir, f), "utf8")))
    .map(f => `tools/${f.replace(/\\/g, "/")}`);
  assert.deepEqual(offenders, [], "use isCliEntry(import.meta.url) from tools/cli-entry.ts");
});
