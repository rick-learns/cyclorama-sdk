// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Barndoor (AV-2210) line renderer — docs/spec-notes.md §3.
// A pure function of video memory and the register values latched at dot 0
// of the line. Integer-only; used by the emulator and by offline scene tools.
import { REGISTERS } from "../../hw/registers.ts";

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

/** rgbOf of every 12-bit colour, so a pixel is one table read. */
const RGB = new Uint32Array(4096);
for (let c = 0; c < 4096; c++) RGB[c] = rgbOf(c);
/** Register names of light i: X, Y, I, F. */
const LIGHT_REG = [0, 1, 2, 3].map(i => [`L${i}X`, `L${i}Y`, `L${i}I`, `L${i}F`]);
const LX = new Int32Array(4), LI = new Int32Array(4), LF = new Int32Array(4), LS = new Int32Array(4), DY = new Int32Array(4);
const SUM = new Int32Array(256);    // AMBIENT + light levels per pixel of the line

const base = new Uint8Array(256);   // winning base colour index per pixel
const unlit = new Uint8Array(256);  // winning pixel's unlit flag
const spr = new Int32Array(16);

/** Pixel value (0-7) of `tile` at (px, py) within the tile, 3 bitplanes, bit 7 leftmost. */
function tilePixel(vram: Uint8Array, tile: number, px: number, py: number): number {
  const a = (tile * 24 + py) & 0x7fff, bit = 7 - px;
  return ((vram[a] >> bit) & 1) | (((vram[(a + 8) & 0x7fff] >> bit) & 1) << 1) | (((vram[(a + 16) & 0x7fff] >> bit) & 1) << 2);
}

// A BG layer's line, decoded once for both of its priority passes: colour index (palette * 8 +
// pixel, 0 = transparent) and flags (bit 0 priority, bit 1 unlit).
const bg0C = new Uint8Array(256), bg0F = new Uint8Array(256), bg1C = new Uint8Array(256), bg1F = new Uint8Array(256);

/** Decode one BG layer's line y into C/F. Each map entry and its three bitplane bytes are read
 *  once per tile column (8 pixels, fewer at the scrolled edges). Returns bit 0 set if any opaque
 *  pixel has priority 0, bit 1 if any has priority 1. */
function decodeBG(v: VideoState, y: number, mapReg: number, scx: number, scy: number, C: Uint8Array, F: Uint8Array): number {
  const vram = v.vram, mapBase = (mapReg & 15) * 2048;
  const my = (y + (scy & 255)) & 255, ty = my >> 3, fy = my & 7, sx0 = scx & 511;
  let seen = 0;
  for (let x = 0; x < 256;) {
    const mx = (x + sx0) & 511, fx = mx & 7, end = x + 8 - fx < 256 ? x + 8 - fx : 256;
    const a = (mapBase + (ty * 64 + (mx >> 3)) * 2) & 0x7fff;
    const e = vram[a] | (vram[(a + 1) & 0x7fff] << 8);
    const ta = ((e & 1023) * 24 + (e & 0x2000 ? 7 - fy : fy)) & 0x7fff;
    const b0 = vram[ta], b1 = vram[(ta + 8) & 0x7fff], b2 = vram[(ta + 16) & 0x7fff];
    if (b0 | b1 | b2) {
      const flip = e & 0x1000, pal = ((e >> 10) & 3) * 8, flags = ((e >> 14) & 1) | ((e >>> 15) << 1);
      seen |= 1 << (flags & 1);
      for (let c = fx; x < end; x++, c++) {
        const bit = flip ? c : 7 - c;
        const p = ((b0 >> bit) & 1) | (((b1 >> bit) & 1) << 1) | (((b2 >> bit) & 1) << 2);
        C[x] = p ? pal + p : 0; F[x] = flags;
      }
    } else for (; x < end; x++) C[x] = 0;
    x = end;
  }
  return seen;
}

/** Paint a decoded BG layer's opaque pixels of the given priority. */
function paintBG(C: Uint8Array, F: Uint8Array, priority: number) {
  for (let x = 0; x < 256; x++) { const c = C[x]; if (c && (F[x] & 1) === priority) { base[x] = c; unlit[x] = F[x] >> 1; } }
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
  const sprites = (ctrl & 8) !== 0 && n > 0;                     // with none on the line both passes paint nothing
  if (sprites) resolveSprites(v, y, n);
  const s0 = ctrl & 2 ? decodeBG(v, y, r.BG0MAP, r.BG0SCX, r.BG0SCY, bg0C, bg0F) : 0;
  const s1 = ctrl & 4 ? decodeBG(v, y, r.BG1MAP, r.BG1SCX, r.BG1SCY, bg1C, bg1F) : 0;
  if (s0 & 1) paintBG(bg0C, bg0F, 0);
  if (sprites) paintSprites(1);
  if (s1 & 1) paintBG(bg1C, bg1F, 0);
  if (sprites) paintSprites(0);
  if (s0 & 2) paintBG(bg0C, bg0F, 1);
  if (s1 & 2) paintBG(bg1C, bg1F, 1);

  // Light field: latch the four lights for this line.
  const lightOn = (ctrl & 16) !== 0, amb = r.AMBIENT & 7;
  let lights = 0;
  if (lightOn) for (let i = 0; i < 4; i++) {
    const k = LIGHT_REG[i], I = sx(r[k[2]], 4); if (I === 0) continue;
    const ly = sx(r[k[1]], 10);
    LX[lights] = sx(r[k[0]], 10); LI[lights] = I; LF[lights] = r[k[3]] & 7; LS[lights] = (r[k[3]] >> 4) & 3;
    DY[lights] = Math.abs(y - ly); lights++;
  }
  // Each lit pixel's shade is (AMBIENT + the sum of every light's level) & 7. A light's level is
  // |I| - (d >> F) where positive; every distance shape has d >= dy and (except the band) d >= dx,
  // so a light adds nothing on a line with dy >> F >= |I|, nor where dx >= |I| << F.
  const fixedRow = fixed * 64;
  if (lightOn) {
    SUM.fill(amb);
    for (let i = 0; i < lights; i++) {
      const I = LI[i], A = I < 0 ? -I : I, f = LF[i], s = LS[i], dy = DY[i], lx = LX[i];
      if (dy >> f >= A) continue;
      if (s === 3) { const mag = A - (dy >> f), c = I < 0 ? -mag : mag; for (let x = 0; x < 256; x++) SUM[x] += c; continue; }
      const reach = A << f, x0 = lx - reach + 1 > 0 ? lx - reach + 1 : 0, x1 = lx + reach - 1 < 255 ? lx + reach - 1 : 255;
      for (let x = x0; x <= x1; x++) {
        const dx = x > lx ? x - lx : lx - x;
        const d = s === 0 ? dx + dy : s === 1 ? (dx > dy ? dx : dy) : dx > dy ? dx + (dy >> 1) : dy + (dx >> 1);
        const mag = A - (d >> f);
        if (mag > 0) SUM[x] += I < 0 ? -mag : mag;
      }
    }
    for (let x = 0; x < 256; x++) out[x] = RGB[cram[(unlit[x] ? fixedRow : (SUM[x] & 7) * 64) + base[x]] & 0xfff];
  } else for (let x = 0; x < 256; x++) out[x] = RGB[cram[fixedRow + base[x]] & 0xfff];
  if ((r.PROBEY & 511) === y) {
    const px = r.PROBEX & 255;
    return { overflow, probe: { base: base[px], shade: lightOn && !unlit[px] ? SUM[px] & 7 : fixed } };
  }
  return { overflow };
}
