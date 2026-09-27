// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Conformance ROMs in real Chromium ("normal execution") must give the same
// results and state hashes as headless Node; display rate must not change state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { build } from "esbuild";
import { buildRom, conformanceFiles, runConformance, padScript } from "../tools/conformance.ts";
import { readFileSync } from "node:fs";

const js = (await build({ entryPoints: ["src/web/test-harness.ts"], bundle: true, write: false, format: "iife" })).outputFiles[0].text;
const browser = await chromium.launch({ headless: true });
const page: Page = await browser.newPage();
await page.setContent("<!doctype html><title>harness</title>");
await page.addScriptTag({ content: js });
const call = <T>(fn: string, ...args: unknown[]) =>
  page.evaluate(([fn, args]) => { const a = (args as unknown[]).map(x => Array.isArray(x) ? new Uint8Array(x) : x); return (window as any).cyc[fn as string](...a); }, [fn, args] as const) as Promise<T>;

for (const f of conformanceFiles()) {
  test(`conformance in Chromium: ${f}`, async () => {
    const node = runConformance(f);
    const script = padScript(readFileSync(f, "utf8"));
    const pads = Array.from({ length: 600 }, (_, i) => (script ? script(i)[0] : 0));
    const r = await call<{ code: number; hash: string; stopped: boolean }>("runToStop", [...buildRom(f)], 600, pads);
    assert.ok(r.stopped, "reached STOP");
    assert.equal(r.code, 0x600d, `failed check ${r.code}`);
    assert.equal(r.hash, node.hash, "Chromium and Node state hashes differ");
  });
}

test("display refresh does not change machine state: 60 Hz vs 120 Hz vs 144 Hz pacing", async () => {
  const rom = [...buildRom("roms/lantern-test/lantern-test.asm")];
  const a = await call<{ frames: number; hash: string }>("paced", rom, 60, 5);
  const b = await call<{ frames: number; hash: string }>("paced", rom, 120, 5);
  const c = await call<{ frames: number; hash: string }>("paced", rom, 144, 5);
  const n = Math.min(a.frames, b.frames, c.frames);
  // the same number of machine frames gives the same state regardless of display rate
  for (const r of [a, b, c]) {
    const h = await call<string>("fixed", rom, r.frames);
    assert.equal(r.hash, h);
  }
  assert.ok(Math.max(a.frames, b.frames, c.frames) - n <= 1, `${a.frames} ${b.frames} ${c.frames}`);
});

test.after(async () => { await browser.close(); });
