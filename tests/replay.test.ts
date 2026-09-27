// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Deterministic completion replays (tools/replay.ts). The REPLAY FIXTURE cartridge is won by
// pressing A, B, START in order; a recorded replay must pass, and every kind of tampering
// (input, expected hash, ROM hash, manifest, altered ROM, win value) must be detected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { judgeReplay, play, prepareReplay, recordReplay, runReplay, padsFromEntries, type ReplayFile, type PadEntry } from "../tools/replay.ts";
import { buildOne, sha256, type RomSource } from "../tools/build-roms.ts";
import { runRom } from "../tools/conformance.ts";

const source: RomSource = { name: "replay-fixture", file: "tests/fixtures/replay-win.asm", lang: "asm" };
const rom = buildOne(source);
const dir = mkdtempSync(join(tmpdir(), "replay-"));
const manifest = join(dir, "manifest.json");
writeFileSync(manifest, JSON.stringify({ roms: { "replay-fixture": { source: source.file, bytes: rom.length, sha256: sha256(rom) } } }));

// A (frames 10-11), B (20-21), START (30-31); won at the VBLANK of frame 30 (TICKS 31)
const PADS: PadEntry[] = [[10, 16, 0], [12, 0, 0], [20, 32, 0], [22, 0, 0], [30, 128, 0], [32, 0, 0]];
const WIN = { addr: "$8000", value: "$0002", note: "GSTATE = WON after A, B, START" };
const opts = { source, manifest, dir };

const record = async () => recordReplay("replay-fixture", PADS, 60, WIN, opts);
const tampered = (f: string, change: (r: ReplayFile) => void) => {
  const r = JSON.parse(readFileSync(f, "utf8")) as ReplayFile;
  change(r);
  const out = join(dir, `t${Math.random().toString(36).slice(2)}.replay.json`);
  writeFileSync(out, JSON.stringify(r));
  return out;
};

test("padsFromEntries: run-length input, 0 before the first entry", () => {
  const p = padsFromEntries([[3, 8, 1], [5, 0, 2]]);
  assert.deepEqual([0, 2, 3, 4, 5, 99].map(p), [[0, 0], [0, 0], [8, 1], [8, 1], [0, 2], [0, 2]]);
  assert.throws(() => padsFromEntries([[5, 0, 0], [5, 1, 0]]), /increase/);
  assert.throws(() => padsFromEntries([[0, 256, 0]]), /0-255/);
});

/** The original padsFromEntries lookup (a scan of every entry on every call), kept as the reference. */
const scanLookup = (entries: PadEntry[]) => (frame: number): [number, number] => {
  let v: [number, number] = [0, 0];
  for (const [f, a, b] of entries) { if (f > frame) break; v = [a, b]; }
  return v;
};

test("padsFromEntries: identical to a scan of every entry, for increasing, repeated and backward lookups", () => {
  let seed = 12345;
  const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  for (let trial = 0; trial < 40; trial++) {
    const entries: PadEntry[] = [];
    for (let f = rnd(5); entries.length < 1 + rnd(60); f += 1 + rnd(40)) entries.push([f, rnd(256), rnd(256)]);
    const last = entries[entries.length - 1][0] + 50;
    const fast = padsFromEntries(entries), slow = scanLookup(entries);
    const frames: number[] = [];
    for (let f = -3; f <= last; f++) frames.push(f);                           // every frame in order
    for (let k = 0; k < 300; k++) frames.push(rnd(last + 10) - 5);             // then jumps both ways
    for (let k = 0; k < 50; k++) { const f = rnd(last); frames.push(f, f, f + 1, f - 1); }
    for (const f of frames) assert.deepEqual(fast(f), slow(f), `trial ${trial}, frame ${f}`);
  }
  assert.deepEqual(padsFromEntries([])(7), [0, 0]);
});

test("padsFromEntries: a whole run of increasing frames reads each entry a bounded number of times", () => {
  const entries: PadEntry[] = [];
  for (let f = 0; f < 20000; f += 10) entries.push([f, f % 256, 0]);
  let reads = 0;
  const counted = new Proxy(entries, { get(t, k, r) { if (typeof k === "string" && /^\d+$/.test(k)) reads++; return Reflect.get(t, k, r); } });
  const input = padsFromEntries(counted);
  reads = 0;                                                                     // validation is one pass, not per frame
  for (let f = 0; f < 20000; f++) input(f);
  assert.ok(reads <= 3 * (20000 + entries.length), `${reads} entry reads for 20,000 frames over ${entries.length} entries`);
});

test("record then replay: passes, and matches an independent plain run", async () => {
  const f = await record();
  assert.equal(f, join(dir, "replay-fixture.replay.json"));
  const j = JSON.parse(readFileSync(f, "utf8")) as ReplayFile;
  assert.equal(j.rom, "replay-fixture");
  assert.equal(j.romSha256, sha256(rom));
  assert.equal(j.frames, 60);
  assert.deepEqual(j.pads, PADS);
  assert.deepEqual(j.expect.win, { addr: "$8000", value: "$0002" });
  assert.equal(j.expect.note, WIN.note);
  const plain = runRom(rom, 60, padsFromEntries(PADS)).m;
  assert.equal(j.expect.hash, plain.hash());
  assert.equal(plain.wram[8] | (plain.wram[9] << 8), 31, "won at the 31st VBLANK");

  const r = await runReplay(f, opts);
  assert.equal(r.pass, true, r.detail);
  assert.equal(r.hash, plain.hash());
  assert.equal(r.winValue, 2);
  assert.equal(r.detail, "ok");
});

