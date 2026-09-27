// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Browser host logic that must not affect machine timing: pacing, resampling, input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FramePacer, FRAME_MS } from "../src/web/pacing.ts";
import { Resampler } from "../src/web/resample.ts";
import { SampleQueue, LevelMeter, rateAdjust, WORKLET_SOURCE, WORKLET_NAME } from "../src/web/audio-out.ts";
import { padFromKeys, padFromGamepad, KEYMAP } from "../src/web/input.ts";

test("frame period is the canon refresh (358,416 master cycles at 945/44 MHz)", () => {
  assert.ok(Math.abs(FRAME_MS - 16.688152) < 1e-5, String(FRAME_MS));
});

test("pacer: 60 Hz and 120 Hz displays run the same number of machine frames over time", () => {
  const run = (hz: number, seconds: number) => {
    const p = new FramePacer(); let frames = 0;
    for (let t = 0; t <= seconds * 1000; t += 1000 / hz) frames += p.tick(t);
    return frames;
  };
  const f60 = run(60, 10), f120 = run(120, 10), f144 = run(144, 10);
  const expect = Math.floor(10000 / FRAME_MS);
  for (const f of [f60, f120, f144]) assert.ok(Math.abs(f - expect) <= 1, `${f} vs ${expect}`);
});

test("pacer: catch-up is capped at 4 frames and long stalls resync instead of spiralling", () => {
  const p = new FramePacer();
  p.tick(0);
  assert.equal(p.tick(50), 2);          // 50 ms: 2 frames due (2 * 16.69 = 33.4, 3 * = 50.06)
  assert.equal(p.tick(1050), 4);        // 1 s stall: capped at 4, backlog dropped
  assert.equal(p.tick(1050 + FRAME_MS + 0.01), 1);
});

test("resampler: 47,940 Hz -> 48,000 Hz produces the right count, preserves a DC level, and is continuous", () => {
  const r = new Resampler(47940.340909, 48000);
  let out = 0;
  for (let i = 0; i < 100; i++) out += r.push(new Int16Array(800).fill(16384)).length;
  const expected = 80000 * 48000 / 47940.340909;
  assert.ok(Math.abs(out - expected) < 2, `${out} vs ${expected}`);
  const x = r.push(new Int16Array(800).fill(16384));
  assert.ok(x.every(v => Math.abs(v - 0.5) < 1e-6));
});

test("resampler: rate adjustment within ±0.5% changes output length proportionally", () => {
  const a = new Resampler(47940.34, 48000), b = new Resampler(47940.34, 48000);
  b.setRateAdjust(1.005);
  let na = 0, nb = 0;
  for (let i = 0; i < 60; i++) { na += a.push(new Int16Array(800)).length; nb += b.push(new Int16Array(800)).length; }
  assert.ok(Math.abs(nb / na - 1.005) < 0.001, `${nb / na}`);
  assert.throws(() => b.setRateAdjust(1.02));
});

test("keyboard mapping: arrows, Z/X/C for A/B/C, Enter for START", () => {
  assert.equal(padFromKeys(new Set(["ArrowUp", "KeyZ", "Enter"])), 0b1001_0001);
  assert.equal(padFromKeys(new Set(["ArrowRight", "KeyX", "KeyC"])), 0b0110_1000);
  assert.equal(KEYMAP.ArrowDown, 1 << 1);
});

test("gamepad standard mapping: d-pad, stick past dead zone, face buttons, start", () => {
  const pad = (buttons: number[], axes = [0, 0]) => ({ buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: buttons.includes(i) })), axes });
  assert.equal(padFromGamepad(pad([12, 0, 9])), (1 << 0) | (1 << 4) | (1 << 7));
  assert.equal(padFromGamepad(pad([1, 2])), (1 << 5) | (1 << 6));
  assert.equal(padFromGamepad(pad([], [-0.9, 0.2])), 1 << 2);
  assert.equal(padFromGamepad(pad([], [0.3, 0.3])), 0);
});

// ------------------------------------------------------------------ audio output (shared by both backends)

