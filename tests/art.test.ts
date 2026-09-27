// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Asset converter: .art text files -> CYASM include (3bpp planar tiles, palettes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertArt, sourceReader } from "../tools/art.ts";
import { assemble } from "../src/asm/assembler.ts";

const art = `; test art
@tiles BRICK
22222222
11121111
11121111
11121111
22222222
11111112
13111112
11111112

@sprite16 BLOB
................
.......11.......
......1221......
.....123321.....
....12344321....
...1234554321...
..123456654321..
.12345677654321.
.12345677654321.
..123456654321..
...1234554321...
....12344321....
.....123321.....
......1221......
.......11.......
................

@palette FLOOR
$112 $964 $533 $4A4
`;

test("tiles become planar 3bpp bytes (plane 0, 1, 2; bit 7 leftmost)", () => {
  const inc = convertArt(art, "t.art");
  const r = assemble("m.asm", p => (p === "m.asm" ? ".org $100\n.include \"t.art.inc\"" : inc));
  assert.deepEqual(r.errors, []);
  const brick = r.symbols.get("BRICK")!;
  // row 0 "22222222": plane 0 = 00, plane 1 = FF, plane 2 = 00
  assert.equal(r.rom[brick + 0], 0x00); assert.equal(r.rom[brick + 8], 0xff); assert.equal(r.rom[brick + 16], 0x00);
  // row 6 "13111112": plane 0 = 11111110b... pixel values 1,3,1,1,1,1,1,2 -> p0 = 1 1 1 1 1 1 1 0 = FE; p1 = 0 1 0 0 0 0 0 1 = 41
  assert.equal(r.rom[brick + 6], 0xfe); assert.equal(r.rom[brick + 14], 0x41);
  assert.equal(r.symbols.get("BRICK_TILES"), 1);
});

test("16x16 sprites emit tiles in order top-left, top-right, bottom-left, bottom-right", () => {
  const inc = convertArt(art, "t.art");
  const r = assemble("m.asm", p => (p === "m.asm" ? ".org $100\n.include \"t.art.inc\"" : inc));
  const b = r.symbols.get("BLOB")!;
  assert.equal(r.symbols.get("BLOB_TILES"), 4);
  // top-left tile row 1 ".......1" -> plane 0 bit 0 set
  assert.equal(r.rom[b + 1] & 1, 1);
  // top-right tile (b + 24) row 1 "1......." -> plane 0 bit 7 set
  assert.equal(r.rom[b + 24 + 1] & 0x80, 0x80);
  // bottom-left tile (b + 48) row 0 (sprite row 8) ".1234567" -> pixel 7 in plane 0/1/2 at bit 0
  assert.equal(r.rom[b + 48] & 1, 1); assert.equal(r.rom[b + 48 + 8] & 1, 1); assert.equal(r.rom[b + 48 + 16] & 1, 1);
});

test("palettes become .word lists, colour 0 first (default 0)", () => {
  const inc = convertArt(art, "t.art");
  assert.match(inc, /FLOOR:\s*\n\s*\.word \$000, \$112, \$964, \$533, \$4A4, \$000, \$000, \$000/);
});

test("wide @tiles blocks are split into 8x8 tiles row-major", () => {
  const inc = convertArt("@tiles W\n" + Array(8).fill("1111111122222222").join("\n") + "\n", "w.art");
  const r = assemble("m.asm", p => (p === "m.asm" ? ".org $100\n.include \"w.art.inc\"" : inc));
  assert.equal(r.symbols.get("W_TILES"), 2);
  const w = r.symbols.get("W")!;
  assert.equal(r.rom[w], 0xff); assert.equal(r.rom[w + 24 + 8], 0xff); // tile 0 plane 0, tile 1 plane 1
});

test("errors: bad pixel, ragged rows, wrong sprite size, unknown directive", () => {
  assert.throws(() => convertArt("@tiles X\n" + Array(8).fill("1111111x").join("\n"), "e.art"), /e\.art:\d+: .*pixel/);
  assert.throws(() => convertArt("@tiles X\n" + ["11111111", "111"].join("\n"), "e.art"), /e\.art:\d+:/);
  assert.throws(() => convertArt("@sprite16 S\n" + Array(8).fill("1".repeat(16)).join("\n"), "e.art"), /16x16/);
  assert.throws(() => convertArt("@frob X\n", "e.art"), /unknown/);
});

test("sourceReader converts foo.art.inc from foo.art on demand", () => {
  const files: Record<string, string> = { "d/foo.art": "@tiles T\n" + Array(8).fill("11111111").join("\n") + "\n" };
  const read = sourceReader(p => { if (!(p in files)) throw new Error("ENOENT " + p); return files[p]; });
  assert.match(String(read("d/foo.art.inc")), /T:/);
});
