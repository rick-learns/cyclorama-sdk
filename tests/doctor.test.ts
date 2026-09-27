// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// tools/doctor.ts: a warning never fails the doctor; a failure does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { doctorExit } from "../tools/doctor.ts";

test("warnings never fail the doctor; failures do", () => {
  assert.equal(doctorExit([{ level: "PASS" }, { level: "WARN" }]), 0);
  assert.equal(doctorExit([{ level: "PASS" }, { level: "FAIL" }, { level: "WARN" }]), 1);
});