test("sample queue: plays chunks in order across block boundaries, counts underruns, reports depth and peak", () => {
  const q = new SampleQueue();
  q.push(new Float32Array([0.1, -0.5, 0.2]));
  q.push(new Float32Array([0.3, 0.4]));
  assert.equal(q.depth, 5);
  const a = new Float32Array(4);
  q.pull(a);
  assert.deepEqual([...a].map(v => +v.toFixed(3)), [0.1, -0.5, 0.2, 0.3]);
  let r = q.report();
  assert.equal(r.depth, 1); assert.equal(r.played, 4); assert.equal(r.under, 0);
  assert.ok(Math.abs(r.peak - 0.5) < 1e-6, "peak is the largest magnitude played since the last report");
  const b = new Float32Array(3).fill(9);
  q.pull(b);
  assert.deepEqual([...b].map(v => +v.toFixed(3)), [0.4, 0, 0], "underrun plays silence");
  r = q.report();
  assert.equal(r.depth, 0); assert.equal(r.played, 5); assert.equal(r.under, 2);
  assert.ok(Math.abs(r.peak - 0.4) < 1e-6, "peak was reset by the previous report");
  q.pull(new Float32Array(8));
  assert.equal(q.report().peak, 0, "silence reports a zero peak");
});

test("rate control: queue below target speeds output up, above slows it, always within ±0.5%", () => {
  assert.equal(rateAdjust(2400, 2400), 1);
  assert.ok(rateAdjust(1200, 2400) > 1);
  assert.ok(rateAdjust(3600, 2400) < 1);
  for (const d of [0, 1, 100, 2400, 5000, 1e6]) {
    const f = rateAdjust(d, 2400);
    assert.ok(f >= 0.995 && f <= 1.005, `${d} -> ${f}`);
    new Resampler(47940.34, 48000).setRateAdjust(f);   // accepted by the resampler
  }
});

test("level meter: holds the latest peak, decays toward zero, never goes negative", () => {
  const m = new LevelMeter(100);                 // 100 ms half-life
  assert.equal(m.read(0), 0);
  m.feed(0.5, 1000);
  assert.ok(Math.abs(m.read(1000) - 0.5) < 1e-9);
  assert.ok(Math.abs(m.read(1100) - 0.25) < 1e-9, "halves every half-life");
  m.feed(0.1, 1100);                             // quieter than the decayed level: level keeps decaying
  assert.ok(Math.abs(m.read(1100) - 0.25) < 1e-9);
  m.feed(0.9, 1200);                             // louder: jumps up
  assert.ok(Math.abs(m.read(1200) - 0.9) < 1e-9);
  assert.ok(m.read(5000) >= 0 && m.read(5000) < 1e-6);
  m.feed(0, 6000);
  assert.ok(m.read(6000) < 1e-6);
});

test("worklet source: a self-contained processor that plays queued chunks and reports depth, underruns and peak", () => {
  type Proc = { port: { onmessage: (e: { data: Float32Array }) => void }; process(i: unknown, o: Float32Array[][]): boolean };
  let Ctor: (new () => Proc) | null = null;
  let name = "";
  const posted: unknown[] = [];
  class FakeProcessor { port = { onmessage: null as unknown, postMessage: (m: unknown) => posted.push(m) }; }
  new Function("AudioWorkletProcessor", "registerProcessor", WORKLET_SOURCE)(FakeProcessor, (n: string, c: new () => Proc) => { name = n; Ctor = c; });
  assert.equal(name, WORKLET_NAME);
  const p = new Ctor!();
  p.port.onmessage({ data: new Float32Array(200).fill(0.25) });
  const out = new Float32Array(128);
  for (let k = 0; k < 8; k++) assert.equal(p.process([], [[out]]), true);
  assert.equal(out[0], 0, "queue ran dry by the last block");
  assert.equal(posted.length, 1, "reports every 8 blocks");
  const r = posted[0] as { depth: number; under: number; played: number; peak: number };
  assert.equal(r.played, 200); assert.equal(r.under, 8 * 128 - 200); assert.equal(r.depth, 0);
  assert.equal(r.peak, 0.25);
});
