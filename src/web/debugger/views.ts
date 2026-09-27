// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Pure helpers behind the debugger's panels: decoding hardware state into
// human terms and rendering video memory into images. No DOM; unit-tested in
// tests/debugger-views.test.ts. Images are Uint32Array of 0xRRGGBB.
import { renderLine, rgbOf, type VideoState } from "../../machine/video/render.ts";
import { disassemble, type DisLine } from "../../asm/disassembler.ts";

const sx = (v: number, bits: number) => { const m = 1 << (bits - 1); v &= (1 << bits) - 1; return (v ^ m) - m; };
export const hex2 = (v: number) => (v & 0xff).toString(16).toUpperCase().padStart(2, "0");
export const hex4 = (v: number) => (v & 0xffff).toString(16).toUpperCase().padStart(4, "0");

// ------------------------------------------------------------------ CPU
/** Flags Z N C V I (bits 0-4) as letters, '-' when clear. */
export function flagString(f: number): string {
  return "ZNCVI".split("").map((c, i) => ((f >> i) & 1 ? c : "-")).join("");
}

/** Parse an address: $hex, 0xhex, bare hex, or a symbol name. Undefined if invalid or above FFFF. */
export function parseAddress(text: string, symbols?: Map<string, number>): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const s = symbols?.get(t);
  if (s !== undefined) return s & 0xffff;
  const m = /^(?:\$|0x)?([0-9a-f]{1,8})$/i.exec(t);
  if (!m) return undefined;
  const v = parseInt(m[1], 16);
  return v <= 0xffff ? v : undefined;
}

/** One name per address: plain labels before local ones (`scope.local`), then alphabetical. */
export function labelsByAddress(symbols: Map<string, number>): Map<number, string> {
  const names = [...symbols].sort(([a], [b]) => (a.includes(".") ? 1 : 0) - (b.includes(".") ? 1 : 0) || (a < b ? -1 : a > b ? 1 : 0));
  const out = new Map<number, string>();
  for (const [name, v] of names) if (!out.has(v)) out.set(v, name);
  return out;
}

/**
 * Disassembly around `pc` through a byte reader of the CPU address space (bank-aware
 * when the reader is). Instructions are 1 or 2 words, so the lines before PC are found by
 * decoding forward from the furthest start point that lands exactly on PC.
 */
export function disasmWindow(read: (addr: number) => number, pc: number, before: number, after: number): DisLine[] {
  pc &= 0xfffe;
  const grab = (start: number, len: number) => Uint8Array.from({ length: len }, (_, i) => read((start + i) & 0xffff));
  let best: DisLine[] = [];
  for (let back = Math.min(before * 3, pc >> 1); back > 0 && best.length < before; back--) {
    const start = pc - back * 2;
    const pre = disassemble(grab(start, back * 2 + 2), start, back, start).filter(l => l.addr < pc);
    const last = pre[pre.length - 1];
    if (last && last.addr + last.words.length * 2 === pc && pre.length > best.length) best = pre;
  }
  return [...best.slice(-before), ...disassemble(grab(pc, after * 4 + 4), pc, after + 1, pc)];
}

// ------------------------------------------------------------------ memory
/** Hex dump rows of 16 bytes: "AAAA  xx .. xx  xx .. xx  ascii". `read(i)` gives byte i of a region of `size` bytes shown at `display`. */
export function hexRows(read: (i: number) => number, size: number, start: number, rows: number, display = 0): string[] {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const o = start + r * 16;
    if (o >= size) break;
    const bytes: number[] = [];
    for (let i = 0; i < 16 && o + i < size; i++) bytes.push(read(o + i) & 0xff);
    const h = bytes.map(hex2);
    const ascii = bytes.map(b => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    out.push(`${hex4(display + o)}  ${h.slice(0, 8).join(" ")}  ${h.slice(8).join(" ")}`.padEnd(56) + ascii);
  }
  return out;
}

