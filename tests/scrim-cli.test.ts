// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// tools/scrim.ts command-line wrapper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const TOOL = join(import.meta.dirname, "..", "tools", "scrim.ts");
const run = (args: string[]) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", TOOL, ...args], { encoding: "utf8" });

test("scrim CLI: writes the ROM and optional assembly; exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "scrim-"));
  try {
    writeFileSync(join(dir, "blob.bin"), new Uint8Array([1, 2, 3, 4]));
    writeFileSync(join(dir, "game.scr"), 'PROGRAM Game;\nDATA b: ARRAY OF BYTE = INCBIN "blob.bin";\nVAR x: WORD;\nBEGIN x := b[2] END.\n');
    const r = run([join(dir, "game.scr"), "-o", join(dir, "game.rom"), "--asm", join(dir, "game.asm")]);
    assert.equal(r.status, 0, r.stderr);
    const rom = readFileSync(join(dir, "game.rom"));
    assert.equal(rom.length, 32768);
    assert.equal(rom.subarray(0x10, 0x14).toString("latin1"), "CYCL");
    assert.match(readFileSync(join(dir, "game.asm"), "utf8"), /__start:/);
    assert.match(r.stdout, /game\.rom/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scrim CLI: reports errors as file:line:col and exits 1 without writing output", () => {
  const dir = mkdtempSync(join(tmpdir(), "scrim-"));
  try {
    writeFileSync(join(dir, "bad.scr"), "PROGRAM Bad;\nBEGIN\n  x := 1\nEND.\n");
    const r = run([join(dir, "bad.scr"), "-o", join(dir, "bad.rom")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bad\.scr:3:3: error: .*'x'/);
    assert.equal(existsSync(join(dir, "bad.rom")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scrim CLI: usage error exits 1", () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage/i);
});

test("scrim CLI: builds the open SCRIM cartridges, with their art and music assets, to the manifest's bytes", () => {
  const manifest = JSON.parse(readFileSync("roms/manifest.json", "utf8")).roms as Record<string, { source: string; sha256: string }>;
  const dir = mkdtempSync(join(tmpdir(), "scrim-"));
  try {
    for (const name of ["lantern-scrim", "slice-test"]) {
      const out = join(dir, `${name}.rom`);
      const r = run([manifest[name].source, "-o", out]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(createHash("sha256").update(readFileSync(out)).digest("hex"), manifest[name].sha256, name);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scrim CLI: creates the output folder (and that of --asm) when it does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "scrim-"));
  try {
    const r = run(["roms/lantern-scrim/lantern-scrim.scr", "-o", join(dir, "new", "out.rom"), "--asm", join(dir, "a", "out.asm")]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, "new", "out.rom")) && existsSync(join(dir, "a", "out.asm")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
