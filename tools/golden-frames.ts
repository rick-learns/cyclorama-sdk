// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// node tools/golden-frames.ts [--update]
// Golden-frame regression, a lightweight cousin of Dolphin's FifoCI and mGBA's CInema. Each
// completion replay (replays/*.replay.json) is played from power-on against its exact ROM, and
// the rendered picture at a few fixed checkpoints is hashed. tests/golden/frames.json holds the
// expected hashes; tests/golden/frames/<rom>@<frame>.png holds the same pictures for humans and
// for diffs. A replay's state hash covers RAM, VRAM, registers, CPU and audio but not the
// renderer's output, so this is what catches a video regression.
//
// Check (default): exits 1 on any mismatch and writes <rom>@<frame>.{actual,expected,diff}.png to
// .tmp/golden/ (CI uploads .tmp/ when a run fails). The diff paints differing pixels magenta over
// a dimmed copy of the expected frame.
// --update: rewrites frames.json and the reference PNGs from the current emulator. Only do this
// for an intended rendering change or a new/re-recorded replay, and say so in the commit.
// In the test tier a long replay's goldens are checked on the completion run its game's own test
// already makes (goldenRecorder), so the game is emulated once; tests/golden-frames.test.ts
// plays the rest and checks that every replay-backed cartridge is covered one way or the other.
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildOne, discoverRoms, loadScrim, sha256 } from "./build-roms.ts";
import { padsFromEntries, replayFiles, type PadEntry, type ReplayFile } from "./replay.ts";
import { Machine } from "../src/machine/machine.ts";
import { Tally } from "../src/machine/cpu.ts";

export const W = 256, H = 224;
export const GOLDEN_FILE = "tests/golden/frames.json";
export const GOLDEN_PNG_DIR = "tests/golden/frames";
export const OUT_DIR = ".tmp/golden";

export type GoldenFile = {
  note: string;
  replays: Record<string, { replay: string; romSha256: string; frames: Record<string, string> }>;
};
export type GoldenResult = { rom: string; frame: number; pass: boolean; hash: string; detail: string };

/** Framebuffer (0xRRGGBB per pixel) as packed RGB24 rows: the byte order is fixed, never host-endian. */
function rgb24(fb: Uint32Array): Buffer {
  const out = Buffer.alloc(fb.length * 3);
  for (let i = 0, o = 0; i < fb.length; i++) { const c = fb[i]; out[o++] = (c >> 16) & 255; out[o++] = (c >> 8) & 255; out[o++] = c & 255; }
  return out;
}

/** First 16 hex digits of the SHA-256 of the frame's RGB24 bytes. */
export function frameHash(fb: Uint32Array): string {
  return createHash("sha256").update(rgb24(fb)).digest("hex").slice(0, 16);
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b: Buffer) => { let c = -1; for (const v of b) c = CRC[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type: string, data: Buffer): Buffer {
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0); td.copy(out, 4); out.writeUInt32BE(crc32(td), 8 + data.length);
  return out;
}
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** A 256×224 truecolour PNG of the frame (filter 0 on every row). */
export function encodeFramePng(fb: Uint32Array): Buffer {
  const px = rgb24(fb), raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) px.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([SIG, chunk("IHDR", ih), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Decode a PNG written by encodeFramePng (256×224, 8-bit RGB, filter 0). Anything else throws. */
export function decodeFramePng(png: Buffer): Uint32Array {
  if (png.length < 8 || !png.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  const idat: Buffer[] = [];
  let ok = false;
  for (let p = 8; p + 8 <= png.length;) {
    const len = png.readUInt32BE(p), type = png.toString("ascii", p + 4, p + 8), data = png.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") ok = data.readUInt32BE(0) === W && data.readUInt32BE(4) === H && data[8] === 8 && data[9] === 2 && data[12] === 0;
    if (type === "IDAT") idat.push(data);
    p += 12 + len;
  }
  if (!ok) throw new Error("PNG is not a 256x224 RGB8 frame");
  const raw = inflateSync(Buffer.concat(idat)), fb = new Uint32Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 3);
    if (raw[row] !== 0) throw new Error("PNG uses a row filter this decoder does not handle");
    for (let x = 0; x < W; x++) { const o = row + 1 + x * 3; fb[y * W + x] = (raw[o] << 16) | (raw[o + 1] << 8) | raw[o + 2]; }
  }
  return fb;
}

/** Differing pixels in magenta over a dimmed grey copy of `expected`, with their count and bounding box. */
export function diffFrames(expected: Uint32Array, actual: Uint32Array) {
  const image = new Uint32Array(W * H);
  let count = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let i = 0; i < image.length; i++) {
    const e = expected[i] & 0xffffff, a = actual[i] & 0xffffff;
    if (e !== a) {
      image[i] = 0xff00ff; count++;
      const x = i % W, y = (i / W) | 0;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    } else {
      const g = ((((e >> 16) & 255) + ((e >> 8) & 255) + (e & 255)) / 9) | 0; // a third of the luminance
      image[i] = (g << 16) | (g << 8) | g;
    }
  }
  return { image, count, box: count ? { x0, y0, x1, y1 } : null };
}

