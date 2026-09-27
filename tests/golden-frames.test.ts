// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Golden-frame regression (tools/golden-frames.ts), in the spirit of Dolphin's FifoCI and mGBA's
// CInema: every replay-backed cartridge is played from power-on and the rendered picture at fixed
// checkpoints must hash to tests/golden/frames.json. The machine state hash of a replay does not
// cover the renderer's output, so this catches video regressions the replays cannot. The long
// replays are checked on the completion runs their own test files make (CHECKED_IN_GAME_TEST
// below, goldenRecorder); this file plays the rest, so it stays in the fast tier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  W, H, frameHash, encodeFramePng, decodeFramePng, diffFrames, defaultCheckpoints, renderCheckpoints,
  checkGolden, goldenRecorder, loadReplayRom, GOLDEN_FILE, type GoldenFile,
} from "../tools/golden-frames.ts";
import { replayFiles, padsFromEntries, type ReplayFile } from "../tools/replay.ts";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";

const frame = (fill = 0) => new Uint32Array(W * H).fill(fill);

test("frame hash: 16 hex digits, changes when any one pixel changes", () => {
  const a = frame(0x123456), b = frame(0x123456);
  assert.match(frameHash(a), /^[0-9a-f]{16}$/);
  assert.equal(frameHash(a), frameHash(b));
  b[W * H - 1] = 0x123457;
  assert.notEqual(frameHash(a), frameHash(b));
  // Only the 24 colour bits count (the renderer never sets the top byte).
  const c = frame(0x123456); c[0] |= 0xff000000;
  assert.equal(frameHash(a), frameHash(c));
});

test("PNG: a frame survives encode → decode exactly, and decode rejects other images", () => {
  const f = frame();
  for (let i = 0; i < f.length; i++) f[i] = (i * 2654435761) & 0xffffff;
  const png = encodeFramePng(f);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(decodeFramePng(png), f);
  assert.throws(() => decodeFramePng(Buffer.from("not a png")), /PNG/);
});

test("diff: counts differing pixels and marks them in the diff image", () => {
  const a = frame(0x000000), b = frame(0x000000);
  b[5] = 0xffffff; b[W * 10 + 3] = 0x010000;
  const d = diffFrames(a, b);
  assert.equal(d.count, 2);
  assert.equal(d.image[5], 0xff00ff);
  assert.equal(d.image[W * 10 + 3], 0xff00ff);
  assert.notEqual(d.image[0], 0xff00ff);
  assert.deepEqual(d.box, { x0: 3, y0: 0, x1: 5, y1: 10 });
});

test("default checkpoints: early, quartiles and the final frame, sorted and unique", () => {
  assert.deepEqual(defaultCheckpoints(2521), [60, 630, 1261, 1891, 2521]);
  assert.deepEqual(defaultCheckpoints(40), [10, 20, 30, 40]);
  assert.deepEqual(defaultCheckpoints(1), [1]);
});

test("checkpoint frames equal an independent power-on run of the same replay", async () => {
  const file = replayFiles().find(f => f.includes("slice-test"))!;
  const r = JSON.parse(readFileSync(file, "utf8")) as ReplayFile;
  const rom = await loadReplayRom(r);
  const shots = renderCheckpoints(rom, r.pads, [30, 100]);
  const m = new Machine(rom, { cpu: new Tally() }), input = padsFromEntries(r.pads);
  for (let f = 0; f < 100; f++) {
    const [a, b] = input(f); m.runFrame(a, b);
    if (f + 1 === 30) assert.equal(frameHash(m.framebuffer), frameHash(shots.get(30)!));
  }
  assert.equal(frameHash(m.framebuffer), frameHash(shots.get(100)!));
});

/** Replay-backed cartridges whose golden frames are checked on the completion run their own test
 *  file already makes (goldenRecorder), so each long replay is emulated once in the test tier:
 *  every test file that calls goldenRecorder("<rom>"). Every other replay-backed cartridge,
 *  including any new one, is played here, and must be short (a long one gets its own test). */
const CHECKED_IN_GAME_TEST: Record<string, string> = Object.fromEntries(readdirSync("tests")
  .filter(f => f.endsWith(".test.ts") && f !== "golden-frames.test.ts")
  .flatMap(f => [...readFileSync(`tests/${f}`, "utf8").matchAll(/goldenRecorder\("([\w-]+)"\)/g)].map(m => [m[1], `tests/${f}`])));
const PLAYED_HERE_MAX_FRAMES = 1000;

