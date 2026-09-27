// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// npm run player -- <cartridge.asm | cartridge.scr> [out.html]
// Builds a cartridge (CYASM or SCRIM) and bundles the browser player into ONE self-contained
// HTML file (script and ROM inline), runnable from file:// with no network. The page is titled
// with the ROM header's title.
import { build } from "esbuild";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildOne } from "./build-roms.ts";
import { isCliEntry } from "./cli-entry.ts";

export async function buildPlayerHtml(romFile: string, title?: string): Promise<string> {
  const rom = buildOne({ name: romFile, file: romFile, lang: romFile.endsWith(".scr") ? "scrim" : "asm" });
  title ??= String.fromCharCode(...rom.subarray(0x18, 0x30)).replace(/\0/g, "").trimEnd();
  const js = (await build({ entryPoints: ["src/web/main.ts"], bundle: true, write: false, format: "iife", target: "es2022", minify: true, legalComments: "none" })).outputFiles[0].text;
  const b64 = Buffer.from(rom).toString("base64");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Avenell Cyclorama</title>
<style>
:root{--bg:#0b0b0d;--fg:#d9d4c7;--muted:#8a857a}
html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.4 Georgia,serif}
main{max-width:800px;margin:0 auto;padding:16px}
#wrap{position:relative;width:100%;aspect-ratio:256/224;background:#000}
canvas{width:100%;height:100%;image-rendering:pixelated;display:block}
#start{position:absolute;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.6);cursor:pointer;font-size:18px;letter-spacing:.05em}
p{color:var(--muted)}
</style></head><body><main>
<div id="wrap"><canvas id="screen" width="256" height="224"></canvas><div id="start">Click or press a key to start (enables sound)</div></div>
<p>${esc(title)} · Arrows move · Z/X/C = A/B/C · Enter = START · F5 save state · F8 load state · Gamepads supported.<br>
Alternate-history fiction: the Avenell Cyclorama never existed; this is its emulator.</p>
</main>
<script>window.__ROM_B64__=${JSON.stringify(b64)};window.__ROM_TITLE__=${JSON.stringify(title)};</script>
<script>${js}</script>
</body></html>
`;
}

if (isCliEntry(import.meta.url)) {
  const [romFile = "roms/lantern-test/lantern-test.asm", out = "build/player/index.html"] = process.argv.slice(2);
  const html = await buildPlayerHtml(romFile);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`wrote ${out} (${html.length} bytes)`);
}
