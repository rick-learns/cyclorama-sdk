// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// The Barndoor line renderer exactly as it was before the speed-up of 2026-09-26 (a verbatim copy
// of src/machine/video/render.ts at 612548e), kept as the reference the optimised renderer must
// match pixel for pixel (tests/machine-speed.test.ts). Never edit it to make a test pass.
import { REGISTERS } from "../../src/hw/registers.ts";

export type VideoState = {
  vram: Uint8Array;           // 32 KiB
  oam: Uint8Array;            // 512 bytes
  cram: Uint16Array;          // 512 entries, 0RGB
  regs: Record<string, number>; // raw 16-bit register values by name
};

export type LineInfo = { overflow: boolean; probe?: { base: number; shade: number } };

const RESET: Record<string, number> = { VINC: 2, LINECMP: 511, BG0MAP: 12, BG1MAP: 14, FIXED: 7 };

export function createVideoState(): VideoState {
  const regs: Record<string, number> = {};
  for (const r of REGISTERS) if (r.chip === "video") regs[r.name] = RESET[r.name] ?? 0;
  return { vram: new Uint8Array(32768), oam: new Uint8Array(512), cram: new Uint16Array(512), regs };
}

/** 12-bit 0RGB -> 24-bit 0xRRGGBB. */
export const rgbOf = (c: number) => (((c >> 8) & 15) * 17 << 16) | (((c >> 4) & 15) * 17 << 8) | ((c & 15) * 17);

const sx = (v: number, bits: number) => { const m = 1 << (bits - 1); v &= (1 << bits) - 1; return (v ^ m) - m; };

const base = new Uint8Array(256);   // winning base colour index per pixel
const unlit = new Uint8Array(256);  // winning pixel's unlit flag
const spr = new Int32Array(16);

/** Pixel value (0-7) of `tile` at (px, py) within the tile, 3 bitplanes, bit 7 leftmost. */
function tilePixel(vram: Uint8Array, tile: number, px: number, py: number): number {
  const a = (tile * 24 + py) & 0x7fff, bit = 7 - px;
  return ((vram[a] >> bit) & 1) | (((vram[(a + 8) & 0x7fff] >> bit) & 1) << 1) | (((vram[(a + 16) & 0x7fff] >> bit) & 1) << 2);
}

function paintBG(v: VideoState, y: number, mapReg: number, scx: number, scy: number, priority: number) {
  const vram = v.vram, mapBase = (mapReg & 15) * 2048;
  const my = (y + (scy & 255)) & 255, ty = my >> 3, fy = my & 7;
  for (let x = 0; x < 256; x++) {
    const mx = (x + (scx & 511)) & 511, tx = mx >> 3;
    const a = (mapBase + (ty * 64 + tx) * 2) & 0x7fff;
    const e = vram[a] | (vram[(a + 1) & 0x7fff] << 8);
    if (((e >> 14) & 1) !== priority) continue;
    const px = e & 0x1000 ? 7 - (mx & 7) : mx & 7, py = e & 0x2000 ? 7 - fy : fy;
    const p = tilePixel(vram, e & 1023, px, py);
    if (p) { base[x] = ((e >> 10) & 3) * 8 + p; unlit[x] = e >>> 15; }
  }
}

const sBase = new Uint8Array(256), sFlags = new Uint8Array(256); // sprite line buffer: flags bit0 unlit, bit1 behind

/** Resolve sprite priority first (spec-notes §8.1): lowest OAM index with an opaque pixel wins. */
function resolveSprites(v: VideoState, y: number, n: number) {
  const oam = v.oam, vram = v.vram;
  sBase.fill(0); sFlags.fill(0);
  for (let k = n - 1; k >= 0; k--) {        // lower OAM index written last = wins
    const o = spr[k] * 8;
    const attr = oam[o + 4] | (oam[o + 5] << 8);
    const sy = sx(oam[o] | (oam[o + 1] << 8), 9), sxp = sx(oam[o + 2] | (oam[o + 3] << 8), 9);
    const big = oam[o + 6] & 1, size = big ? 16 : 8;
    let ry = y - sy; if (attr & 0x2000) ry = size - 1 - ry;
    const tile = attr & 1023, pal = 4 + ((attr >> 10) & 3), flags = (attr >>> 15) | (((attr >> 14) & 1) << 1);
    for (let c = 0; c < size; c++) {
      const x = sxp + c; if (x < 0 || x > 255) continue;
      const rx = attr & 0x1000 ? size - 1 - c : c;
      const t = big ? (tile + ((ry >> 3) << 1) + (rx >> 3)) & 1023 : tile;
      const p = tilePixel(vram, t, rx & 7, ry & 7);
      if (p) { sBase[x] = pal * 8 + p; sFlags[x] = flags; }
    }
  }
}

