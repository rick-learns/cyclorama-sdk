// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// The embedding example (examples/embed/headless.ts, docs/guide/embedding.md) runs and prints what
// the guide says it prints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("examples/embed/headless.ts: runs Tutorial 1 headless, reads RAM, picture and sound, saves, restores, repeats", () => {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "examples/embed/headless.ts"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /^after 30 frames: lamp at x=178 y=104, 184 lamp pixels, \d+ audio samples, peak [1-9]\d*$/, "29 frames of Right = 58 pixels; A played a note");
  const samples = Number(/(\d+) audio samples/.exec(lines[0])![1]);
  assert.ok(Math.abs(samples - 30 * 358416 / 448) <= 1, `${samples} samples = 30 frames at one sample per 448 master cycles`);
  assert.match(lines[1], /^save state: \d+ bytes; restored and re-run: identical \(hash [0-9a-f]{8}\)$/);
  assert.equal(lines[2], "fresh run with the same input: identical");
});
