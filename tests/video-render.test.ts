// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Barndoor line renderer (docs/spec-notes.md §3). Pure function of video state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVideoState, renderLine, rgbOf, type VideoState } from "../src/machine/video/render.ts";

const W = 256;
const setCram = (v: VideoState, shade: number, base: number, rgb12: number) => { v.cram[shade * 64 + base] = rgb12; };
/** Write a tile from 8 strings of digits 0-7 (3bpp planar, MSB leftmost). */
function putTile(v: VideoState, n: number, rows: string[]) {
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const p = +rows[y][x];
    for (let b = 0; b < 3; b++) if ((p >> b) & 1) v.vram[n * 24 + b * 8 + y] |= 0x80 >> x;
  }
}
const mapEntry = (v: VideoState, mapBase: number, tx: number, ty: number, entry: number) => {
  const a = mapBase + (ty * 64 + tx) * 2; v.vram[a] = entry & 255; v.vram[a + 1] = entry >> 8;
};
const putSprite = (v: VideoState, i: number, x: number, y: number, attr: number, extra = 0) => {
  const o = i * 8, w = (a: number, val: number) => { v.oam[o + a] = val & 255; v.oam[o + a + 1] = (val >> 8) & 255; };
  w(0, y & 0x1ff); w(2, x & 0x1ff); w(4, attr); w(6, extra);
};
function fresh(): VideoState {
  const v = createVideoState();
  v.regs.VCTRL = 0b01111; // display, BG0, BG1, sprites; light field off
  v.regs.FIXED = 7;
  return v;
}
const line = (v: VideoState, y: number) => { const out = new Uint32Array(W); const info = renderLine(v, y, out); return { out, info }; };
const solid = ["11111111", "11111111", "11111111", "11111111", "11111111", "11111111", "11111111", "11111111"];

test("rgbOf expands 12-bit colour to 8-bit channels", () => {
  assert.equal(rgbOf(0x0f80), 0xff8800);
  assert.equal(rgbOf(0x0123), 0x112233);
});

test("backdrop is palette 0 colour 0 in the FIXED shade plane", () => {
  const v = fresh(); setCram(v, 7, 0, 0x0abc);
  assert.equal(line(v, 0).out[0], rgbOf(0x0abc));
});

test("display disabled shows CRAM[FIXED*64] everywhere", () => {
  const v = fresh(); v.regs.VCTRL = 0; v.regs.FIXED = 3; setCram(v, 3, 0, 0x0321);
  assert.ok(line(v, 100).out.every(p => p === rgbOf(0x0321)));
});