/** Early frame, the quartiles and the final frame of an N-frame replay. */
export function defaultCheckpoints(frames: number): number[] {
  const c = [Math.min(60, frames), Math.round(frames / 4), Math.round(frames / 2), Math.round((3 * frames) / 4), frames];
  return [...new Set(c)].filter(f => f >= 1).sort((a, b) => a - b);
}

/** Rebuild the replay's ROM from source; it must be the exact ROM the replay was recorded on. */
export async function loadReplayRom(r: ReplayFile): Promise<Uint8Array> {
  const src = discoverRoms().find(s => s.name === r.rom);
  if (!src) throw new Error(`no ROM source named '${r.rom}'`);
  if (src.lang === "scrim") await loadScrim();
  const rom = buildOne(src);
  const sha = sha256(rom);
  if (sha !== r.romSha256) throw new Error(`${r.rom}: ROM sha256 ${sha.slice(0, 12)}… is not the replay's ${r.romSha256.slice(0, 12)}… (re-record the replay first, then the goldens)`);
  return rom;
}

/** Power on, feed the replay's input, and copy the framebuffer after each checkpoint frame (1-based: after N frames). */
export function renderCheckpoints(rom: Uint8Array, pads: PadEntry[], checkpoints: number[]): Map<number, Uint32Array> {
  const want = new Set(checkpoints), last = Math.max(...checkpoints), input = padsFromEntries(pads);
  const m = new Machine(rom, { cpu: new Tally() }), out = new Map<number, Uint32Array>();
  for (let f = 0; f < last; f++) {
    const [a, b] = input(f);
    m.runFrame(a, b);
    if (want.has(f + 1)) out.set(f + 1, m.framebuffer.slice());
  }
  return out;
}

const readReplay = (file: string) => JSON.parse(readFileSync(file, "utf8")) as ReplayFile;
const posix = (p: string) => p.replace(/\\/g, "/");

/** One checkpoint's verdict; a mismatch writes <rom>@<frame>.{actual,expected,diff}.png to outDir. */
function compareShot(rom: string, frame: number, fb: Uint32Array, want: string, pngDir: string, outDir: string): GoldenResult {
  const hash = frameHash(fb);
  if (hash === want) return { rom, frame, pass: true, hash, detail: "ok" };
  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, `${rom.replace(/\//g, "__")}@${frame}`);
  writeFileSync(`${base}.actual.png`, encodeFramePng(fb));
  let detail = `hash ${hash}, expected ${want}`;
  const ref = join(pngDir, `${rom}@${frame}.png`);
  if (existsSync(ref)) {
    const expected = decodeFramePng(readFileSync(ref));
    const d = diffFrames(expected, fb);
    writeFileSync(`${base}.expected.png`, encodeFramePng(expected));
    writeFileSync(`${base}.diff.png`, encodeFramePng(d.image));
    detail += d.box ? `; ${d.count} pixels differ in x ${d.box.x0}-${d.box.x1}, y ${d.box.y0}-${d.box.y1}` : "; reference PNG equals the actual frame (frames.json and the PNG disagree)";
  }
  return { rom, frame, pass: false, hash, detail: `${detail} (see ${posix(base)}.*.png)` };
}

/** The golden entry must belong to the replay as it is now (same ROM). */
function staleReason(r: ReplayFile, g: GoldenFile["replays"][string]): string | null {
  return r.romSha256 === g.romSha256 ? null
    : `the replay was re-recorded on another ROM (${r.romSha256.slice(0, 12)}… vs golden ${g.romSha256.slice(0, 12)}…): run node tools/golden-frames.ts --update`;
}

/** Play every replay (or those of the `only` ROMs) from power-on and compare its checkpoints. */
export async function checkGolden(o: { goldenFile?: string; pngDir?: string; outDir?: string; only?: string[] } = {}): Promise<GoldenResult[]> {
  const golden = JSON.parse(readFileSync(o.goldenFile ?? GOLDEN_FILE, "utf8")) as GoldenFile;
  const pngDir = o.pngDir ?? GOLDEN_PNG_DIR, outDir = o.outDir ?? OUT_DIR;
  rmSync(outDir, { recursive: true, force: true });
  const results: GoldenResult[] = [];
  for (const [rom, g] of Object.entries(golden.replays)) {
    if (o.only && !o.only.includes(rom)) continue;
    const r = readReplay(g.replay);
    const checkpoints = Object.keys(g.frames).map(Number);
    let shots: Map<number, Uint32Array>;
    try {
      const stale = staleReason(r, g);
      if (stale) throw new Error(stale);
      shots = renderCheckpoints(await loadReplayRom(r), r.pads, checkpoints);
    } catch (e) {
      for (const frame of checkpoints) results.push({ rom, frame, pass: false, hash: "", detail: (e as Error).message });
      continue;
    }
    for (const frame of checkpoints) results.push(compareShot(rom, frame, shots.get(frame)!, g.frames[String(frame)], pngDir, outDir));
  }
  return results;
}