test("prepare + judge (the budget tool's path): same verdict as runReplay, only on exactly the replay's frame count", async () => {
  const f = await record();
  const p = await prepareReplay(f, opts);
  assert.ok(p.ready);
  assert.deepEqual(judgeReplay(p, play(rom, PADS, 60)), await runReplay(f, opts));
  const short = judgeReplay(p, play(rom, PADS, 59));
  assert.equal(short.pass, false);
  assert.match(short.detail, /played 59 frames, the replay has 60/);
  const bad = await prepareReplay(tampered(f, r => { r.romSha256 = "0".repeat(64); }), opts);
  assert.ok(!bad.ready);
  assert.match(bad.result.detail, /sha/i);
});

test("recording refuses an input that does not reach the win state", async () => {
  await assert.rejects(recordReplay("replay-fixture", PADS.slice(0, 4), 60, WIN, opts), /win/);
});

test("a missing button press is detected (no win)", async () => {
  const f = tampered(await record(), r => { r.pads = r.pads.filter(([fr]) => fr !== 20); });
  const r = await runReplay(f, opts);
  assert.equal(r.pass, false);
  assert.notEqual(r.winValue, 2);
  assert.match(r.detail, /win/);
});

test("a press one frame late still wins but ends in another state: hash mismatch", async () => {
  const f = tampered(await record(), r => { r.pads = r.pads.map(([fr, a, b]) => (fr >= 30 ? [fr + 1, a, b] : [fr, a, b]) as PadEntry); });
  const r = await runReplay(f, opts);
  assert.equal(r.winValue, 2);
  assert.equal(r.pass, false);
  assert.match(r.detail, /hash/);
});

test("a wrong expected hash, frame count or win value is detected", async () => {
  const base = await record();
  for (const change of [
    (r: ReplayFile) => { r.expect.hash = "00000000"; },
    (r: ReplayFile) => { r.frames += 1; },
    (r: ReplayFile) => { r.expect.win.value = "$0001"; },
  ]) {
    const r = await runReplay(tampered(base, change), opts);
    assert.equal(r.pass, false, r.detail);
  }
});

test("ROM identity: replay sha, manifest sha and an altered ROM are all detected", async () => {
  const base = await record();
  const s = await runReplay(tampered(base, r => { r.romSha256 = "0".repeat(64); }), opts);
  assert.equal(s.pass, false);
  assert.match(s.detail, /sha/i);

  const badManifest = join(dir, "bad-manifest.json");
  writeFileSync(badManifest, JSON.stringify({ roms: { "replay-fixture": { sha256: "f".repeat(64) } } }));
  const m = await runReplay(base, { ...opts, manifest: badManifest });
  assert.equal(m.pass, false);
  assert.match(m.detail, /manifest/);

  const missing = join(dir, "empty-manifest.json");
  writeFileSync(missing, JSON.stringify({ roms: {} }));
  assert.match((await runReplay(base, { ...opts, manifest: missing })).detail, /manifest/);

  // an altered ROM (a debug "win on A" build, say) no longer matches the recorded SHA-256
  const altered = join(dir, "replay-win.asm");
  copyFileSync(source.file, altered);
  writeFileSync(altered, readFileSync(altered, "utf8").replace("CMP  R2, #3", "CMP  R2, #1"));
  const a = await runReplay(base, { ...opts, source: { ...source, file: altered } });
  assert.equal(a.pass, false);
  assert.match(a.detail, /sha/i);
});

test("CLI: no replay files is a clean exit; a failing replay exits non-zero", () => {
  const node = [process.execPath, "--disable-warning=ExperimentalWarning", "tools/replay.ts"];
  const empty = mkdtempSync(join(tmpdir(), "replays-empty-"));
  const e = spawnSync(node[0], [...node.slice(1), "--dir", empty], { encoding: "utf8" });
  assert.equal(e.status, 0, e.stdout + e.stderr);
  assert.match(e.stdout, /no replay files/);

  const one = mkdtempSync(join(tmpdir(), "replays-one-"));
  const lantern = readFileSync("roms/manifest.json", "utf8");
  const sha = JSON.parse(lantern).roms["lantern-test"].sha256;
  writeFileSync(join(one, "lantern-test.replay.json"), JSON.stringify({
    rom: "lantern-test", romSha256: sha, pads: [], frames: 5,
    expect: { hash: "00000000", win: { addr: "$8000", value: "$0000" }, note: "deliberately wrong hash" },
  }));
  const f = spawnSync(node[0], [...node.slice(1), "--dir", one], { encoding: "utf8" });
  assert.equal(f.status, 1, f.stdout + f.stderr);
  assert.match(f.stdout, /FAIL\s+lantern-test/);
});

// SLICE gate finding: the CLI guard matched any importer whose file name ends in "replay.ts"
// (tools/slice-replay.ts), so importing the module ran the replay CLI and exited the importer.
test("CLI guard: importing tools/replay.ts from a script named *-replay.ts does not run the CLI", () => {
  const d = mkdtempSync(join(tmpdir(), "replay-import-"));
  const script = join(d, "my-replay.ts");
  writeFileSync(script, `import { runReplay } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "tools/replay.ts")).href)};\nconsole.log("imported", typeof runReplay);\n`);
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /imported function/);
  assert.doesNotMatch(r.stdout, /replay:/, "the replay CLI must not run on import");
});
