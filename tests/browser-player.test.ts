// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// The built player page in headless Chromium, offline, from file://.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { buildPlayerHtml } from "../tools/build-player.ts";
import { buildRom, runRom } from "../tools/conformance.ts";

const ROM = "roms/lantern-test/lantern-test.asm";

declare global { interface Window { __rafLog: [number, number][] } }
/** One machine frame in ms, from the spec (358,416 master cycles at 945/44 MHz), not taken from the page. */
const FRAME = 358416 / (945e6 / 44) * 1000;
/** The pacer's catch-up cap (src/web/pacing.ts MAX_CATCH_UP): a gap over 4 frames is resynced, not caught up. */
const CAP = 4;

/** Init script: log [animation-frame timestamp, player frames after the callback] for every animation frame. */
function logAnimationFrames() {
  window.__rafLog = [];
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => raf(now => { cb(now); if (window.__player) window.__rafLog.push([now, window.__player.stats.frames]); });
}

/**
 * Real-time pacing, judged on the page's own animation-frame timestamps rather than a wall-clock
 * sleep: over the window, frames never exceed elapsed/FRAME + 1 (2x speed fails), and fall short
 * only by what gaps longer than CAP frames may drop (each at most gap - (CAP-1) frames), + 1.
 * A loaded machine stalls animation frames; that is allowed for, running slow is not.
 */
function checkPacing(log: [number, number][]) {
  const pts = log.filter((e, i) => i === log.length - 1 || log[i + 1][0] !== e[0]);  // last entry per timestamp
  const [t0, f0] = pts[0], [t1, f1] = pts[pts.length - 1];
  let dropped = 0, steady = 0;
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i][0] - pts[i - 1][0];
    if (gap > CAP * FRAME) dropped += gap - (CAP - 1) * FRAME; else steady += gap;
  }
  const n = f1 - f0, T = t1 - t0, hi = T / FRAME + 1, lo = (T - dropped) / FRAME - 1;
  const msg = `${n} frames in ${T.toFixed(0)} ms (${steady.toFixed(0)} ms steady, stalls may drop ${(dropped / FRAME).toFixed(1)}): want ${lo.toFixed(1)}..${hi.toFixed(1)}`;
  assert.ok(n <= hi + 1e-6, `too fast: ${msg}`);
  assert.ok(n >= lo - 1e-6, `too slow: ${msg}`);
  return { n, T, steady };
}
mkdirSync(".tmp/browser", { recursive: true });
writeFileSync(".tmp/browser/index.html", await buildPlayerHtml(ROM, "Lantern Test"));

test("player page: offline file://, real-time pacing, audio, save/load, same state hash as Node", async () => {
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    const ctx = await browser.newContext();
    await ctx.setOffline(true);
    await ctx.route("**/*", r => r.request().url().startsWith("file:") ? r.continue() : r.abort());
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", e => errors.push(String(e)));
    await page.addInitScript(logAnimationFrames);
    await page.goto(pathToFileURL(resolve(".tmp/browser/index.html")).href);
    await page.click("#start");
    await page.keyboard.down("ArrowRight");
    const i0 = await page.evaluate(() => window.__rafLog.length);
    // run until the page has had 2.5 s of steady animation frames (timer polling: no extra rAF callbacks)
    await page.waitForFunction(([from, limit]) => {
      const L = window.__rafLog; let steady = 0;
      for (let i = from + 1; i < L.length; i++) { const g = L[i][0] - L[i - 1][0]; if (g <= limit) steady += g; }
      return steady >= 2500;
    }, [i0, CAP * FRAME], { polling: 100, timeout: 30_000 });
    await page.keyboard.up("ArrowRight");
    const pace = checkPacing(await page.evaluate(from => window.__rafLog.slice(from), i0));
    assert.ok(pace.steady >= 2500 && pace.n > 100, `window ${pace.n} frames, ${pace.steady.toFixed(0)} ms steady`);
    await page.waitForFunction(() => window.__player!.stats.played > 48000, undefined, { timeout: 10_000 }).catch(() => {});
    const played = await page.evaluate(() => window.__player!.stats.played);
    assert.ok(played > 48000, `audio samples played ${played}`);
    // save/load round trip in the page
    const ok = await page.evaluate(() => { const p = window.__player!; const s = p.saveState(); const h = p.machine.hash(); p.runOneFrame(); p.loadState(s); return p.machine.hash() === h; });
    assert.ok(ok, "save/load restores the exact state");
    // determinism across engines: 300 frames of scripted input from power-on
    const hashBrowser = await page.evaluate(() => {
      const P = window.__player!.constructor as any;
      const c = document.createElement("canvas");
      const bin = atob(window.__ROM_B64__); const rom = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) rom[i] = bin.charCodeAt(i);
      const p = new P(c, rom); p.stop();
      for (let f = 0; f < 300; f++) p.machine.runFrame((f * 7) & 0x1f, 0);
      return p.machine.hash();
    });
    const hashNode = runRom(buildRom(ROM), 300, f => [(f * 7) & 0x1f, 0]).m.hash();
    assert.equal(hashBrowser, hashNode);
    assert.equal(await page.evaluate(() => window.__player!.audioBackend), "worklet");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("player page without AudioWorklet (non-secure context): ScriptProcessor fallback, A's note reaches the output", async () => {
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    const ctx = await browser.newContext();
    await ctx.setOffline(true);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", e => errors.push(String(e)));
    await page.addInitScript(() => { Object.defineProperty(AudioContext.prototype, "audioWorklet", { get() { return undefined; }, configurable: true }); });
    await page.goto(pathToFileURL(resolve(".tmp/browser/index.html")).href);
    await page.click("#start");
    await page.waitForFunction(() => window.__player!.stats.played > 9600, undefined, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__player!.audioBackend), "script-processor");
    assert.equal(await page.evaluate(() => window.__player!.stats.peak), 0, "silent before A");
    await page.keyboard.down("KeyZ");
    await page.waitForFunction(() => window.__player!.stats.peak > 0.05, undefined, { timeout: 5000 }).catch(() => {});
    await page.keyboard.up("KeyZ");
    const peak = await page.evaluate(() => window.__player!.stats.peak);
    assert.ok(peak > 0.05, `peak ${peak}`);
    await page.evaluate(() => window.__player!.stop());
    assert.deepEqual(await page.evaluate(() => window.__player!.audioStatus), { backend: "script-processor", state: "closed", connected: false });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
