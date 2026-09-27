// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Version 1 save states written before the v2 format (tests/fixtures/savestate-v1/, made by
// tools/savestate-v1-fixtures.ts from a deterministic replay prefix, never by hand) must keep
// loading, but only on explicit opt-in, since a v1 state cannot say which ROM it belongs to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";
import { SaveStateError, saveStateInfo } from "../src/machine/savestate.ts";
import { buildOne, discoverRoms } from "../tools/build-roms.ts";
import { FIXTURE_DIR, fixtureIndex, makeFixture, shippedRoms } from "../tools/savestate-v1-fixtures.ts";

const index = fixtureIndex();
const sources = discoverRoms();
const built = new Map<string, Uint8Array>();
const romOf = (name: string) => built.get(name) ?? built.set(name, buildOne(sources.find(s => s.name === name)!)).get(name)!;

test("every shipped ROM has a committed v1 state fixture", () => {
  const shipped = shippedRoms();
  assert.ok(shipped.includes("lantern-test") && shipped.includes("lantern-scrim"), `shipped ROMs: ${shipped.join(", ")}`);
  assert.deepEqual(Object.keys(index.states).sort(), shipped, "one fixture per shipped ROM, and none for a ROM the manifest lacks");
  for (const name of shipped) {
    assert.ok(index.states[name], `no fixture entry for ${name} (node tools/savestate-v1-fixtures.ts --write)`);
    assert.ok(existsSync(`${FIXTURE_DIR}/${name}.v1.state`), `${name}.v1.state missing`);
  }
});

for (const name of Object.keys(index.states)) {
  test(`v1 fixture ${name}: loads only with allowUnverifiedV1, to its recorded hash, and re-serializes byte-identically`, () => {
    const entry = index.states[name];
    const bytes = new Uint8Array(readFileSync(`${FIXTURE_DIR}/${name}.v1.state`));
    assert.deepEqual(saveStateInfo(bytes), { version: 1, romSha256: null });
    const m = new Machine(romOf(name), { cpu: new Tally() });
    const h0 = m.hash();
    assert.throws(() => m.loadState(bytes), (e: unknown) => e instanceof SaveStateError && e.kind === "unverified-v1");
    assert.equal(m.hash(), h0);
    m.loadState(bytes, { allowUnverifiedV1: true });
    assert.equal(m.hash(), entry.hash);
    assert.equal(m.frame, entry.frames);
    assert.deepEqual(m.saveStateV1(), bytes);
    const v2 = m.saveState();                                          // the next save is v2
    assert.deepEqual(saveStateInfo(v2), { version: 2, romSha256: m.romSha256 });
    m.runFrame(0, 0);                                                  // and the machine runs on
    assert.equal(m.frame, entry.frames + 1);
  });
}

// The fixtures stand for what saveState() wrote before v2. Loading and re-saving (above) cannot
// see a drift that the v1 writer and reader share (two scalars swapped in both, say), nor a fixture
// replaced by another consistent state, so each fixture is also rebuilt here the way
// tools/savestate-v1-fixtures.ts made it, from power-on through the pre-v2 writer (saveStateV1),
// and must come out byte for byte what is committed (DECISIONS 2026-09-27 [machine], note ii).
const firstDiff = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i;
  return -1;
};

for (const name of Object.keys(index.states)) {
  test(`v1 fixture ${name}: a fresh run through the pre-v2 writer reproduces the committed bytes and index entry`, () => {
    const committed = new Uint8Array(readFileSync(`${FIXTURE_DIR}/${name}.v1.state`));
    const { bytes, entry } = makeFixture(name);
    assert.deepEqual(entry, index.states[name], `${name}: index.json entry`);
    assert.equal(bytes.length, committed.length, `${name}: length`);
    const at = firstDiff(bytes, committed);
    assert.equal(at, -1, `${name}: fresh v1 bytes differ from ${name}.v1.state first at byte ${at}`);
    // The v2 state of that machine is the same bytes with version 2 and the ROM's SHA-256 inserted
    // after the version word (docs/spec-notes.md §12): v2 changed the header and nothing else.
    const m = new Machine(romOf(name), { cpu: new Tally() });
    m.loadState(committed, { allowUnverifiedV1: true });
    const v2 = m.saveState(), sha = Buffer.from(entry.romSha256, "hex");
    const expected = new Uint8Array(committed.length + 32);
    expected.set(committed.subarray(0, 8));
    expected[4] = 2;
    expected.set(sha, 8);
    expected.set(committed.subarray(8), 40);
    assert.equal(firstDiff(v2, expected), -1, `${name}: v2 = v1 with the ROM identity in its header`);
  });
}
