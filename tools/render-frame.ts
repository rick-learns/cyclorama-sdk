// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// npm run frame -- <cartridge.asm | cartridge.scr | image.rom> <frames> <out.png> [--pad <bits>] [--from <frame>] [--scale <n>]
// Builds (or reads) a cartridge, runs it from power-on on the reference emulator for <frames>
// frames and writes the last picture as a 256x224 PNG. --pad holds controller-1 buttons (bit 0 Up,
// 1 Down, 2 Left, 3 Right, 4 A, 5 B, 6 C, 7 START) from frame --from (default 0) on; --scale n
// (1-4) repeats each pixel n x n times. The same inputs always give the same PNG bytes; the docs'
// screenshots are made this way and their tests re-render them.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname } from "node:path";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";
import { buildOne } from "./build-roms.ts";
import { encodeFramePng, H, W } from "./golden-frames.ts";
import { isCliEntry } from "./cli-entry.ts";

const USAGE = "usage: node tools/render-frame.ts <cartridge.asm|.scr|.rom> <frames> <out.png> [--pad <bits>] [--from <frame>] [--scale <1-4>]";

/** The ROM of a source file or ROM image. */
export function romOf(file: string): Uint8Array {
  if (file.endsWith(".rom")) return new Uint8Array(readFileSync(file));
  return buildOne({ name: file, file, lang: file.endsWith(".scr") ? "scrim" : "asm" });
}

/** The machine after `frames` frames from power-on, with `pad` held from frame `from` on. */
export function renderFrame(rom: Uint8Array, frames: number, pad = 0, from = 0): Machine {
  const m = new Machine(rom, { cpu: new Tally() });
  for (let f = 0; f < frames; f++) m.runFrame(f >= from ? pad : 0, 0);
  return m;
}

/** The frame as a PNG, each pixel repeated scale x scale times (scale 1 = tools/golden-frames.ts's PNG). */
export function framePng(fb: Uint32Array, scale = 1): Buffer {
  if (scale === 1) return encodeFramePng(fb);
  const w = W * scale, h = H * scale, raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fb[Math.floor(y / scale) * W + Math.floor(x / scale)], o = y * (1 + w * 3) + 1 + x * 3;
    raw[o] = (c >>> 16) & 255; raw[o + 1] = (c >>> 8) & 255; raw[o + 2] = c & 255;
  }
  const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b: Buffer) => { let c = -1; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]), out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); td.copy(out, 4); out.writeUInt32BE(crc(td), 8 + data.length);
    return out;
  };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function main(argv: string[]): number {
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv.splice(i, 2)[1]) : undefined; };
  const pad = flag("--pad") ?? 0, from = flag("--from") ?? 0, scale = flag("--scale") ?? 1;
  const [file, framesArg, out] = argv;
  const frames = Number(framesArg);
  if (!file || !out || !Number.isInteger(frames) || frames < 1 || !Number.isInteger(pad) || pad < 0 || pad > 255 || ![1, 2, 3, 4].includes(scale)) {
    console.error(USAGE);
    return 2;
  }
  const m = renderFrame(romOf(file), frames, pad, from);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, framePng(m.framebuffer, scale));
  console.log(`frame: ${out} (${file}, frame ${frames}, pad ${pad} from ${from}, scale ${scale}, state hash ${m.hash()})`);
  return 0;
}

if (isCliEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2));
