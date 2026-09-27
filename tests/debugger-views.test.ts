// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Pure helpers behind the browser debugger's panels (src/web/debugger/views.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flagString, decodeOam, oamFlags, decodeLight, SHAPES, litShade, shadeOverlay, parseHeader,
  hexRows, parseAddress, disasmWindow, renderTileSheet, renderMap, labelsByAddress,
} from "../src/web/debugger/views.ts";
import { createVideoState, renderLine, rgbOf } from "../src/machine/video/render.ts";
import { disassemble } from "../src/asm/disassembler.ts";
import { buildRom, runRom } from "../tools/conformance.ts";

const LANTERN = "roms/lantern-test/lantern-test.asm";

test("flags format as Z N C V I letters, '-' when clear", () => {
  assert.equal(flagString(0), "-----");
  assert.equal(flagString(1 | 4 | 16), "Z-C-I");
  assert.equal(flagString(2 | 8), "-N-V-");
  assert.equal(flagString(0x1f), "ZNCVI");
});

test("OAM decoding: signed 9-bit Y/X, tile, palette, flip/behind/unlit, size and hide", () => {
  const oam = new Uint8Array(512);
  const o = 3 * 8, attr = 0x3ab | (2 << 10) | 0x1000 | 0x8000;
  oam.set([0xfb, 0x01, 0x2c, 0x01, attr & 0xff, attr >> 8, 3, 0], o);  // Y 1FB = -5, X 12C = -212
  const s = decodeOam(oam, 3);
  assert.deepEqual(s, { index: 3, y: -5, x: -212, tile: 0x3ab, palette: 2, hflip: true, vflip: false, behind: false, unlit: true, size: 16, hidden: true });
  assert.equal(oamFlags(s), "unlit hflip hidden");
  const t = decodeOam(oam, 0);
  assert.deepEqual([t.x, t.y, t.size, t.hidden, oamFlags(t)], [0, 0, 8, false, ""]);
  oam.set([0, 0, 0, 0, 0, 0x60, 0, 0], 8); // vflip + behind
  assert.equal(oamFlags(decodeOam(oam, 1)), "behind vflip");
});

test("light registers decode into signed values and shape names", () => {
  const regs = createVideoState().regs;
  Object.assign(regs, { L1X: 0x3ff, L1Y: 0x200, L1I: 0xa, L1F: 0x24, L2X: 100, L2Y: 50, L2I: 7, L2F: 0x31 });
  assert.deepEqual(SHAPES, ["diamond", "square", "octagon", "band"]);
  assert.deepEqual(decodeLight(regs, 1), { index: 1, x: -1, y: -512, intensity: -6, falloff: 4, shape: "octagon", on: true });
  assert.deepEqual(decodeLight(regs, 2), { index: 2, x: 100, y: 50, intensity: 7, falloff: 1, shape: "band", on: true });
  assert.equal(decodeLight(regs, 0).on, false);
});

test("litShade matches the renderer's light-field rule on every pixel of a lit backdrop", () => {
  const v = createVideoState();
  for (let s = 0; s < 8; s++) v.cram[s * 64] = 0x100 * s + 1;         // distinct backdrop colour per shade
  Object.assign(v.regs, {
    VCTRL: 1 | 16, AMBIENT: 2,
    L0X: 60, L0Y: 40, L0I: 5, L0F: 0x03,                                  // diamond, falloff 3
    L1X: 200, L1Y: 0x3f0, L1I: 0xc, L1F: 0x12,                             // square, negative, y = -16
    L2X: 0x3e0, L2Y: 150, L2I: 7, L2F: 0x24,                               // octagon, x = -32
    L3X: 128, L3Y: 200, L3I: 3, L3F: 0x35,                                 // band
  });
  const out = new Uint32Array(256);
  for (let y = 0; y < 224; y++) {
    renderLine(v, y, out);
    for (let x = 0; x < 256; x++) assert.equal(out[x], rgbOf(v.cram[litShade(v.regs, x, y) * 64]), `(${x},${y})`);
  }
  v.regs.VCTRL = 1; v.regs.FIXED = 3;
  assert.equal(litShade(v.regs, 10, 10), 3, "light field off: FIXED");
});

test("shade overlay reproduces the rendered frame exactly (shade and base per pixel, unlit pixels at FIXED)", () => {
  const { m } = runRom(buildRom(LANTERN), 30);
  const before = m.hash();
  const { shade, base } = shadeOverlay(m.video);
  assert.equal(m.hash(), before, "overlay does not disturb the machine");
  for (let i = 0; i < 256 * 224; i++) assert.equal(m.framebuffer[i], rgbOf(m.video.cram[shade[i] * 64 + base[i]]), `pixel ${i}`);
  // the eyes are the sprite-0 pixels drawn with the unlit flag: shade FIXED (7) whatever the light says
  const eye = rgbOf(0xfd3);
  const eyes = [...m.framebuffer.keys()].filter(i => m.framebuffer[i] === eye);
  assert.ok(eyes.length > 0);
  for (const i of eyes) assert.equal(shade[i], 7);
  // lit pixels follow the light field; the far corner is dark
  const px = m.bus.read16(0x8000), py = m.bus.read16(0x8002);
  const i = (py + 24) * 256 + px + 8;
  assert.equal(shade[i], litShade(m.video.regs, px + 8, py + 24));
  assert.equal(shade[0], litShade(m.video.regs, 0, 0));
  assert.ok(shade[0] < shade[i]);
});

