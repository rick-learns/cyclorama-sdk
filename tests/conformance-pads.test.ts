// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Conformance ROM pad scripts: a ROM may declare controller-1 input with a comment line
// `; @pads 0:0 30:$08 60:$10` (from frame N the controller-1 value is V until the next entry).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { padScript, runConformance } from "../tools/conformance.ts";

test("no @pads line: no script", () => {
  assert.equal(padScript("; just a comment\n start: NOP\n"), null);
});

test("@pads entries hold from their frame until the next entry; 0 before the first", () => {
  const f = padScript("; title\n; @pads 5:0 30:$08 60:0x10 90:17\n")!;
  assert.ok(f);
  const p1 = (n: number) => f(n)[0];
  assert.deepEqual([p1(0), p1(4), p1(5), p1(29), p1(30), p1(59), p1(60), p1(89), p1(90), p1(5000)], [0, 0, 0, 0, 8, 8, 16, 16, 17, 17]);
  assert.deepEqual(f(40), [8, 0], "controller 2 is always 0");
});

test("@pads values are passed through unmasked (the machine drops bits 15-8)", () => {
  assert.equal(padScript("; @pads 0:$FF08")!(0)[0], 0xff08);
});

test("malformed @pads lines are errors", () => {
  assert.throws(() => padScript("; @pads 10"), /@pads/);
  assert.throws(() => padScript("; @pads 10:zz"), /@pads/);
  assert.throws(() => padScript("; @pads 30:1 10:2"), /@pads/, "frames must increase");
  assert.throws(() => padScript("; @pads 0:$10000"), /@pads/, "value must fit 16 bits");
  assert.throws(() => padScript("; @pads 0:1\n; @pads 5:2"), /@pads/, "only one @pads line");
});

test("runConformance feeds the ROM's pad script to the machine", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-pads-"));
  try {
    const src = (script: string) => `${script}
        .org $0000
        .word start, 0, 0, 0, 0
        .header title="PADS SCRIPT TEST"
        .org $0040
start:  LD   R0, [VSTAT]          ; wait for vertical blank of frame 2 (PAD1 sampled at line 224)
        TSTW R0, #1
        BEQ  start
        ADDQ R2, #1
.low:   LD   R0, [VSTAT]
        TSTW R0, #1
        BNE  .low
        CMPW R2, #3
        BNE  start
        LD   R0, [PAD1]
        ST   R0, [$8000]
        STOP
`;
    // Frames 0, 1, 2 sample 0, 0, $600D & $FF = $0D at their line 224, so the word stored is $0D.
    const withPads = join(dir, "with.asm"), without = join(dir, "without.asm");
    writeFileSync(withPads, src("; @pads 2:$0D"));
    writeFileSync(without, src(""));
    assert.equal(runConformance(withPads).code, 0x0d);
    assert.equal(runConformance(without).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
