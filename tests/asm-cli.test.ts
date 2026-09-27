// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// tools/asm.ts command-line wrapper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const TOOL = join(import.meta.dirname, "..", "tools", "asm.ts");
const run = (args: string[]) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", TOOL, ...args], { encoding: "utf8" });

test("asm CLI: writes ROM, symbols and listing; exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "cyasm-"));
  try {
    mkdirSync(join(dir, "inc"));
    writeFileSync(join(dir, "inc", "k.asm"), "K = 7\n");
    writeFileSync(join(dir, "game.asm"), '.include "inc/k.asm"\n.header title="T"\n.org 0\n.word start\n.org $100\nstart: MOV R1, #K\n STOP\n');
    const r = run([join(dir, "game.asm"), "-o", join(dir, "game.rom"), "--sym", join(dir, "game.sym"), "--lst", join(dir, "game.lst")]);
    assert.equal(r.status, 0, r.stderr);
    const rom = readFileSync(join(dir, "game.rom"));
    assert.equal(rom.length, 32768);
    assert.equal(rom.subarray(0x10, 0x14).toString("latin1"), "CYCL");
    assert.match(readFileSync(join(dir, "game.sym"), "utf8"), /0100\s+start/);
    assert.match(readFileSync(join(dir, "game.lst"), "utf8"), /MOV R1, #K/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("asm CLI: reports errors as file:line and exits 1 without writing output", () => {
  const dir = mkdtempSync(join(tmpdir(), "cyasm-"));
  try {
    writeFileSync(join(dir, "bad.asm"), "NOP\nFROB R1\n");
    const r = run([join(dir, "bad.asm"), "-o", join(dir, "bad.rom")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bad\.asm:2: .*FROB/);
    assert.equal(existsSync(join(dir, "bad.rom")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("asm CLI: usage error exits 1", () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage/i);
});

test("asm CLI: builds the open cartridges, generated art and music includes too, to the manifest's bytes", () => {
  const manifest = JSON.parse(readFileSync("roms/manifest.json", "utf8")).roms as Record<string, { source: string; sha256: string }>;
  const dir = mkdtempSync(join(tmpdir(), "cyasm-"));
  try {
    for (const name of ["lantern-test", "sound-test"]) {
      const out = join(dir, `${name}.rom`);
      const r = run([manifest[name].source, "-o", out]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(createHash("sha256").update(readFileSync(out)).digest("hex"), manifest[name].sha256, name);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("asm CLI: creates the output folder (and those of --sym and --lst) when it does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "cyasm-"));
  try {
    const r = run(["roms/lantern-test/lantern-test.asm", "-o", join(dir, "new", "out.rom"), "--sym", join(dir, "s", "out.sym"), "--lst", join(dir, "l", "out.lst")]);
    assert.equal(r.status, 0, r.stderr);
    for (const f of [join(dir, "new", "out.rom"), join(dir, "s", "out.sym"), join(dir, "l", "out.lst")]) assert.ok(existsSync(f), f);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("asm CLI --sym: labels carry their bank as well as their address (manual ch. 8); constants only a value", () => {
  const dir = mkdtempSync(join(tmpdir(), "cyasm-"));
  try {
    writeFileSync(join(dir, "b.asm"), '.header title="B"\n.org 0\n.word start\nK = $1234\n.org $100\nstart: STOP\n.bank 3\n.org $4000\nfar: RTS\n');
    const r = run([join(dir, "b.asm"), "-o", join(dir, "b.rom"), "--sym", join(dir, "b.sym")]);
    assert.equal(r.status, 0, r.stderr);
    const sym = readFileSync(join(dir, "b.sym"), "utf8").trim().split("\n");
    assert.ok(sym.includes("00:0100 start"), sym.join(" | "));
    assert.ok(sym.includes("03:4000 far"), sym.join(" | "));
    assert.ok(sym.includes("1234 K"), sym.join(" | "));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
