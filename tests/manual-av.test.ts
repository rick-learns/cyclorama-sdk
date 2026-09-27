// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Manual A/V chapters (video, audio, engineering appendix) must agree with the
// design authority: src/hw/registers.ts, canon/canon-public.json (the open extract of
// canon/canon.json) and docs/spec-notes.md.
// Worked examples in the chapters are recomputed here from first principles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REGISTERS, type Register } from "../src/hw/registers.ts";
import { CYCLES } from "../src/isa/isa.ts";
import { loadPublicCanon, checkProse, denylistHits } from "../tools/canon/lib.ts";
import { fragmentSource } from "../tools/build-manual.ts";

const canon = loadPublicCanon();   // the open extract (canon/canon-public.json)
const hw = canon.core.hardware;
const rule = canon.core.signatureBehavior.rule;

const FILES = {
  video: "docs/manual/src/50-video.html",
  audio: "docs/manual/src/60-audio.html",
  eng: "docs/manual/src/90-appendix-engineering.html",
} as const;
// Read as the manual build reads them (without the SPDX header lines).
const html: Record<keyof typeof FILES, string> = {
  video: fragmentSource(readFileSync(FILES.video, "utf8")),
  audio: fragmentSource(readFileSync(FILES.audio, "utf8")),
  eng: fragmentSource(readFileSync(FILES.eng, "utf8")),
};

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&times;/g, "×").replace(/&minus;/g, "−")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
/** Visible text: tags removed, entities decoded, whitespace collapsed. */
const text = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
/** Source with tags kept but entities decoded and whitespace collapsed (for code/formula checks). */
const src = (s: string) => decode(s).replace(/\s+/g, " ");
const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  assert.ok(m, `attribute ${name} missing in ${tag.slice(0, 80)}`);
  return decode(m[1]);
};

// ---------------------------------------------------------------------------
// Structure and page contract

