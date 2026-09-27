// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Save states v2 (src/machine/savestate.ts, docs/spec-notes.md "Save-state format"): the state names the ROM it
// belongs to by SHA-256, loading validates everything before it changes the machine, a failed load
// leaves the machine bit-identical, v1 states load only on explicit opt-in, and Machine.hash()
// stays FNV-1a over the v1 layout so every replay, golden frame and manifest hash is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";
import { sha256, toHex } from "../src/machine/sha256.ts";
import { SaveStateError, romSha256, saveStateInfo, type SaveStateErrorKind } from "../src/machine/savestate.ts";
import { buildAll } from "../tools/build-roms.ts";

const nodeSha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const manifest = JSON.parse(readFileSync("roms/manifest.json", "utf8")).roms as Record<string, { sha256: string }>;
const ROMS = buildAll();

function running(name: string, frames: number, pad = 0): Machine {
  const m = new Machine(ROMS[name], { cpu: new Tally() });
  for (let f = 0; f < frames; f++) m.runFrame(f % 7 === 0 ? pad : 0, 0);
  return m;
}
const fnv = (bytes: Uint8Array) => { let h = 2166136261; for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0; return h.toString(16).padStart(8, "0"); };
const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true);
const put32 = (b: Uint8Array, o: number, v: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(o, v, true);

/** Load must throw a SaveStateError of `kind` and leave every byte of machine state as it was. */
function rejects(m: Machine, bytes: Uint8Array, kind: SaveStateErrorKind, opts?: { allowUnverifiedV1?: boolean }) {
  const before = m.saveStateV1(), h = m.hash();
  assert.throws(() => m.loadState(bytes, opts), (e: unknown) => e instanceof SaveStateError && e.kind === kind, `expected ${kind}`);
  assert.equal(m.hash(), h, `hash changed after a ${kind} failure`);
  assert.deepEqual(m.saveStateV1(), before);
}

// ------------------------------------------------------------------ SHA-256
test("sha256 equals node:crypto on the empty input, \"abc\", block boundaries and a 1 MiB buffer", () => {
  assert.equal(toHex(sha256(new Uint8Array(0))), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(toHex(sha256(new TextEncoder().encode("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 131 + n) & 0xff);
    assert.equal(toHex(sha256(b)), nodeSha(b), `length ${n}`);
  }
  let x = 0x12345678;
  const big = Uint8Array.from({ length: 1 << 20 }, () => { x = Math.imul(x ^ (x >>> 13), 0x5bd1e995) >>> 0; return x & 0xff; });
  assert.equal(toHex(sha256(big)), nodeSha(big));
});

test("sha256 of every ROM in the manifest equals node:crypto and the manifest entry", () => {
  assert.deepEqual(Object.keys(manifest).sort(), Object.keys(ROMS).sort(), "the manifest lists every ROM the build makes");
  assert.ok(Object.keys(manifest).some(n => n.startsWith("conformance/")) && "lantern-test" in manifest);
  for (const [name, entry] of Object.entries(manifest)) {
    assert.equal(toHex(sha256(ROMS[name])), nodeSha(ROMS[name]), name);
    assert.equal(toHex(sha256(ROMS[name])), entry.sha256, name);
  }
});

test("the ROM identity is computed once per ROM, not per save", () => {
  const rom = ROMS["lantern-test"];
  assert.equal(romSha256(rom), romSha256(rom));                       // the same cached array
  const m = new Machine(rom, { cpu: new Tally() });
  assert.equal(m.romSha256, manifest["lantern-test"].sha256);
  const patched = rom.slice(); patched[0x7ff0] ^= 1;
  assert.notEqual(new Machine(patched, { cpu: new Tally() }).romSha256, m.romSha256);
});

// ------------------------------------------------------------------ format
test("hash() is FNV-1a of the v1 serialization, which keeps the v1 layout", () => {
  const m = running("lantern-test", 12, 0x10);
  const v1 = m.saveStateV1();
  assert.equal(m.hash(), fnv(v1));
  assert.equal(u32(v1, 0), 0x43594353);
  assert.equal(u32(v1, 4), 1);
  assert.equal(u32(v1, 8), 8);
  const lens = Array.from({ length: 8 }, (_, i) => u32(v1, 12 + 4 * i));
  assert.equal(v1.length, 12 + 32 + lens.reduce((a, b) => a + b, 0));
});

test("a v2 state is magic, version 2, the ROM's SHA-256, part count and lengths, then the v1 body", () => {
  const m = running("sound-test", 10);
  const v1 = m.saveStateV1(), v2 = m.saveState();
  assert.equal(u32(v2, 0), 0x43594353);
  assert.equal(u32(v2, 4), 2);
  assert.equal(toHex(v2.subarray(8, 40)), manifest["sound-test"].sha256);
  assert.deepEqual(v2.subarray(40), v1.subarray(8));                   // count, lengths, parts
  assert.deepEqual(saveStateInfo(v2), { version: 2, romSha256: manifest["sound-test"].sha256 });
  assert.deepEqual(saveStateInfo(v1), { version: 1, romSha256: null });
  assert.equal(m.hash(), fnv(v1));                                     // header fields not hashed
});

test("a v2 state round trips into a fresh machine of the same ROM and continues identically", () => {
  const a = running("slice-test", 15, 0x80);
  const s = a.saveState(), h = a.hash();
  const b = new Machine(ROMS["slice-test"], { cpu: new Tally() });
  b.loadState(s);
  assert.equal(b.hash(), h);
  a.runFrame(0x20, 0); b.runFrame(0x20, 0);
  assert.equal(b.hash(), a.hash());
});

// ------------------------------------------------------------------ rejection, machine unchanged
test("wrong-ROM probe: a lantern-scrim state loaded into lantern-test fails with wrong-rom", () => {
  const scrim = running("lantern-scrim", 8).saveState();
  const m = running("lantern-test", 8);
  rejects(m, scrim, "wrong-rom");
  try { m.loadState(scrim); } catch (e) { assert.equal((e as SaveStateError).stateRomSha256, manifest["lantern-scrim"].sha256); }
  const patched = ROMS["lantern-test"].slice(); patched[0x7ff0] ^= 1;
  rejects(new Machine(patched, { cpu: new Tally() }), m.saveState(), "wrong-rom");
});

test("truncation probe: every cut of a state fails with truncated and the hash unchanged", () => {
  const good = running("lantern-test", 8).saveState();
  const m = running("lantern-test", 16, 0x40);
  for (const cut of [0, 3, 4, 7, 8, 20, 39, 40, 43, 44, 60, 71, 72, 100, 16000, 40000, good.length - 27, good.length - 1])
    rejects(m, good.subarray(0, cut), "truncated");
  rejects(m, running("lantern-test", 8).saveStateV1().subarray(0, 500), "truncated", { allowUnverifiedV1: true });
});

test("corrupt states fail with corrupt and the machine unchanged, even when only the CPU or audio part is bad", () => {
  const good = running("sound-test", 8).saveState();
  const m = running("sound-test", 16, 0x01);
  const lensAt = 44, partsAt = 44 + 32;
  const lens = Array.from({ length: 8 }, (_, i) => u32(good, lensAt + 4 * i));
  const partStart = (k: number) => partsAt + lens.slice(0, k).reduce((a, b) => a + b, 0);
  const edit = (f: (b: Uint8Array) => void) => { const b = good.slice(); f(b); return b; };
  rejects(m, edit(b => { b[0] ^= 0xff; }), "corrupt");                                    // magic
  rejects(m, edit(b => put32(b, 40, 9)), "corrupt");                                        // part count
  rejects(m, edit(b => { put32(b, lensAt + 4, lens[1] - 2); put32(b, lensAt + 8, lens[2] + 2); }), "corrupt"); // part lengths
  const long = new Uint8Array(good.length + 4); long.set(good);
  rejects(m, long, "corrupt");                                                              // trailing bytes
  rejects(m, edit(b => { b[partStart(6)] = 0x7f; }), "corrupt");                            // CPU state version
  rejects(m, edit(b => { b[partStart(6) + 1] = 9; }), "corrupt");                           // CPU mode
  rejects(m, edit(b => { b[partStart(7)] ^= 0xff; }), "corrupt");                           // audio magic
  rejects(m, edit(b => { put32(b, partStart(0) + 4 * 13, 0xffffffff); }), "corrupt");       // register beyond its mask
});

test("unknown versions fail with unsupported-version; v1 needs an explicit opt-in", () => {
  const src = running("slice-test", 8);
  const v1 = src.saveStateV1(), h = src.hash();
  const m = running("slice-test", 16, 0x08);
  const v3 = src.saveState(); put32(v3, 4, 3);
  rejects(m, v3, "unsupported-version");
  const v0 = v1.slice(); put32(v0, 4, 0);
  rejects(m, v0, "unsupported-version");
  rejects(m, v1, "unverified-v1");
  m.loadState(v1, { allowUnverifiedV1: true });
  assert.equal(m.hash(), h);
  assert.throws(() => saveStateInfo(v3), (e: unknown) => e instanceof SaveStateError && e.kind === "unsupported-version");
});

test("a failed load keeps the audio output that was not yet taken", () => {
  const m = running("sound-test", 10, 0x10);
  m.audio.takeSamples();
  m.runFrame(0, 0);                                                   // one frame of samples, not taken
  const bad = running("sound-test", 10).saveState(); bad[bad.length - 77] ^= 0xff;   // Cue state magic
  rejects(m, bad, "corrupt");
  assert.ok(m.audio.takeSamples().length > 0, "pending samples were dropped by a failed load");
});
