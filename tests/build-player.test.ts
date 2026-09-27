// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// tools/build-player.ts: one self-contained HTML page for a CYASM or SCRIM cartridge, titled from
// the ROM header, with the manifest's exact ROM inside. (tests/browser-player.test.ts plays it.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildPlayerHtml } from "../tools/build-player.ts";

const manifest = JSON.parse(readFileSync("roms/manifest.json", "utf8")).roms as Record<string, { source: string; sha256: string }>;
const romOf = (html: string) => Buffer.from(JSON.parse(/window\.__ROM_B64__=("[^"]*")/.exec(html)![1]), "base64");

test("a CYASM and a SCRIM cartridge each become one page carrying the manifest's ROM, titled from its header", async () => {
  for (const [name, title] of [["lantern-test", "LANTERN TEST"], ["slice-test", "SLICE TEST"]] as const) {
    const html = await buildPlayerHtml(manifest[name].source);
    assert.equal(createHash("sha256").update(romOf(html)).digest("hex"), manifest[name].sha256, name);
    assert.match(html, new RegExp(`<title>${title} — `), name);
    assert.ok(!/<script src=|<link [^>]*href="http/.test(html), "nothing loaded from the network");
  }
  assert.match(await buildPlayerHtml(manifest["lantern-test"].source, "Custom"), /<title>Custom — /);
});
