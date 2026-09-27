// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// External-review findings (docs/spec-notes.md §9) pinned against data and the built manual.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REFERENCE } from "../src/isa/reference.ts";
import { reg } from "../src/hw/registers.ts";
import { htmlToText } from "../tools/canon/lib.ts";

const manual = htmlToText(readFileSync("docs/manual/index.html", "utf8")).replace(/\s+/g, " ");

test("shift reference notes name their own immediate form (no SHL copy-paste)", () => {
  for (const [op, imm] of [["SHR", "SHRI"], ["ASR", "ASRI"], ["ROL", "ROLI"], ["SHL", "SHLI"]]) {
    const e = REFERENCE.find(r => r.mnemonic === op)!;
    const notes = JSON.stringify(e);
    assert.ok(notes.includes(`${op} Rd,#n`) && notes.includes(imm), `${op} note`);
    if (op !== "SHL") assert.ok(!notes.includes("SHL Rd,#n"), `${op} still mentions SHL`);
  }
});

test("DMA cost is decided at transfer start, everywhere", () => {
  assert.match(reg("DMACTL").description, /starts during active display/);
  assert.doesNotMatch(manual, /any part runs|starts or runs/);
});

test("VSTAT overflow is 'since last read', never 'this frame'", () => {
  assert.doesNotMatch(reg("VSTAT").description, /this frame/);
  assert.doesNotMatch(manual, /overflow occurred this frame/);
});

test("determinism statement and fixed frame boundaries", () => {
  assert.match(manual, /same ROM image, the same initial cartridge-RAM contents and the same/);
  assert.doesNotMatch(manual, /correspondingly late/);
});

test("audio reset phase, DMA source range, command-register byte writes are specified", () => {
  assert.match(manual, /448 × \(k \+ 1\)/);
  assert.match(manual, /E000–FFFF read as 0/);
  assert.match(manual, /high byte \(odd address\) is ignored/);
  assert.match(manual, /line buffer/);
});
