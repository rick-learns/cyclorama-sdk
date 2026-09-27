// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// tools/verify.ts prints up to 25 "interesting" lines of a failing step. On the first CI failure
// (run 36266950569) those 25 lines were mostly PASSING tests whose names contain "error"
// ("✔ error: unknown mnemonic"), so the one failing test was easy to miss.
import { test } from "node:test";
import assert from "node:assert/strict";
import { failureLines, steps } from "../tools/verify.ts";

test("passing tests whose names mention errors are not failure lines", () => {
  const out = [
    "✔ error: unknown mnemonic (0.8ms)",
    "✔ errors carry the line number and do not stop assembly (0.5ms)",
    "✖ the manifest lists every ROM the build makes (0.4ms)",
    "  AssertionError [ERR_ASSERTION]: manifest missing",
    "ok 12 - error: duplicate symbol",
    "not ok 13 - replay hash",
    "FAIL  lantern-test  hash=1234 state hash differs",
    "PASS  slice-test  ok",
  ].join("\n");
  assert.deepEqual(failureLines(out), [
    "✖ the manifest lists every ROM the build makes (0.4ms)",
    "  AssertionError [ERR_ASSERTION]: manifest missing",
    "not ok 13 - replay hash",
    "FAIL  lantern-test  hash=1234 state hash differs",
  ]);
});

test("at most 25 lines", () => {
  const out = Array.from({ length: 40 }, (_, i) => `✖ test ${i}`).join("\n");
  assert.equal(failureLines(out).length, 25);
});

test("verify wiring: skills lint after canon validation; the test step runs every tier through a heavy-run slot", () => {
  const labels = steps.map(([l]) => l);
  const lint = labels.findIndex(l => l.startsWith("skills lint"));
  assert.ok(lint > labels.findIndex(l => l.startsWith("canon validation")), "skills lint follows canon validation");
  assert.ok(steps[lint][1].includes("tools/skills-lint.ts"));
  const [label, cmd] = steps[steps.length - 1];
  assert.match(label, /^all tests/);
  // node tools/slot.ts 2 -- node --disable-warning=... tools/test-tier.ts all (concurrency comes from test-tier)
  const at = cmd.indexOf("tools/slot.ts");
  assert.ok(at > 0, "test step goes through tools/slot.ts");
  assert.deepEqual(cmd.slice(at, at + 4), ["tools/slot.ts", "2", "--", "node"]);
  assert.deepEqual(cmd.slice(-2), ["tools/test-tier.ts", "all"]);
  assert.equal(new Set(labels.map(l => l.split(" ")[0])).size, labels.length, "log names (first word of each label) are unique");
});