test("fragments start with a numbered h2 section and use only allowed markup", () => {
  const starts: [keyof typeof FILES, RegExp][] = [
    ["video", /^<h2 id="[a-z0-9-]+">5 /],
    ["audio", /^<h2 id="[a-z0-9-]+">6 /],
    ["eng", /^<h2 id="[a-z0-9-]+">Appendix E/],
  ];
  const allowed = new Set(["figure", "note", "warning", "regtable", "bits"]);
  for (const [k, re] of starts) {
    const h = html[k].trimStart();
    assert.match(h, re, `${FILES[k]} must start with its h2`);
    assert.equal((h.match(/<h2[\s>]/g) ?? []).length, 1, `${FILES[k]} has exactly one h2`);
    for (const m of h.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) assert.ok(allowed.has(c), `${FILES[k]}: class "${c}" not allowed`);
    for (const bad of [/<img/i, /<link/i, /<script/i, /<style/i, /<iframe/i, /\ssrc=/i, /url\((?!#)/i, /href="(?!#)/i, /<html|<body|<head/i])
      assert.ok(!bad.test(h), `${FILES[k]}: external resource or page-level markup ${bad}`);
    for (const m of h.matchAll(/<h[34](?![^>]*\sid=")[^>]*>/g)) assert.fail(`${FILES[k]}: heading without id: ${m[0]}`);
  }
});

test("ids are unique across the three fragments and every internal link resolves", () => {
  const all = Object.values(html).join("\n");
  const ids = [...all.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const seen = new Set<string>();
  for (const id of ids) { assert.ok(!seen.has(id), `duplicate id ${id}`); seen.add(id); }
  for (const m of all.matchAll(/href="#([^"]+)"/g)) assert.ok(seen.has(m[1]), `dangling link #${m[1]}`);
});

test("SVG figures are inline, well-formed enough, and present where required", () => {
  const svgCount = (s: string) => (s.match(/<svg[\s>]/g) ?? []).length;
  for (const [k, s] of Object.entries(html)) {
    assert.equal(svgCount(s), (s.match(/<\/svg>/g) ?? []).length, `${k}: unbalanced svg`);
    for (const m of s.matchAll(/<svg[^>]*>/g)) {
      assert.match(m[0], /viewBox="/, `${k}: svg without viewBox`);
      assert.match(m[0], /role="img"/, `${k}: svg without role=img`);
    }
  }
  for (const id of ["fig-frame-timing", "fig-line-timing", "fig-shape-diamond", "fig-shape-square", "fig-shape-octagon", "fig-shape-band"])
    assert.match(html.video, new RegExp(`id="${id}"[^>]*>[\\s\\S]*?<svg`), `video figure ${id}`);
  assert.ok(svgCount(html.audio) >= 7, "audio needs waveform plots for pulse, triangle, saw, wavetable, noise");
  assert.ok(svgCount(html.eng) >= 1, "engineering appendix needs a pipeline diagram");
});

// ---------------------------------------------------------------------------
// Canon agreement

test("every fragment passes the canon prose checker (dates, prices, hardware claims, denylist)", () => {
  for (const [k, s] of Object.entries(html)) {
    assert.deepEqual(checkProse(k, s, canon).problems, [], `${k} (source)`);
    assert.deepEqual(checkProse(k, text(s), canon).problems, [], `${k} (text)`);
  }
});

test("no denylisted real-world name appears (case-sensitive whole word)", () => {
  for (const [k, s] of Object.entries(html)) {
    assert.deepEqual(denylistHits(s, canon.denylist.terms), [], k);
    assert.deepEqual(denylistHits(text(s), canon.denylist.terms), [], k);
  }
});

test("video chapter states the canon video and timing numbers", () => {
  const t = text(html.video), vt = hw.video_timing, v = hw.video;
  const must = [
    `${v.resolution[0]} × ${v.resolution[1]} pixels`,
    `${v.vramBytes / 1024} KiB VRAM`,
    `up to ${v.maxTiles} tiles`,
    `${v.mapSizeTiles[0]} × ${v.mapSizeTiles[1]}`,
    `${v.sprites} sprites`,
    `${v.spritesPerLine} sprites per line`,
    `${v.cramEntries} CRAM entries`,
    "eight shade planes",
    "four lights",
    `${v.baseColors} base colours`,
    `${vt.masterCyclesPerLine} master cycles per line`,
    `${vt.dotsPerLine} dots`,
    `${vt.cpuCyclesPerLine} CPU cycles`,
    `${vt.linesPerFrame} lines per frame`,
    `${vt.visibleLines} visible lines`,
    `${vt.masterCyclesPerFrame.toLocaleString("en-US")} master cycles = ${vt.cpuCyclesPerFrame.toLocaleString("en-US")} CPU cycles per frame`,
    `${vt.refreshHzApprox.toFixed(2)}`,
    `${(hw.clocks.dotHzApprox / 1e6).toFixed(3)} MHz`,
    `${hw.clocks.masterHzApprox.toLocaleString("en-US")}`.slice(0, 6), // "21,477"
    `${vt.dotsPerLine - vt.visibleDots} dots`,          // horizontal blank
    `${vt.linesPerFrame - vt.visibleLines} lines`,      // vertical blank
    "12-bit",
  ];
  for (const m of must) assert.ok(t.includes(m), `video chapter must state "${m}"`);
});

test("light-field formulas match canon signatureBehavior.rule exactly", () => {
  const s = src(html.video);
  for (const [shape, f] of Object.entries<string>(rule.distance)) {
    assert.ok(s.includes(f), `distance formula for ${shape}: "${f}"`);
    assert.match(s, new RegExp(`${shape}`, "i"));
  }
  for (const f of [rule.level, rule.shade, rule.color]) assert.ok(s.includes(f), `formula "${f}"`);
  assert.ok(s.includes("shade × 64 + palette × 8 + pixel"), "CRAM index formula");
});

test("audio chapter states the canon audio numbers", () => {
  const t = text(html.audio), a = hw.audio;
  for (const m of [
    `sample clock master ÷ ${a.sampleRateDivider}`,
    hw.clocks.audioSampleHzApprox.toLocaleString("en-US"),
    `${a.toneVoices} tone voices`,
    `${a.noiseVoices} noise voice`,
    `${a.volumeBits}-bit volume`,
    "32-step",
    "mono",
  ]) assert.ok(t.includes(m), `audio chapter must state "${m}"`);
});

// ---------------------------------------------------------------------------
// Register coverage: each register has a reference row "addr | name | access" in its chapter

function registerRows(chapter: string, regs: readonly Register[]) {
  for (const r of regs) {
    const re = new RegExp(`<td>${hex4(r.addr)}</td>\\s*<td>(?:<code>)?${r.name}(?:</code>)?</td>\\s*<td>${r.access}</td>`);
    assert.match(chapter, re, `register row for ${r.name} (${hex4(r.addr)}, ${r.access})`);
  }
}

test("every video and DMA register has a reference row in the video chapter", () => {
  registerRows(html.video, REGISTERS.filter(r => r.chip === "video" || r.chip === "dma"));
});

test("every audio register has a reference row in the audio chapter", () => {
  registerRows(html.audio, REGISTERS.filter(r => r.chip === "audio"));
});

test("reset values from registers.ts are stated", () => {
  const t = text(html.video);
  for (const m of ["VINC", "LINECMP", "BG0MAP", "BG1MAP", "FIXED"]) assert.match(t, new RegExp(`${m}[^.]*reset`, "i"), `reset value of ${m}`);
  for (const v of ["511", "6000", "7000"]) assert.ok(t.includes(v));
  assert.match(text(html.audio), /MASTERVOL[^.]*reset[^.]*0/i);
});

// ---------------------------------------------------------------------------
// Spec facts (docs/spec-notes.md §3, §4)

test("video chapter covers every required topic from spec §3", () => {
  const t = text(html.video);
  const topics: [string, RegExp][] = [
    ["tile address n × 24", /n × 24/],
    ["pixel value formula", /p0 \| p1 << 1 \| p2 << 2/],
    ["bit 7 leftmost", /bit 7[^.]*leftmost/],
    ["little-endian VRAM", /little-endian/],
    ["map entry address", /\(ty × 64 \+ tx\) × 2/],
    ["scroll wrap x", /\(x \+ BG0SCX\) mod 512/],
    ["scroll wrap y", /\(y \+ BG0SCY\) mod 256/],
    ["map base ×2048", /× 2048/],
    ["16x16 arrangement", /n \+ 3/],
    ["sprite on line rule", /0 ≤ y − Y < height/],
    ["overflow flag", /VSTAT bit 1/],
    ["lower index wins", /lower OAM index/i],
    ["dot 0 latching", /dot 0/],
    ["unlit uses FIXED", /unlit[^.]*FIXED/],
    ["display disabled", /CRAM\[FIXED × 64\]/],
    ["probe ready at dot 256", /dot 256/],
    ["DMA cost idle", /4 \+ 2 × DMALEN/],
    ["DMA cost active", /4 \+ 4 × DMALEN/],
    ["port wait", new RegExp(`${CYCLES.videoPortWait} extra cycles`)],
    ["interrupt entry", new RegExp(`${CYCLES.interruptEntry} cycles`)],
    ["handler window", /344 master cycles/],
    ["intensity 0 is off", /intensity 0/i],
    ["wrap guidance", /keep totals below 8 for ordinary lighting/],
    ["ramp guidance", /fill shade planes with darkening ramps for natural lighting/],
    ["planes need not be ramps", /not required|need not|does not require/i],
    ["probe can be moved", /PROBEY[^.]*any time|moved at any time|may be changed at any time/i],
  ];
  for (const [what, re] of topics) assert.match(t, re, `video chapter: ${what}`);
});

test("compositing order is the exact six steps of spec §3", () => {
  const m = html.video.match(/<ol id="composite-order">([\s\S]*?)<\/ol>/);
  assert.ok(m, "ordered list #composite-order");
  const items = [...m[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(x => text(x[1]));
  assert.equal(items.length, 6);
  const expect = [/backdrop/i, /BG0[^.]*without priority/, /behind flag set/, /BG1[^.]*without priority/, /behind flag clear/, /BG0[^.]*with priority[^.]*BG1[^.]*with priority/];
  items.forEach((it, i) => assert.match(it, expect[i], `step ${i + 1}: ${it}`));
});

test("worked tile example: bytes and VDATA words match the pixel grid", () => {
  const pix = html.video.match(/<pre id="tile-pixels">([\s\S]*?)<\/pre>/);
  const bytes = html.video.match(/<pre id="tile-bytes">([\s\S]*?)<\/pre>/);
  const words = html.video.match(/<pre id="tile-words">([\s\S]*?)<\/pre>/);
  assert.ok(pix && bytes && words, "tile example blocks");
  const rows = decode(pix[1]).trim().split(/\n/).map(r => r.replace(/[^0-7]/g, "").split("").map(Number));
  assert.equal(rows.length, 8); rows.forEach(r => assert.equal(r.length, 8));
  const want: number[] = [];
  for (let p = 0; p < 3; p++) for (let y = 0; y < 8; y++) {
    let b = 0; for (let x = 0; x < 8; x++) b |= ((rows[y][x] >> p) & 1) << (7 - x); want.push(b);
  }
  const got = [...decode(bytes[1]).matchAll(/\b[0-9A-F]{2}\b/g)].map(m => parseInt(m[0], 16));
  assert.deepEqual(got, want, "tile bytes");
  const gotW = [...decode(words[1]).matchAll(/0x([0-9A-F]{4})\b/g)].map(m => parseInt(m[1], 16));
  const wantW = Array.from({ length: 12 }, (_, i) => want[2 * i] | (want[2 * i + 1] << 8));
  assert.deepEqual(gotW, wantW, "little-endian VDATA words");
});

/** The light-field rule, implemented from canon's rule strings. */
function shadeAt(x: number, y: number, ambient: number, lights: { x: number; y: number; i: number; f: number; shape: string }[]) {
  let sum = ambient;
  for (const L of lights) {
    if (L.i === 0) continue;
    const dx = Math.abs(x - L.x), dy = Math.abs(y - L.y);
    const d = L.shape === "diamond" ? dx + dy : L.shape === "square" ? Math.max(dx, dy)
      : L.shape === "octagon" ? Math.max(dx, dy) + (Math.min(dx, dy) >> 1) : dy;
    sum += Math.sign(L.i) * Math.max(0, Math.abs(L.i) - (d >> L.f));
  }
  return ((sum % 8) + 8) % 8;
}

test("worked lantern example: every tabulated shade follows the canon formula", () => {
  const tbl = html.video.match(/<table[^>]*id="lantern-shades"[^>]*>/);
  assert.ok(tbl, "table#lantern-shades");
  const ambient = Number(attr(tbl[0], "data-ambient"));
  const lights = attr(tbl[0], "data-lights").split(";").map(s => {
    const [x, y, i, f, shape] = s.split(",");
    return { x: +x, y: +y, i: +i, f: +f, shape };
  });
  assert.ok(lights.length >= 2);
  // The register listing must program exactly these values.
  const listing = decode(html.video.match(/<pre id="lantern-code">([\s\S]*?)<\/pre>/)?.[1] ?? "");
  assert.match(listing, new RegExp(`MOV R0, #${ambient}\\s*; ?AMBIENT`), "AMBIENT in listing");
  const shapeNo: Record<string, number> = { diamond: 0, square: 1, octagon: 2, band: 3 };
  lights.forEach((L, n) => {
    for (const [reg, val] of [["X", L.x], ["Y", L.y], ["I", L.i]] as const)
      assert.match(listing, new RegExp(`#${val}\\s*;[^\\n]*\\bL${n}${reg}\\b`), `L${n}${reg}=${val} in listing`);
    assert.match(listing, new RegExp(`#0x${(shapeNo[L.shape] << 4 | L.f).toString(16).toUpperCase().padStart(2, "0")}\\s*;[^\\n]*\\bL${n}F\\b`), `L${n}F in listing`);
  });
  const body = html.video.slice(tbl.index!, html.video.indexOf("</table>", tbl.index!));
  const rows = [...body.matchAll(/<tr data-x="(-?\d+)" data-y="(-?\d+)" data-shade="(\d)">([\s\S]*?)<\/tr>/g)];
  assert.ok(rows.length >= 6, "at least six worked pixels");
  let sawWrap = false;
  for (const r of rows) {
    const x = +r[1], y = +r[2], s = +r[3];
    assert.equal(s, shadeAt(x, y, ambient, lights), `shade at (${x}, ${y})`);
    const cells = [...r[4].matchAll(/<td>([\s\S]*?)<\/td>/g)].map(c => text(c[1]).trim());
    assert.equal(cells[cells.length - 1], String(s), `displayed shade at (${x}, ${y})`);
    if (/wrap/i.test(r[4])) sawWrap = true;
  }
  assert.ok(sawWrap, "the table must include one pixel that shows the adder wrapping");
});

test("wrap is described as documented hardware behaviour", () => {
  const t = text(html.video);
  assert.match(t, /wraps/);
  assert.match(t, /\(AMBIENT \+ sum of the four levels\) mod 8/);
  assert.match(t, /does not saturate|never saturates|not saturate/);
});

test("in-world chapters do not teach later-discovered techniques", () => {
  const later = canon.core.signatureBehavior.techniques.filter((t: any) => t.id !== "lantern");
  const words = [...later.map((t: any) => t.name), "gel swap", "gel-swap", "flying", "overdrive", "follow-spot", "follow spot", "coprocessor", "hidden ink", "X-ray", "contour ring", "interference"];
  for (const [k, s] of Object.entries(html)) for (const w of words)
    assert.ok(!text(s).toLowerCase().includes(w.toLowerCase()), `${k} mentions "${w}"`);
  assert.match(text(html.video), /lantern/i, "the lantern style is the recommended practice");
});

test("in-world text stays in March 1987: no later years, models or anachronisms", () => {
  const eng = html.eng;
  const split = eng.indexOf('id="eng-annex"');
  assert.ok(split > 0, "annex heading #eng-annex");
  const inWorld = [html.video, html.audio, eng.slice(0, split)].map(text).join(" ");
  for (const y of ["1988", "1989", "1990", "1991", "1992", "1993", "1994"]) assert.ok(!inWorld.includes(y), `in-world year ${y}`);
  for (const w of ["CY-2", "FPGA", "emulator", "HDMI", "LUT", "Deep cartridge"]) assert.ok(!inWorld.includes(w), `in-world anachronism ${w}`);
  const annex = text(eng.slice(split));
  assert.match(annex, /Preservation annex \(modern\)/);
  assert.match(annex, /out-of-world|not part of the 1987/i);
  for (const w of ["block RAM", "21.477", "PWM", "I2S", "PLL"]) assert.ok(annex.includes(w), `annex covers ${w}`);
});

test("engineering appendix explains the light pipelines and cost", () => {
  const t = text(html.eng.slice(0, html.eng.indexOf('id="eng-annex"')));
  for (const re of [/up\/down counter/i, /absolute/i, /comparator/i, /barrel shift/i, /3-bit adder/i, /512 × 12/, /line buffer/i, /gates/i, /expensive|cost/i])
    assert.match(t, re);
  const annex = text(html.eng.slice(html.eng.indexOf('id="eng-annex"')));
  for (const re of [/VRAM/, /CRAM/, /OAM/, /line buffer/i, /four light pipelines|light pipelines/i])
    assert.match(annex, re);
});

// ---------------------------------------------------------------------------
// Audio (spec §4)

const SR = 945e6 / 44 / 448;

test("audio chapter covers every required topic from spec §4", () => {
  const t = text(html.audio);
  const topics: [string, RegExp][] = [
    ["phase accumulator", /P ← \(P \+ FREQ\) mod 65536/],
    ["pulse", /8192 × \{1, 2, 4, 6\}\[k\]/],
    ["triangle", /t = P >> 11/],
    ["triangle fold", /31 − t/],
    ["saw", /s = P >> 12/],
    ["wavetable index", /P >> 11/],
    ["silent", /silent/i],
    ["LFSR feedback", /b = \(L \^ \(L >> 1\)\) & 1/],
    ["LFSR shift", /L = \(L >> 1\) \| \(b << 14\)/],
    ["LFSR short", /L = \(L & ~0x40\) \| \(b << 6\)/],
    ["LFSR seed", /7FFF/],
    ["noise output", /s = \(L & 1\) \? 0 : 15/],
    ["voice output", /o = \(2s − 15\) × volume/],
    ["envelope tick", /750 samples/],
    ["envelope rate", /63\.92/],
    ["mix", /\(o0 \+ o1 \+ o2 \+ o3\) × MASTERVOL/],
    ["mix range", /13,500/],
    ["host scaling", /mix × 2/],
    ["key-on", /key-on/i],
    ["key-off", /key-off|keys it off|keyed off/i],
    ["long period", /32,767/],
    ["short period", /\b127\b/],
  ];
  for (const [what, re] of topics) assert.match(t, re, `audio chapter: ${what}`);
});

test("worked FREQ examples round correctly", () => {
  const rows = [...html.audio.matchAll(/<tr data-hz="([\d.]+)" data-freq="(\d+)">([\s\S]*?)<\/tr>/g)];
  assert.ok(rows.length >= 4, "note table rows");
  let a4 = false;
  for (const r of rows) {
    const hz = +r[1], freq = +r[2];
    assert.equal(freq, Math.round(hz * 65536 / SR), `FREQ for ${hz} Hz`);
    const cells = [...r[3].matchAll(/<td>([\s\S]*?)<\/td>/g)].map(c => text(c[1]).trim());
    assert.ok(cells.includes(String(freq)), `FREQ ${freq} shown`);
    assert.ok(cells.includes(hex4(freq)), `FREQ hex ${hex4(freq)} shown`);
    const actual = (freq * SR / 65536).toFixed(2);
    assert.ok(cells.includes(actual), `actual pitch ${actual} shown for ${hz}`);
    if (hz === 440) a4 = true;
  }
  assert.ok(a4, "A4 = 440 Hz example");
  assert.match(text(html.audio), /440 × 65536 \/ 47,940\.34/);
  assert.match(text(html.audio), /601\.49/);
});

test("worked wavetable packing matches the register layout", () => {
  const m = html.audio.match(/<table[^>]*id="wave-example"[^>]*>/);
  assert.ok(m, "table#wave-example");
  const samples = attr(m[0], "data-samples").split(",").map(Number);
  assert.equal(samples.length, 32);
  samples.forEach(v => assert.ok(v >= 0 && v <= 15));
  const body = html.audio.slice(m.index!, html.audio.indexOf("</table>", m.index!));
  const words = [...body.matchAll(/<td>WAVE(\d)<\/td>\s*<td>([0-9A-F]{4})<\/td>/g)];
  assert.equal(words.length, 8);
  for (const w of words) {
    const i = +w[1];
    const want = samples[4 * i] | samples[4 * i + 1] << 4 | samples[4 * i + 2] << 8 | samples[4 * i + 3] << 12;
    assert.equal(w[2], hex4(want), `WAVE${i}`);
  }
});

test("noise LFSR: stated periods and first outputs match the spec algorithm", () => {
  const run = (short: boolean, n: number) => {
    let L = 0x7fff; const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const b = (L ^ (L >> 1)) & 1; L = (L >> 1) | (b << 14);
      if (short) L = (L & ~0x40) | (b << 6);
      out.push(L & 1 ? 0 : 15);
    }
    return out;
  };
  for (const [short, id] of [[false, "lfsr-long"], [true, "lfsr-short"]] as const) {
    const m = html.audio.match(new RegExp(`id="${id}" data-steps="([0-9,]+)"`));
    assert.ok(m, `#${id} with data-steps`);
    const steps = m[1].split(",").map(Number);
    assert.deepEqual(steps, run(short, steps.length), id);
  }
  // Periods
  const period = (short: boolean) => {
    let L = 0x7fff; const seen = new Map<number, number>();
    for (let i = 0; ; i++) {
      if (seen.has(L)) return i - seen.get(L)!;
      seen.set(L, i);
      const b = (L ^ (L >> 1)) & 1; L = (L >> 1) | (b << 14); if (short) L = (L & ~0x40) | (b << 6);
    }
  };
  assert.equal(period(false), 32767);
  assert.equal(period(true), 127);
});

test("mix range and envelope timing arithmetic", () => {
  assert.equal(225 * 4 * 15, 13500);
  assert.equal((SR / 750).toFixed(2), "63.92");
  const t = text(html.audio);
  assert.ok(t.includes((750 / SR * 1000).toFixed(2) + " ms"), "envelope tick period in ms");
  assert.ok(t.includes((65536 / SR).toFixed(4)) || t.includes((SR / 65536).toFixed(4)), "frequency resolution");
});