// ------------------------------------------------------------------ cartridge
export type CartHeader = {
  magic: string; headerVersion: number; banks: number; sizeByte: number; ram: boolean; generation: string;
  title: string; dev: number; date: string; version: string; checksum: number; computedChecksum: number;
};

export function parseHeader(rom: Uint8Array): CartHeader {
  const b = (i: number) => rom[i] ?? 0, w = (i: number) => b(i) | (b(i + 1) << 8);
  const date = ((b(0x32) | (b(0x33) << 8) | (b(0x34) << 16) | (b(0x35) << 24)) >>> 0).toString(16).padStart(8, "0");
  const ver = w(0x36);
  let sum = 0;
  for (let i = 0; i < rom.length; i += 2) if (i !== 0x38) sum = (sum + b(i) + (b(i + 1) << 8)) & 0xffff;
  return {
    magic: String.fromCharCode(b(0x10), b(0x11), b(0x12), b(0x13)), headerVersion: b(0x14),
    banks: Math.max(1, rom.length >> 14), sizeByte: b(0x15), ram: b(0x16) === 1, generation: b(0x17) ? "Deep" : "Standard",
    title: String.fromCharCode(...rom.subarray(0x18, 0x30)).replace(/[^\x20-\x7e]/g, "?").trimEnd(),
    dev: w(0x30), date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`,
    version: `${(ver >> 8).toString(16)}.${(ver & 0xff).toString(16).padStart(2, "0")}`,
    checksum: w(0x38), computedChecksum: sum,
  };
}

// ------------------------------------------------------------------ sprites
export type Sprite = {
  index: number; y: number; x: number; tile: number; palette: number;
  hflip: boolean; vflip: boolean; behind: boolean; unlit: boolean; size: 8 | 16; hidden: boolean;
};

export function decodeOam(oam: Uint8Array, i: number): Sprite {
  const o = i * 8, w = (k: number) => oam[o + k] | (oam[o + k + 1] << 8);
  const attr = w(4);
  return {
    index: i, y: sx(w(0), 9), x: sx(w(2), 9), tile: attr & 1023, palette: (attr >> 10) & 3,
    hflip: (attr & 0x1000) !== 0, vflip: (attr & 0x2000) !== 0, behind: (attr & 0x4000) !== 0, unlit: (attr & 0x8000) !== 0,
    size: oam[o + 6] & 1 ? 16 : 8, hidden: (oam[o + 6] & 2) !== 0,
  };
}

export function oamFlags(s: Sprite): string {
  return [s.unlit && "unlit", s.behind && "behind", s.hflip && "hflip", s.vflip && "vflip", s.hidden && "hidden"].filter(Boolean).join(" ");
}

// ------------------------------------------------------------------ light field
export const SHAPES = ["diamond", "square", "octagon", "band"] as const;
export type Light = { index: number; x: number; y: number; intensity: number; falloff: number; shape: (typeof SHAPES)[number]; on: boolean };

export function decodeLight(regs: Record<string, number>, i: number): Light {
  const f = regs[`L${i}F`] ?? 0, intensity = sx(regs[`L${i}I`] ?? 0, 4);
  return { index: i, x: sx(regs[`L${i}X`] ?? 0, 10), y: sx(regs[`L${i}Y`] ?? 0, 10), intensity, falloff: f & 7, shape: SHAPES[(f >> 4) & 3], on: intensity !== 0 };
}

/**
 * Shade (0-7) the light field gives a LIT pixel at screen (x, y) with these registers
 * (FIXED when the light field is disabled). Unlit pixels always take FIXED; see shadeOverlay.
 */
export function litShade(regs: Record<string, number>, x: number, y: number): number {
  if (!((regs.VCTRL ?? 0) & 16)) return (regs.FIXED ?? 0) & 7;
  let sum = (regs.AMBIENT ?? 0) & 7;
  for (let i = 0; i < 4; i++) {
    const L = decodeLight(regs, i);
    if (!L.on) continue;
    const dx = Math.abs(x - L.x), dy = Math.abs(y - L.y), s = SHAPES.indexOf(L.shape);
    const d = s === 0 ? dx + dy : s === 1 ? Math.max(dx, dy) : s === 2 ? (dx > dy ? dx + (dy >> 1) : dy + (dx >> 1)) : dy;
    const mag = Math.abs(L.intensity) - (d >> L.falloff);
    if (mag > 0) sum += L.intensity < 0 ? -mag : mag;
  }
  return sum & 7;
}

/**
 * Shade and base colour index of every pixel of the frame the current video state
 * renders (256 x 224), computed by the renderer itself: each line is rendered with a
 * probe CRAM whose entry shade*64+base encodes (shade, base), so compositing, unlit
 * flags and FIXED follow render.ts exactly. The machine's state is not modified.
 */
export function shadeOverlay(v: VideoState): { shade: Uint8Array; base: Uint8Array } {
  const cram = new Uint16Array(512);
  for (let s = 0; s < 8; s++) for (let b = 0; b < 64; b++) cram[s * 64 + b] = (s << 8) | b;
  const probe: VideoState = { vram: v.vram, oam: v.oam, cram, regs: v.regs };
  const line = new Uint32Array(256), shade = new Uint8Array(256 * 224), base = new Uint8Array(256 * 224);
  for (let y = 0; y < 224; y++) {
    renderLine(probe, y, line);
    for (let x = 0; x < 256; x++) {
      const c = line[x], i = y * 256 + x;
      shade[i] = ((c >> 16) & 255) / 17;
      base[i] = (((c >> 8) & 255) / 17) * 16 + (c & 255) / 17;
    }
  }
  return { shade, base };
}

/** Overlay colour per shade 0-7 (dark blue through amber to white), 0xRRGGBB. */
export const SHADE_RAMP = [0x0b1030, 0x1f2a78, 0x3a4fc0, 0x3f9f9a, 0x8cc84b, 0xf0c93a, 0xf58a2e, 0xffffff];

// ------------------------------------------------------------------ video memory
function tilePixel(vram: Uint8Array, tile: number, px: number, py: number): number {
  const a = (tile * 24 + py) & 0x7fff, bit = 7 - px;
  return ((vram[a] >> bit) & 1) | (((vram[(a + 8) & 0x7fff] >> bit) & 1) << 1) | (((vram[(a + 16) & 0x7fff] >> bit) & 1) << 2);
}

/** All 1024 tiles as a 256 x 256 sheet (32 per row) in palette 0-7 (4-7 = sprite palettes) at a shade 0-7. */
export function renderTileSheet(vram: Uint8Array, cram: Uint16Array, palette: number, shade: number): Uint32Array {
  const out = new Uint32Array(256 * 256), pal = new Uint32Array(8);
  for (let p = 0; p < 8; p++) pal[p] = rgbOf(cram[(shade & 7) * 64 + (palette & 7) * 8 + p]);
  for (let t = 0; t < 1024; t++) {
    const ox = (t & 31) * 8, oy = (t >> 5) * 8;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[(oy + y) * 256 + ox + x] = pal[tilePixel(vram, t, x, y)];
  }
  return out;
}

/** A 64 x 32 background map at base mapReg x 2048 as a 512 x 256 image at one shade; colour 0 shows the backdrop. */
export function renderMap(vram: Uint8Array, cram: Uint16Array, mapReg: number, shade: number): Uint32Array {
  const out = new Uint32Array(512 * 256), base = (mapReg & 15) * 2048, s = (shade & 7) * 64;
  for (let ty = 0; ty < 32; ty++) for (let tx = 0; tx < 64; tx++) {
    const a = (base + (ty * 64 + tx) * 2) & 0x7fff;
    const e = vram[a] | (vram[(a + 1) & 0x7fff] << 8), pal = ((e >> 10) & 3) * 8;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const p = tilePixel(vram, e & 1023, e & 0x1000 ? 7 - x : x, e & 0x2000 ? 7 - y : y);
      out[(ty * 8 + y) * 512 + tx * 8 + x] = rgbOf(cram[s + (p ? pal + p : 0)]);
    }
  }
  return out;
}