test("committed goldens: every replay has entries, reference PNGs match their hashes, and every frame is checked", async () => {
  const golden = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as GoldenFile;
  const replays = replayFiles().map(f => (JSON.parse(readFileSync(f, "utf8")) as ReplayFile).rom);
  assert.deepEqual(Object.keys(golden.replays).sort(), [...replays].sort(), "each replay-backed cartridge has golden frames (node tools/golden-frames.ts --update)");
  for (const [rom, g] of Object.entries(golden.replays)) {
    assert.ok(Object.keys(g.frames).length >= 3, `${rom}: at least 3 checkpoints`);
    for (const [at, hash] of Object.entries(g.frames)) {
      const png = join("tests/golden/frames", `${rom}@${at}.png`);
      assert.ok(existsSync(png), `${png} exists`);
      assert.equal(frameHash(decodeFramePng(readFileSync(png))), hash, `${png} matches frames.json`);
    }
  }
  // a tree without a game (the open export has no first-party titles) has neither its replay nor
  // its test; wherever the replay exists, its goldens are checked in that game's test
  for (const [rom, file] of Object.entries(CHECKED_IN_GAME_TEST).filter(([rom]) => replays.includes(rom))) {
    assert.ok(rom in golden.replays, `${rom} has golden frames`);
    const src = readFileSync(file, "utf8");
    assert.ok(src.includes(`goldenRecorder("${rom}")`), `${file} checks ${rom}'s golden frames on its completion run`);
    assert.ok(src.includes(".results()"), `${file} asserts the recorder's results`);
  }
  const here = Object.keys(golden.replays).filter(rom => !(rom in CHECKED_IN_GAME_TEST));
  assert.ok(here.includes("slice-test"));
  for (const rom of here) {
    const frames = (JSON.parse(readFileSync(golden.replays[rom].replay, "utf8")) as ReplayFile).frames;
    assert.ok(frames <= PLAYED_HERE_MAX_FRAMES, `${rom}: a ${frames}-frame replay checks its goldens in its own test (goldenRecorder)`);
  }
  const out = mkdtempSync(join(tmpdir(), "golden-"));
  try {
    const results = await checkGolden({ outDir: out, only: here });
    const bad = results.filter(r => !r.pass);
    assert.deepEqual(bad.map(r => `${r.rom}@${r.frame}: ${r.detail}`), []);
    assert.equal(results.length, here.reduce((n, rom) => n + Object.keys(golden.replays[rom].frames).length, 0));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("goldenRecorder: checks a run the caller makes; a wrong frame fails with PNGs, a checkpoint never reached fails", async () => {
  const golden = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as GoldenFile;
  const g = golden.replays["slice-test"];
  const r = JSON.parse(readFileSync(g.replay, "utf8")) as ReplayFile;
  const rom = await loadReplayRom(r);
  const dir = mkdtempSync(join(tmpdir(), "golden-rec-"));
  try {
    const at = Object.keys(g.frames).map(Number).sort((a, b) => a - b);
    const tampered = join(dir, "frames.json");
    writeFileSync(tampered, JSON.stringify({ ...golden, replays: { "slice-test": { ...g, frames: { ...g.frames, [at[1]]: "0000000000000000" } } } }));
    const good = goldenRecorder("slice-test"), bad = goldenRecorder("slice-test", { goldenFile: tampered, outDir: join(dir, "out") });
    const short = goldenRecorder("slice-test", { outDir: join(dir, "out") });
    assert.deepEqual(good.checkpoints, at);
    const m = new Machine(rom, { cpu: new Tally() }), input = padsFromEntries(r.pads);
    for (let f = 0; f < r.frames; f++) {
      const [a, b] = input(f); m.runFrame(a, b);
      good.capture(f + 1, m.framebuffer); bad.capture(f + 1, m.framebuffer);
      if (f + 1 < at[at.length - 1]) short.capture(f + 1, m.framebuffer);
    }
    assert.deepEqual(good.results().filter(x => !x.pass), []);
    assert.equal(good.results().length, at.length);
    const b = bad.results().filter(x => !x.pass);
    assert.deepEqual(b.map(x => x.frame), [at[1]]);
    assert.match(b[0].detail, /hash [0-9a-f]{16}, expected 0000000000000000/);
    for (const kind of ["actual", "expected", "diff"]) assert.ok(existsSync(join(dir, "out", `slice-test@${at[1]}.${kind}.png`)), `${kind} PNG written`);
    const s = short.results().filter(x => !x.pass);
    assert.deepEqual(s.map(x => x.frame), [at[at.length - 1]]);
    assert.match(s[0].detail, /never captured/);
    assert.throws(() => goldenRecorder("no-such-rom"), /no golden frames/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a mismatch fails and writes actual, expected and diff PNGs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "golden-"));
  try {
    const golden = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as GoldenFile;
    const g = golden.replays["slice-test"];
    const at = Object.keys(g.frames)[1];
    g.frames[at] = "0000000000000000";
    const tampered = join(dir, "frames.json");
    writeFileSync(tampered, JSON.stringify({ ...golden, replays: { "slice-test": g } }));
    const results = await checkGolden({ goldenFile: tampered, outDir: join(dir, "out") });
    const bad = results.filter(r => !r.pass);
    assert.equal(bad.length, 1);
    assert.equal(bad[0].frame, Number(at));
    assert.match(bad[0].detail, /hash [0-9a-f]{16}, expected 0000000000000000/);
    for (const kind of ["actual", "expected", "diff"]) {
      const f = join(dir, "out", `slice-test@${at}.${kind}.png`);
      assert.ok(existsSync(f), `${f} written`);
      decodeFramePng(readFileSync(f));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
