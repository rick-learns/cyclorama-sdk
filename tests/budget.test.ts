// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Budget reports (tools/budget.ts): cartridge class, measured CPU load, sprites per line,
// lights, audio voices. The BUDGET PROBE fixture breaks the rules in known amounts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetMeter, budgetReport, cartridgeReport, sizeClass, FRAME_CPU_CYCLES } from "../tools/budget.ts";
import { buildOne, discoverRoms, sha256 } from "../tools/build-roms.ts";
import { runRom } from "../tools/conformance.ts";
import { play } from "../tools/replay.ts";
import { MASTER_PER_FRAME, MASTER_PER_LINE } from "../src/machine/types.ts";

const probe = buildOne({ name: "budget-probe", file: "tests/fixtures/budget-probe.asm", lang: "asm" });
const lantern = buildOne(discoverRoms().find(s => s.name === "lantern-test")!);

test("frame budget comes from the timing constants: 59,736 CPU cycles", () => {
  assert.equal(FRAME_CPU_CYCLES, 59736);
});

test("size classes follow the manual's Standard and Deep boards", () => {
  const K = 1024;
  assert.deepEqual(sizeClass(16 * K), { board: "development", bytes: 16 * K, banks: 1, retail: false });
  assert.deepEqual(sizeClass(32 * K), { board: "Standard", bytes: 32 * K, banks: 2, retail: true });
  assert.deepEqual(sizeClass(48 * K), { board: "Standard", bytes: 64 * K, banks: 4, retail: true });
  assert.deepEqual(sizeClass(256 * K), { board: "Standard", bytes: 256 * K, banks: 16, retail: true });
  assert.deepEqual(sizeClass(272 * K), { board: "Deep", bytes: 512 * K, banks: 32, retail: true });
  assert.deepEqual(sizeClass(1024 * K), { board: "Deep", bytes: 1024 * K, banks: 64, retail: true });
  assert.equal(sizeClass(1040 * K), null);
});

test("cartridge report reads the CYCL header and checks it", () => {
  const c = cartridgeReport(lantern);
  assert.equal(c.bytes, 32768);
  assert.equal(c.banks, 2);
  assert.equal(c.header.magic, "CYCL");
  assert.equal(c.header.title, "LANTERN TEST");
  assert.equal(c.header.developer, "$0001");
  assert.equal(c.header.releaseDate, "1987-03-01");
  assert.equal(c.header.version, "1.00");
  assert.equal(c.header.generation, 0);
  assert.equal(c.header.cartRam, 0);
  assert.equal(c.header.checksumOk, true);
  assert.equal(c.fits, true);
  assert.deepEqual(c.sizeClass, { board: "Standard", bytes: 32768, banks: 2, retail: true });
  assert.deepEqual(c.violations, []);
});

test("cartridge violations: too big, bad checksum, Deep board before October 1990, RAM on a Standard board", () => {
  const big = new Uint8Array(2 * 1024 * 1024);
  big.set(lantern.subarray(0, 0x40));
  const b = cartridgeReport(big);
  assert.equal(b.fits, false);
  assert.ok(b.violations.some(v => /exceeds/.test(v)), b.violations.join("; "));

  const bad = lantern.slice(); bad[0x38] ^= 0xff;
  assert.ok(cartridgeReport(bad).violations.some(v => /checksum/.test(v)));

  const deep = new Uint8Array(512 * 1024).fill(0xff);
  deep.set(lantern.subarray(0, 0x4000));
  deep[0x15] = 31; deep[0x17] = 1;                 // Deep, 32 banks, dated 1987-03-01
  deep[0x38] = 0; deep[0x39] = 0;
  let sum = 0;
  for (let a = 0; a < deep.length; a += 2) sum = (sum + (a === 0x38 ? 0 : deep[a] | (deep[a + 1] << 8))) & 0xffff;
  deep[0x38] = sum & 0xff; deep[0x39] = sum >> 8;
  const d = cartridgeReport(deep);
  assert.equal(d.header.checksumOk, true);
  assert.equal(d.sizeClass!.board, "Deep");
  assert.ok(d.violations.some(v => /October 1990/.test(v)), d.violations.join("; "));

  const ram = lantern.slice(); ram[0x16] = 1;
  assert.ok(cartridgeReport(ram).violations.some(v => /RAM/.test(v)));
});