test("tile decoding: 3 bitplanes, bit 7 leftmost, map entry palette", () => {
  const v = fresh();
  putTile(v, 1, ["01234567", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"]);
  mapEntry(v, 0x6000, 0, 0, 1 | (2 << 10)); // tile 1, BG palette 2
  for (let p = 1; p < 8; p++) setCram(v, 7, 2 * 8 + p, p);
  const { out } = line(v, 0);
  for (let x = 1; x < 8; x++) assert.equal(out[x], rgbOf(x), `pixel ${x}`);
});

test("h-flip and v-flip on map entries", () => {
  const v = fresh();
  putTile(v, 1, ["10000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000002"]);
  mapEntry(v, 0x6000, 0, 0, 1 | (1 << 12) | (1 << 13));
  setCram(v, 7, 1, 0x0f00); setCram(v, 7, 2, 0x00f0);
  assert.equal(line(v, 0).out[0], rgbOf(0x00f0)); // bottom-right pixel appears top-left
  assert.equal(line(v, 7).out[7], rgbOf(0x0f00));
});

test("scrolling wraps at 512x256", () => {
  const v = fresh();
  putTile(v, 1, solid); setCram(v, 7, 1, 0x0fff);
  mapEntry(v, 0x6000, 63, 31, 1); // bottom-right map corner
  v.regs.BG0SCX = 504; v.regs.BG0SCY = 248;
  const { out } = line(v, 0);
  assert.equal(out[0], rgbOf(0x0fff)); assert.equal(out[8], 0);
});

test("compositing order: BG0 < behind-sprite < BG1 < sprite < priority tiles", () => {
  const v = fresh();
  putTile(v, 1, solid);
  setCram(v, 7, 1, 0x0100);          // BG pal 0
  setCram(v, 7, 8 + 1, 0x0200);      // BG pal 1
  setCram(v, 7, 32 + 1, 0x0300);     // sprite pal 0 (palette 4)
  setCram(v, 7, 40 + 1, 0x0400);     // sprite pal 1 (palette 5)
  // x 0-7: BG0 only; x 8-15: BG0+behind sprite; x 16-23: BG1 over behind sprite; x 24-31: normal sprite over BG1
  for (let tx = 0; tx < 4; tx++) mapEntry(v, 0x6000, tx, 0, 1);
  mapEntry(v, 0x7000, 2, 0, 1 | (1 << 10)); mapEntry(v, 0x7000, 3, 0, 1 | (1 << 10));
  putSprite(v, 0, 8, 0, 1 | (1 << 14)); putSprite(v, 1, 16, 0, 1 | (1 << 14)); putSprite(v, 2, 24, 0, 1 | (1 << 10));
  // x 32-39: priority BG0 tile over normal sprite
  mapEntry(v, 0x6000, 4, 0, 1 | (1 << 14)); putSprite(v, 3, 32, 0, 1 | (1 << 10));
  const { out } = line(v, 0);
  assert.equal(out[0], rgbOf(0x0100));
  assert.equal(out[8], rgbOf(0x0300));
  assert.equal(out[16], rgbOf(0x0200));
  assert.equal(out[24], rgbOf(0x0400));
  assert.equal(out[32], rgbOf(0x0100));
});

test("lower OAM index wins; 16 sprites per line; overflow reported", () => {
  const v = fresh(); putTile(v, 1, solid);
  setCram(v, 7, 32 + 1, 0x0111); setCram(v, 7, 40 + 1, 0x0222);
  putSprite(v, 0, 0, 0, 1); putSprite(v, 1, 0, 0, 1 | (1 << 10));
  assert.equal(line(v, 0).out[0], rgbOf(0x0111));
  for (let i = 0; i < 20; i++) putSprite(v, i, i * 8, 10, 1);
  const r = line(v, 10);
  assert.equal(r.info.overflow, true);
  assert.equal(r.out[15 * 8], rgbOf(0x0111)); // 16th drawn
  assert.equal(r.out[16 * 8], 0);             // 17th dropped
  assert.equal(line(v, 100).info.overflow, false); // zeroed OAM puts unused sprites at (0,0): line 0 overflows
});

test("16x16 sprites use tiles n, n+1, n+2, n+3 and flip as a whole; hide bit", () => {
  const v = fresh();
  for (let t = 0; t < 4; t++) putTile(v, 4 + t, Array(8).fill(String(t + 1).repeat(8)));
  for (let p = 1; p <= 4; p++) setCram(v, 7, 32 + p, p);
  putSprite(v, 0, 0, 0, 4, 1);
  let o = line(v, 0).out; assert.deepEqual([o[0], o[8]], [rgbOf(1), rgbOf(2)]);
  o = line(v, 8).out; assert.deepEqual([o[0], o[8]], [rgbOf(3), rgbOf(4)]);
  putSprite(v, 0, 0, 0, 4 | (1 << 12), 1); // h-flip swaps left/right tiles
  o = line(v, 0).out; assert.deepEqual([o[0], o[8]], [rgbOf(2), rgbOf(1)]);
  putSprite(v, 0, 0, 0, 4, 1 | 2); // hidden
  assert.equal(line(v, 0).out[0], 0);
});

test("sprites with negative X/Y (signed 9-bit) clip at the edges", () => {
  const v = fresh(); putTile(v, 1, solid); setCram(v, 7, 33, 0x0f0f);
  putSprite(v, 0, -4, -4, 1);
  assert.equal(line(v, 0).out[3], rgbOf(0x0f0f));
  assert.equal(line(v, 0).out[4], 0);
  assert.equal(line(v, 4).out[0], 0);
});

// --- Light field ---------------------------------------------------------
function lit(): VideoState {
  const v = fresh(); v.regs.VCTRL |= 1 << 4;
  for (let s = 0; s < 8; s++) setCram(v, s, 0, s); // backdrop colour = shade number
  return v;
}
const setLight = (v: VideoState, i: number, x: number, y: number, I: number, F: number, shape: number) => {
  v.regs[`L${i}X`] = x & 0x3ff; v.regs[`L${i}Y`] = y & 0x3ff; v.regs[`L${i}I`] = I & 15; v.regs[`L${i}F`] = (F & 7) | (shape << 4);
};
const shadeAt = (v: VideoState, x: number, y: number) => [0, 1, 2, 3, 4, 5, 6, 7].map(rgbOf).indexOf(line(v, y).out[x]);

test("light field: diamond level = I - (d >> F), plus AMBIENT", () => {
  const v = lit(); v.regs.AMBIENT = 1; setLight(v, 0, 100, 50, 6, 2, 0);
  assert.equal(shadeAt(v, 110, 50), 5);  // d=10 -> 6-2=4, +1
  assert.equal(shadeAt(v, 100, 50), 7);  // d=0 -> 6, +1
  assert.equal(shadeAt(v, 100, 80), 1);  // d=30 -> 6-7<0 -> 0, +1
});

test("light field: square, octagon and band distance shapes", () => {
  const v = lit();
  setLight(v, 0, 100, 100, 7, 0, 1); assert.equal(shadeAt(v, 103, 102), 4); // max(3,2)=3
  setLight(v, 0, 100, 100, 7, 0, 2); assert.equal(shadeAt(v, 103, 102), 3); // 3+(2>>1)=4
  setLight(v, 0, 100, 100, 7, 0, 3); assert.equal(shadeAt(v, 200, 102), 5); // band: dy=2
});

test("light field: the 3-bit adder wraps", () => {
  const v = lit(); v.regs.AMBIENT = 2;
  setLight(v, 0, 50, 50, 7, 0, 0); setLight(v, 1, 50, 50, 5, 0, 0);
  assert.equal(shadeAt(v, 50, 50), (2 + 7 + 5) & 7); // 14 mod 8 = 6
});

test("light field: negative intensity subtracts (and wraps below zero)", () => {
  const v = lit(); v.regs.AMBIENT = 5;
  setLight(v, 0, 60, 60, -3, 0, 0); assert.equal(shadeAt(v, 60, 60), 2);
  setLight(v, 0, 60, 60, -8, 0, 0); assert.equal(shadeAt(v, 60, 60), (5 - 8) & 7);
});

test("light field: signed 10-bit light positions can sit off-screen", () => {
  const v = lit(); setLight(v, 0, -4, 10, 7, 0, 0);
  assert.equal(shadeAt(v, 0, 10), 3); // d = 4
});

test("unlit tiles, and a disabled light field, use FIXED", () => {
  const v = lit(); v.regs.FIXED = 2; v.regs.AMBIENT = 6;
  putTile(v, 1, solid); for (let s = 0; s < 8; s++) setCram(v, s, 1, 0x100 + s);
  mapEntry(v, 0x6000, 0, 0, 1 | (1 << 15));
  assert.equal(line(v, 0).out[0], rgbOf(0x102));
  assert.equal(line(v, 0).out[8], rgbOf(6)); // backdrop is lit
  v.regs.VCTRL &= ~(1 << 4);
  assert.equal(line(v, 0).out[8], rgbOf(2));
});

test("probe latches base index and shade at (PROBEX, PROBEY)", () => {
  const v = lit(); v.regs.AMBIENT = 3; v.regs.PROBEX = 20; v.regs.PROBEY = 5;
  putTile(v, 1, solid); mapEntry(v, 0x6000, 2, 0, 1 | (3 << 10));
  assert.equal(line(v, 4).info.probe, undefined);
  assert.deepEqual(line(v, 5).info.probe, { base: 3 * 8 + 1, shade: 3 });
});

test("sprite priority resolves before layering (spec-notes §8.1)", () => {
  const v = fresh(); putTile(v, 1, solid);
  setCram(v, 7, 8 + 1, 0x0200);                   // BG pal 1 (BG1 tile)
  setCram(v, 7, 32 + 1, 0x0300); setCram(v, 7, 40 + 1, 0x0400);
  putSprite(v, 0, 0, 0, 1 | (1 << 14));           // index 0: behind BG1
  putSprite(v, 1, 0, 0, 1 | (1 << 10));           // index 1: normal
  mapEntry(v, 0x7000, 0, 0, 1 | (1 << 10));       // BG1 tile at x 0-7
  putSprite(v, 2, 8, 0, 1 | (1 << 14)); putSprite(v, 3, 8, 0, 1 | (1 << 10)); // same pair, no BG1 at x 8-15
  const { out } = line(v, 0);
  assert.equal(out[0], rgbOf(0x0200)); // sprite 0 won, then went behind BG1
  assert.equal(out[8], rgbOf(0x0300)); // sprite 2 won over sprite 3
});

test("16x16 sprite tile numbers wrap modulo 1024 (spec-notes §8.4)", () => {
  const v = fresh();
  putTile(v, 1023, solid); putTile(v, 0, Array(8).fill("22222222"));
  setCram(v, 7, 33, 0x0111); setCram(v, 7, 34, 0x0222);
  putSprite(v, 0, 0, 100, 1023, 1);
  const o = line(v, 100).out;
  assert.deepEqual([o[0], o[8]], [rgbOf(0x0111), rgbOf(0x0222)]);
});
