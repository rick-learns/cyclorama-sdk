// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Reproducible ROM builds: every ROM builds from source; two builds are byte-identical;
// hashes match the committed manifest (roms/manifest.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { discoverRoms, buildAll, sha256 } from "../tools/build-roms.ts";

test("discovers cartridges and conformance ROMs", () => {
  const names = discoverRoms().map(r => r.name);
  assert.ok(names.includes("lantern-test"));
  assert.ok(names.includes("conformance/12-light-field"));
});

test("two builds are byte-identical and match the committed manifest", () => {
  const a = buildAll(), b = buildAll();
  const manifest = JSON.parse(readFileSync("roms/manifest.json", "utf8"));
  assert.deepEqual(Object.keys(a).sort(), Object.keys(manifest.roms).sort(), "manifest lists every ROM");
  for (const [name, rom] of Object.entries(a)) {
    assert.equal(sha256(rom), sha256(b[name]), `${name} not reproducible`);
    assert.equal(sha256(rom), manifest.roms[name].sha256, `${name} differs from manifest`);
    assert.equal(rom.length, manifest.roms[name].bytes);
  }
  assert.equal(manifest.toolchain.node, readFileSync(".nvmrc", "utf8").trim());
});