test("BUDGET PROBE: measured CPU, DMA stall, sprites per line, lights, voices", () => {
  const r = budgetReport(probe, { frames: 30 });
  assert.equal(r.frames, 30);
  // CPU: the burn after the 20th VBLANK keeps at least one whole frame from reaching WAI
  assert.equal(r.cpu.cyclesPerFrame, 59736);
  assert.equal(r.cpu.bootFrames, 1);                 // frame 0: set-up, then the first WAI
  assert.ok(r.cpu.overrunFrames >= 1, `overrunFrames ${r.cpu.overrunFrames}`);
  assert.ok(r.cpu.busy.max > 59000 && r.cpu.busy.max <= 59736 + 200, `busy max ${r.cpu.busy.max}`);
  assert.ok(r.cpu.busy.mean > 0 && r.cpu.busy.mean < r.cpu.busy.max);
  assert.equal(r.cpu.dmaStallCycles, 4 + 4 * 256);
  assert.equal(r.cpu.percentOfBudget.max, Math.round(r.cpu.busy.max / 59736 * 1000) / 10);
  // video: 20 sprites on lines 50-57 of every displayed frame; the chip draws 16
  assert.equal(r.video.spriteLimitPerLine, 16);
  assert.equal(r.video.maxSpritesOnLine, 20);
  assert.equal(r.video.overflowFrames, 30);
  assert.equal(r.video.linesOverLimit, 30 * 8);
  assert.equal(r.video.maxActiveLightsPerLine, 3);
  assert.equal(r.video.lightLimit, 4);
  // audio: voices 0 and 3 keyed on; voice 1 written only
  assert.deepEqual(r.audio.keyedVoices, [0, 3]);
  assert.deepEqual(r.audio.writtenVoices, [0, 1, 3]);
  assert.equal(r.audio.channelsUsed, 2);
  assert.equal(r.audio.channelLimit, 4);
  assert.ok(r.violations.some(v => /^cpu:/.test(v)), r.violations.join("; "));
  assert.ok(r.violations.some(v => /^video:.*sprites/.test(v)), r.violations.join("; "));
  assert.equal(r.pass, false);
});

test("measuring does not disturb the machine: same final hash as a plain run", () => {
  const pads = (f: number): [number, number] => [f >= 10 && f < 40 ? 8 : f >= 50 && f < 52 ? 16 : 0, 0];
  const r = budgetReport(lantern, { frames: 90, pads });
  const plain = runRom(lantern, 90, pads);
  assert.equal(r.hash, plain.m.hash());
  const p = budgetReport(probe, { frames: 25 });
  assert.equal(p.hash, runRom(probe, 25).m.hash());
});

test("a meter driven frame by frame reports what budgetReport reports, even when a harness steps on to WAI between frames", () => {
  const lanternPads = (f: number): [number, number] => [f >= 10 && f < 40 ? 8 : f >= 50 && f < 52 ? 16 : 0, 0];
  const none = (): [number, number] => [0, 0];
  const cases: [Uint8Array, number, (f: number) => [number, number]][] = [[probe, 30, none], [lantern, 90, lanternPads]];
  for (const [rom, frames, pads] of cases) {
    const want = budgetReport(rom, { frames, pads, name: "x", input: "y" });
    // plain: frame by frame, nothing in between
    const a = budgetMeter(rom);
    for (let f = 0; f < frames; f++) a.frame(...pads(f));
    assert.deepEqual(a.report({ name: "x", input: "y" }), want);
    // a harness that, between frames, steps the machine on until the CPU is back in WAI (never
    // past the next VBLANK): those steps are the next frame's, as inside its runFrame
    const b = budgetMeter(rom);
    let extra = 0;
    for (let f = 0; f < frames; f++) {
      b.frame(...pads(f));
      if (f === frames - 1) break;
      const limit = b.m.frame * MASTER_PER_FRAME + 224 * MASTER_PER_LINE;
      while (b.m.cpu.mode === "run" && b.m.masterCycle < limit) { b.m.step(limit); extra++; }
    }
    assert.ok(extra > 0, "the harness stepped between frames");
    assert.deepEqual(b.report({ name: "x", input: "y" }), want);
  }
  assert.equal(budgetMeter(lantern).report().input, "interactive");
});

