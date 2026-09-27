// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Asset converter: Cyclorama ".art" text files -> CYASM include text.
// Art stays human-readable source; ROM builds convert it on demand, so the
// ROM remains a pure function of the repository. Lives in src/ because the SCRIM compiler
// (src/scrim/compile.ts) links assets through sourceReader; tools/art.ts re-exports it for the kit.
//
// Format (one directive per block; ';' starts a comment line):
//   @tiles NAME        rows of pixels 0-7 ('.' = 0); width and height multiples of 8;
//                      emitted as 8x8 tiles in row-major order
//   @sprite16 NAME     exactly 16x16; emitted as tiles TL, TR, BL, BR (Barndoor 16x16 order)
//   @palette NAME      up to 7 colours ($RGB) for indices 1-7; index 0 = $000 unless the line
//                      starts with "0=$RGB"
// Each tile/sprite block defines NAME (address of its data) and NAME_TILES (tile count).

import { convertSong } from "./song.ts";

type Block = { kind: string; name: string; line: number; rows: { text: string; line: number }[] };

export function convertArt(text: string, file: string): string {
  const blocks: Block[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/;.*$/, "").trim();
    if (!line) return;
    const m = /^@(\w+)\s+([A-Za-z_]\w*)$/.exec(line);
    if (line.startsWith("@")) {
      if (!m) throw new Error(`${file}:${i + 1}: malformed directive '${line}'`);
      if (!["tiles", "sprite16", "palette"].includes(m[1])) throw new Error(`${file}:${i + 1}: unknown directive @${m[1]}`);
      blocks.push({ kind: m[1], name: m[2], line: i + 1, rows: [] });
      return;
    }
    if (!blocks.length) throw new Error(`${file}:${i + 1}: data before any @directive`);
    blocks[blocks.length - 1].rows.push({ text: line, line: i + 1 });
  });

  const out = [`; Generated from ${file.replace(/\\/g, "/")} by tools/art.ts — do not edit.`, "        .align 2"];
  for (const b of blocks) {
    if (b.kind === "palette") { out.push(...palette(b, file)); continue; }
    const px = b.rows.map(r => [...r.text].map((c, x) => {
      if (c === ".") return 0;
      const v = c.charCodeAt(0) - 48;
      if (v < 0 || v > 7) throw new Error(`${file}:${r.line}: pixel '${c}' at column ${x + 1} is not 0-7 or '.'`);
      return v;
    }));
    const h = px.length, w = px[0]?.length ?? 0;
    px.forEach((row, y) => { if (row.length !== w) throw new Error(`${file}:${b.rows[y].line}: row width ${row.length}, expected ${w}`); });
    if (b.kind === "sprite16" && (w !== 16 || h !== 16)) throw new Error(`${file}:${b.line}: @sprite16 ${b.name} must be 16x16 (got ${w}x${h})`);
    if (!h || h % 8 || w % 8) throw new Error(`${file}:${b.line}: @tiles ${b.name} must be a multiple of 8 in both directions (got ${w}x${h})`);
    const order: [number, number][] = b.kind === "sprite16" ? [[0, 0], [8, 0], [0, 8], [8, 8]] : [];
    if (!order.length) for (let ty = 0; ty < h; ty += 8) for (let tx = 0; tx < w; tx += 8) order.push([tx, ty]);
    out.push(`${b.name}:`);
    for (const [ox, oy] of order) {
      const bytes: number[] = [];
      for (let plane = 0; plane < 3; plane++) for (let y = 0; y < 8; y++) {
        let v = 0;
        for (let x = 0; x < 8; x++) if ((px[oy + y][ox + x] >> plane) & 1) v |= 0x80 >> x;
        bytes.push(v);
      }
      for (let i = 0; i < 24; i += 12) out.push("        .byte " + bytes.slice(i, i + 12).map(hex2).join(", "));
    }
    out.push(`${b.name}_TILES = ${order.length}`);
  }
  return out.join("\n") + "\n";
}

const hex2 = (v: number) => "$" + v.toString(16).toUpperCase().padStart(2, "0");
const hex3 = (v: number) => "$" + v.toString(16).toUpperCase().padStart(3, "0");

function palette(b: Block, file: string): string[] {
  const toks = b.rows.flatMap(r => r.text.split(/[\s,]+/).filter(Boolean).map(t => ({ t, line: r.line })));
  const cols = [0, 0, 0, 0, 0, 0, 0, 0];
  let i = 1;
  for (const { t, line } of toks) {
    const m0 = /^0=\$([0-9A-Fa-f]{3})$/.exec(t);
    if (m0) { cols[0] = parseInt(m0[1], 16); continue; }
    const m = /^\$([0-9A-Fa-f]{3})$/.exec(t);
    if (!m) throw new Error(`${file}:${line}: palette colour '${t}' must be $RGB`);
    if (i > 7) throw new Error(`${file}:${line}: a palette has at most 7 colours plus colour 0`);
    cols[i++] = parseInt(m[1], 16);
  }
  return [`${b.name}:`, "        .word " + cols.map(hex3).join(", ")];
}

const asText = (c: string | Uint8Array) => (typeof c === "string" ? c : new TextDecoder("utf-8").decode(c));

/**
 * Wrap a file reader so that a request for "x.art.inc" (or "x.song.inc") that has no file on disk
 * is produced by converting "x.art" (convertArt) or "x.song" (convertSong, src/assets/song.ts). Used by
 * every ROM build.
 */
export function sourceReader(read: (p: string) => string | Uint8Array): (p: string) => string | Uint8Array {
  return (p: string) => {
    if (p.endsWith(".art.inc")) {
      try { return read(p); } catch { /* generate */ }
      const src = p.slice(0, -4);
      return convertArt(String(read(src)), src);
    }
    if (p.endsWith(".song.inc")) {
      try { return read(p); } catch { /* generate */ }
      const src = p.slice(0, -4);
      return convertSong(asText(read(src)), src);
    }
    return read(p);
  };
}