/** Composite the resolved sprite pixels that are (behind = 1) or are not (behind = 0) behind BG1. */
function paintSprites(behind: number) {
  for (let x = 0; x < 256; x++) if (sBase[x] && ((sFlags[x] >> 1) & 1) === behind) { base[x] = sBase[x]; unlit[x] = sFlags[x] & 1; }
}

/** Render visible line y (0-223) into out[0..255] as 0xRRGGBB. */
export function renderLine(v: VideoState, y: number, out: Uint32Array): LineInfo {
  const r = v.regs, cram = v.cram, ctrl = r.VCTRL, fixed = r.FIXED & 7;
  if (!(ctrl & 1)) { out.fill(rgbOf(cram[fixed * 64])); return { overflow: false }; }
  base.fill(0); unlit.fill(0);

  // Sprite evaluation: first 16 sprites (OAM order) covering this line.
  let n = 0, overflow = false;
  if (ctrl & 8) for (let i = 0; i < 64; i++) {
    const o = i * 8;
    if (v.oam[o + 6] & 2) continue;
    const sy = sx(v.oam[o] | (v.oam[o + 1] << 8), 9), h = v.oam[o + 6] & 1 ? 16 : 8;
    if (y - sy < 0 || y - sy >= h) continue;
    if (n === 16) { overflow = true; break; }
    spr[n++] = i;
  }
  if (ctrl & 8) resolveSprites(v, y, n);
  if (ctrl & 2) paintBG(v, y, r.BG0MAP, r.BG0SCX, r.BG0SCY, 0);
  if (ctrl & 8) paintSprites(1);
  if (ctrl & 4) paintBG(v, y, r.BG1MAP, r.BG1SCX, r.BG1SCY, 0);
  if (ctrl & 8) paintSprites(0);
  if (ctrl & 2) paintBG(v, y, r.BG0MAP, r.BG0SCX, r.BG0SCY, 1);
  if (ctrl & 4) paintBG(v, y, r.BG1MAP, r.BG1SCX, r.BG1SCY, 1);

  // Light field: latch the four lights for this line.
  const lightOn = (ctrl & 16) !== 0, amb = r.AMBIENT & 7;
  const LX = [0, 0, 0, 0], LI = [0, 0, 0, 0], LF = [0, 0, 0, 0], LS = [0, 0, 0, 0], DY = [0, 0, 0, 0];
  let lights = 0;
  if (lightOn) for (let i = 0; i < 4; i++) {
    const I = sx(r[`L${i}I`], 4); if (I === 0) continue;
    const ly = sx(r[`L${i}Y`], 10);
    LX[lights] = sx(r[`L${i}X`], 10); LI[lights] = I; LF[lights] = r[`L${i}F`] & 7; LS[lights] = (r[`L${i}F`] >> 4) & 3;
    DY[lights] = Math.abs(y - ly); lights++;
  }
  let probe: LineInfo["probe"];
  const px = r.PROBEX & 255, probeHere = (r.PROBEY & 511) === y;
  for (let x = 0; x < 256; x++) {
    let shade = fixed;
    if (lightOn && !unlit[x]) {
      let sum = amb;
      for (let i = 0; i < lights; i++) {
        const dx = Math.abs(x - LX[i]), dy = DY[i], s = LS[i];
        const d = s === 0 ? dx + dy : s === 1 ? (dx > dy ? dx : dy) : s === 2 ? (dx > dy ? dx + (dy >> 1) : dy + (dx >> 1)) : dy;
        const I = LI[i], mag = (I < 0 ? -I : I) - (d >> LF[i]);
        if (mag > 0) sum += I < 0 ? -mag : mag;
      }
      shade = sum & 7;
    }
    if (probeHere && x === px) probe = { base: base[x], shade };
    out[x] = rgbOf(cram[shade * 64 + base[x]]);
  }
  return probe ? { overflow, probe } : { overflow };
}