test("LANTERN TEST is within every budget", () => {
  const r = budgetReport(lantern, { frames: 90, pads: f => [f >= 50 && f < 52 ? 16 : 4, 0] });
  assert.deepEqual(r.violations, []);
  assert.equal(r.pass, true);
  assert.equal(r.cpu.overrunFrames, 0);
  assert.equal(r.cpu.bootFrames, 2);                 // CRAM, tile and map set-up spill into frame 1
  assert.equal(r.cpu.mainLoopFrames, 88);
  assert.ok(r.cpu.percentOfBudget.max < 50);
  assert.ok([4 + 2 * 108, 4 + 4 * 108].includes(r.cpu.dmaStallCycles), `dma ${r.cpu.dmaStallCycles}`); // one 108-word tile DMA
  assert.equal(r.video.maxSpritesOnLine, 2);
  assert.equal(r.video.maxActiveLightsPerLine, 1);
  assert.deepEqual(r.audio.keyedVoices, [0]);
  // the JSON is machine-readable and round-trips
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test("CLI writes build/budget/<name>.json and exits by violations", () => {
  const node = [process.execPath, "--disable-warning=ExperimentalWarning", "tools/budget.ts"];
  const ok = spawnSync(node[0], [...node.slice(1), "lantern-test", "--frames", "60"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /lantern-test/);
  assert.ok(existsSync("build/budget/lantern-test.json"));
  const j = JSON.parse(readFileSync("build/budget/lantern-test.json", "utf8"));
  assert.equal(j.rom, "lantern-test");
  assert.equal(j.frames, 60);
  const bad = spawnSync(node[0], [...node.slice(1), "no-such-rom"], { encoding: "utf8" });
  assert.notEqual(bad.status, 0);
});

test("CLI: each completion replay is judged on the budget's own metered run; a wrong hash and an orphan replay fail", () => {
  const node = [process.execPath, "--disable-warning=ExperimentalWarning", "tools/budget.ts"];
  const m = play(lantern, [[3, 8, 0]], 6), word = m.wram[0] | (m.wram[1] << 8);
  const replay = (hash: string) => JSON.stringify({
    rom: "lantern-test", romSha256: sha256(lantern), pads: [[3, 8, 0]], frames: 6,
    expect: { hash, win: { addr: "$8000", value: "$" + word.toString(16).toUpperCase().padStart(4, "0") }, note: "six frames" },
  });
  const good = mkdtempSync(join(tmpdir(), "budget-replays-"));
  writeFileSync(join(good, "lantern-test.replay.json"), replay(m.hash()));
  const ok = spawnSync(node[0], [...node.slice(1), "lantern-test", "--replays", good], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, new RegExp(`PASS\\s+lantern-test\\s+completion replay: hash=${m.hash()}\\s+ok`));
  assert.match(ok.stdout, /replay: all 1 passing/);
  const j = JSON.parse(readFileSync("build/budget/lantern-test.json", "utf8"));
  assert.equal(j.frames, 6);
  assert.equal(j.hash, m.hash(), "the metered run ends in the plain run's state");
  assert.deepEqual([j.replay.pass, j.replay.hash, j.replay.detail], [true, m.hash(), "ok"]);

  const bad = mkdtempSync(join(tmpdir(), "budget-replays-"));
  writeFileSync(join(bad, "lantern-test.replay.json"), replay("00000000"));
  writeFileSync(join(bad, "ghost.replay.json"), JSON.stringify({ ...JSON.parse(replay(m.hash())), rom: "no-such-rom" }));
  const f = spawnSync(node[0], [...node.slice(1), "lantern-test", "--replays", bad], { encoding: "utf8" });
  assert.equal(f.status, 1, f.stdout + f.stderr);
  assert.match(f.stdout, /^OK\s+lantern-test/m, "within budget: only the replay fails");
  assert.match(f.stdout, new RegExp(`FAIL\\s+lantern-test\\s+completion replay: hash=${m.hash()}\\s+state hash ${m.hash()}, expected 00000000`));
  assert.match(f.stdout, /FAIL\s+no-such-rom\s+completion replay: hash=-\s+no ROM source named 'no-such-rom'/);
  assert.match(f.stdout, /replay: 2 failing/);
});

test("CLI takes a source path too (a program outside roms/), named after the file", () => {
  const node = [process.execPath, "--disable-warning=ExperimentalWarning", "tools/budget.ts"];
  const ok = spawnSync(node[0], [...node.slice(1), "examples/tutorial-1/step2.asm", "--frames", "60"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^OK\s+step2\s+32 KiB -> Standard 32 KiB/m);
  const j = JSON.parse(readFileSync("build/budget/step2.json", "utf8"));
  assert.deepEqual([j.rom, j.frames, j.cartridge.header.title], ["step2", 60, "TUTORIAL 1"]);
  const gone = spawnSync(node[0], [...node.slice(1), "examples/nope/nope.asm"], { encoding: "utf8" });
  assert.equal(gone.status, 1);
  assert.match(gone.stdout, /FAIL\s+examples\/nope\/nope\.asm: no such ROM/);
});