/**
 * The golden check of one replay-backed cartridge on a run its own test already makes, so the
 * completion is emulated once: that test plays the replay's exact input from power-on (and
 * asserts that it does) and calls capture(n, framebuffer) right after frame n (1-based, as
 * renderCheckpoints counts). results() judges every checkpoint as checkGolden does; one never
 * captured fails. Mismatches write their PNGs to outDir (.tmp/golden/), which is not cleared.
 */
export function goldenRecorder(rom: string, o: { goldenFile?: string; pngDir?: string; outDir?: string } = {}) {
  const file = o.goldenFile ?? GOLDEN_FILE, pngDir = o.pngDir ?? GOLDEN_PNG_DIR, outDir = o.outDir ?? OUT_DIR;
  const g = (JSON.parse(readFileSync(file, "utf8")) as GoldenFile).replays[rom];
  if (!g) throw new Error(`${rom}: no golden frames in ${file} (node tools/golden-frames.ts --update)`);
  const checkpoints = Object.keys(g.frames).map(Number).sort((a, b) => a - b);
  const shots = new Map<number, Uint32Array>();
  let last = 0;
  return {
    rom, checkpoints,
    capture(frame: number, fb: Uint32Array) {
      if (frame > last) last = frame;
      if (g.frames[String(frame)] !== undefined && !shots.has(frame)) shots.set(frame, fb.slice());
    },
    results(): GoldenResult[] {
      const stale = staleReason(readReplay(g.replay), g);
      return checkpoints.map(frame => {
        if (stale) return { rom, frame, pass: false, hash: "", detail: stale };
        const fb = shots.get(frame);
        if (!fb) return { rom, frame, pass: false, hash: "", detail: `frame ${frame} was never captured (the run captured up to frame ${last})` };
        return compareShot(rom, frame, fb, g.frames[String(frame)], pngDir, outDir);
      });
    },
  };
}

/** Regenerate frames.json and the reference PNGs for every replay in replays/. */
export async function updateGolden(o: { goldenFile?: string; pngDir?: string } = {}): Promise<GoldenFile> {
  const pngDir = o.pngDir ?? GOLDEN_PNG_DIR;
  rmSync(pngDir, { recursive: true, force: true });
  mkdirSync(pngDir, { recursive: true });
  const out: GoldenFile = {
    note: "Generated by `node tools/golden-frames.ts --update`. Frame hashes (first 16 hex digits of the SHA-256 of the 256x224 picture as RGB24 rows) after N frames of each completion replay, from power-on. Reference pictures: tests/golden/frames/<rom>@<N>.png.",
    replays: {},
  };
  for (const file of replayFiles()) {
    const r = readReplay(file);
    const checkpoints = defaultCheckpoints(r.frames);
    const shots = renderCheckpoints(await loadReplayRom(r), r.pads, checkpoints);
    const frames: Record<string, string> = {};
    for (const f of checkpoints) {
      frames[String(f)] = frameHash(shots.get(f)!);
      writeFileSync(join(pngDir, `${r.rom}@${f}.png`), encodeFramePng(shots.get(f)!));
    }
    out.replays[r.rom] = { replay: posix(file), romSha256: r.romSha256, frames };
  }
  mkdirSync(join(o.goldenFile ?? GOLDEN_FILE, ".."), { recursive: true });
  writeFileSync(o.goldenFile ?? GOLDEN_FILE, JSON.stringify(out, null, 2) + "\n");
  return out;
}

if (/(^|[\\/])golden-frames\.ts$/.test(process.argv[1] ?? "")) {
  // process.exitCode, not process.exit(): see tools/test-tier.ts (Windows pipe assertion).
  if (process.argv.includes("--update")) {
    const g = await updateGolden();
    for (const [rom, e] of Object.entries(g.replays)) console.log(`wrote ${rom}: frames ${Object.keys(e.frames).join(", ")}`);
  } else {
    const results = await checkGolden();
    for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${`${r.rom}@${r.frame}`.padEnd(24)} ${r.hash || "-"}  ${r.detail}`);
    const bad = results.filter(r => !r.pass).length;
    console.log(bad ? `\ngolden-frames: ${bad} of ${results.length} frames differ` : `\ngolden-frames: all ${results.length} frames match`);
    process.exitCode = bad ? 1 : 0;
  }
}
