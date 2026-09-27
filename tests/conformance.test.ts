// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Every conformance ROM (tests/conformance/*.asm, written in CYASM) must pass on
// the full machine, deterministically (runner compares two runs' state hashes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { conformanceFiles, runConformance } from "../tools/conformance.ts";

for (const f of conformanceFiles()) {
  test(`conformance ${f}`, () => {
    const r = runConformance(f);
    assert.ok(r.pass, `${r.name}: ${r.detail}`);
  });
}