test("cartridge header fields and checksum", () => {
  const rom = buildRom(LANTERN);
  const h = parseHeader(rom);
  assert.equal(h.magic, "CYCL");
  assert.equal(h.title, "LANTERN TEST");
  assert.equal(h.dev, 1);
  assert.equal(h.date, "1987-03-01");
  assert.equal(h.version, "1.00");
  assert.equal(h.banks, rom.length / 16384);
  assert.equal(h.ram, false);
  assert.equal(h.generation, "Standard");
  assert.equal(h.checksum, h.computedChecksum);
  const bad = rom.slice(); bad[0x100] ^= 1;
  assert.notEqual(parseHeader(bad).computedChecksum, parseHeader(bad).checksum);
});

test("hex rows: address, 16 bytes, printable ASCII", () => {
  const bytes = Uint8Array.from({ length: 64 }, (_, i) => 0x30 + i);
  const rows = hexRows(i => bytes[i], 64, 0x10, 2, 0x8000);
  assert.deepEqual(rows, [
    "8010  40 41 42 43 44 45 46 47  48 49 4A 4B 4C 4D 4E 4F  @ABCDEFGHIJKLMNO",
    "8020  50 51 52 53 54 55 56 57  58 59 5A 5B 5C 5D 5E 5F  PQRSTUVWXYZ[\\]^_",
  ]);
  assert.equal(hexRows(() => 0, 16, 0, 4, 0).length, 1, "stops at the end of the region");
});

test("addresses: $hex, 0xhex, bare hex, symbols; rejects junk and out-of-range values", () => {
  const sym = new Map([["vblank", 0x12a]]);
  assert.equal(parseAddress("$4000"), 0x4000);
  assert.equal(parseAddress("0x10"), 0x10);
  assert.equal(parseAddress(" 12ab "), 0x12ab);
  assert.equal(parseAddress("vblank", sym), 0x12a);
  assert.equal(parseAddress("zz", sym), undefined);
  assert.equal(parseAddress("$10000"), undefined);
  assert.equal(parseAddress(""), undefined);
});

test("disassembly window: synchronised on PC, contiguous, bank-aware reader", () => {
  const rom = buildRom(LANTERN);
  const peek = (a: number) => rom[a] ?? 0xff;
  const ref = disassemble(rom, 0x40, 400);
  for (const target of [0x12a, 0x12c, 0x130, 0x180]) {
    const w = disasmWindow(peek, target, 6, 10);
    const at = w.findIndex(l => l.addr === target);
    assert.equal(at, 6, `pc line index for ${target.toString(16)}`);
    assert.equal(w.length, 17);
    for (let k = 1; k < w.length; k++) assert.equal(w[k].addr, w[k - 1].addr + w[k - 1].words.length * 2);
    for (const l of w) { const r = ref.find(x => x.addr === l.addr); assert.ok(r, `${l.addr.toString(16)} on the reference instruction stream`); assert.equal(l.text, r!.text); }
  }
  const early = disasmWindow(peek, 0x40, 6, 3);
  assert.equal(early[early.findIndex(l => l.addr === 0x40)].text, disassemble(rom, 0x40, 1)[0].text);
  // bank-aware: the reader decides what 4000-7FFF holds
  const banked = disasmWindow(a => (a >= 0x4000 && a < 0x8000 ? 0x00 : 0xff), 0x4010, 2, 2);
  assert.ok(banked.every(l => l.text === "NOP"));
});

test("labels by address prefer the plain name over local labels", () => {
  const m = labelsByAddress(new Map([["vblank", 0x12a], ["vblank.nu", 0x140], ["main", 0x126]]));
  assert.equal(m.get(0x12a), "vblank");
  assert.equal(m.get(0x140), "vblank.nu");
});

test("tile sheet: 32 x 32 tiles of 8 x 8, colours from CRAM[shade*64 + palette*8 + pixel]", () => {
  const v = createVideoState();
  for (let i = 0; i < 512; i++) v.cram[i] = i;
  // tile 33 (row 1, col 1): row 2 = pixels 1,2,4,7 at columns 0..3 (planes 0,1,2)
  const t = 33 * 24;
  v.vram[t + 2] = 0b1001_0000; v.vram[t + 8 + 2] = 0b0101_0000; v.vram[t + 16 + 2] = 0b0011_0000;
  const img = renderTileSheet(v.vram, v.cram, 5, 3);
  assert.equal(img.length, 256 * 256);
  const px = (x: number, y: number) => img[(8 + y) * 256 + 8 + x];
  assert.deepEqual([0, 1, 2, 3, 4].map(x => px(x, 2)), [1, 2, 4, 7, 0].map(p => rgbOf(3 * 64 + 5 * 8 + p)));
});

test("map view: 64 x 32 entries with tile, palette and flips", () => {
  const v = createVideoState();
  for (let i = 0; i < 512; i++) v.cram[i] = i;
  v.vram[2 * 24] = 0x80;                      // tile 2: pixel (0,0) = 1
  const base = 12 * 2048, e = 2 | (3 << 10) | 0x1000 | 0x2000; // palette 3, h+v flip
  const at = base + (1 * 64 + 2) * 2; v.vram[at] = e & 0xff; v.vram[at + 1] = e >> 8;
  const img = renderMap(v.vram, v.cram, 12, 7);
  assert.equal(img.length, 512 * 256);
  assert.equal(img[(8 + 7) * 512 + 16 + 7], rgbOf(7 * 64 + 3 * 8 + 1), "flipped pixel lands bottom-right");
  assert.equal(img[8 * 512 + 16], rgbOf(7 * 64), "transparent shows the backdrop");
});
