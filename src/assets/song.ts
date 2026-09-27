// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Music converter: Cyclorama ".song" text files -> CYASM include text for the Cue Sound Driver
// (roms/lib/cuesound.inc; format and driver documented in roms/lib/README.md).
// Songs stay human-readable source; ROM builds convert them on demand (sourceReader in
// src/assets/art.ts turns a request for "x.song.inc" into convertSong("x.song")), so a ROM remains
// a pure function of the repository. tools/song.ts re-exports this module for the kit.
// FREQ_TABLE uses a non-integer power (2 ** (n/12)); each entry is rounded to an integer and the
// table is spot-checked by tests/song.test.ts, and every ROM that embeds it by its manifest hash.
//
// A .song file holds instruments, patterns, songs and sound effects. ';' starts a comment.
// A line whose first word is instrument / pattern / song / sfx starts a block; the lines after it
// (indent them for readability) belong to that block.
//
//   instrument NAME
//     wave pulse12|pulse25|pulse50|pulse75|triangle|saw|wavetable|silent   (tone voices 0-2)
//          noise|buzz                  (voice 3: long LFSR hiss / short-sequence buzz)
//     env VOLUME [down|up|hold] [PERIOD]   hardware envelope: start volume 0-15, direction,
//                                          one step every PERIOD (1-7) ticks of 15.6 ms; default hold
//     vibrato DEPTH SPEED [delay FRAMES]   DEPTH 1-31 (x 1/1024 of the pitch), SPEED 1-127
//     arp N N ...                          semitone offsets, one per frame, cycled (up to 16)
//     slide N                              FREQ units added per frame (signed): pitch sweeps
//     fixed N                              fixed FREQ (the note's pitch is ignored): drums
//
//   pattern NAME [inst INSTRUMENT]         one row per token:
//     C-4 C#4 Db4 ...   note (octaves 0-8)   ---  or ...   nothing new (the note rings on)
//     off  or  ===      key off              NAME          instrument with a fixed pitch (drums)
//     suffixes: C-4@bass  another instrument for this note;  C-4:4  the event plus 3 empty rows
//     |                 ignored (bar lines for the reader)
//
//   song NAME
//     title "TEXT"                         optional; emits SONG_NAME_TITLE (.asciz)
//     speed N  |  tempo BPM [beat ROWS]    frames per row, or beats per minute (ROWS rows a beat, 4)
//     voices V V ...                       Cue voices this song uses, in order-column order (0 1 2 3)
//     wavetable HEX x 32                   optional: loaded into WAVE0-7 when the song starts
//     order P P ...                        one pattern per voice ('-' = rest); equal lengths
//     loop                                 the next order line is the loop point (omit: play once)
//
//   sfx NAME voice V [priority P] [speed S] [inst INSTRUMENT]
//     tokens as in a pattern; S frames per row (1). The effect borrows voice V from the music.
//
// Output symbols (P = the file's base name as a symbol, e.g. sound-test.song -> sound_test):
//   SONG_name (header), SONG_name_RATE, SONG_name_ROWS, SONG_name_LOOP_ROWS, SONG_name_TITLE
//   SFX_name (header), SNDI_P (instrument table), SNDP_P_pattern, SNDO_/SNDR_/SNDA_/SNDW_ internals.

/** Tempo accumulator unit: a row falls due each time the accumulator passes TEMPO_ONE. */
export const TEMPO_ONE = 55440;            // lcm(1..12) x 2: speeds 1-12, 14, 15, 16 are exact
const MASTER_HZ = 945e6 / 44;
export const SAMPLE_RATE = MASTER_HZ / 448;          // 47,940.34 Hz
export const FRAME_RATE = MASTER_HZ / 358416;        // 59.92 Hz
export const NOTES = 108;                            // C-0 .. B-8

/** FREQ for every note C-0..B-8, equal temperament, A4 = 440 Hz (manual 6.8). */
export const FREQ_TABLE: readonly number[] = Array.from({ length: NOTES }, (_, n) =>
  Math.round(440 * 2 ** ((n - 57) / 12) * 65536 / SAMPLE_RATE));

const SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** "C-4" / "C#4" / "Db4" -> note number (C-0 = 0), or -1. */
export function noteNumber(s: string): number {
  const m = /^([A-G])([-#b])([0-8])$/.exec(s);
  if (!m) return -1;
  const n = Number(m[3]) * 12 + SEMI[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  return n >= 0 && n < NOTES ? n : -1;
}

export function rateForSpeed(framesPerRow: number): number {
  if (!Number.isInteger(framesPerRow) || framesPerRow < 1 || framesPerRow > 255) throw new Error(`speed must be 1-255 frames per row`);
  return Math.round(TEMPO_ONE / framesPerRow);
}
export function rateForBpm(bpm: number, rowsPerBeat = 4): number {
  const r = Math.round(bpm * rowsPerBeat / 60 / FRAME_RATE * TEMPO_ONE);
  if (!(r >= 1 && r <= TEMPO_ONE)) throw new Error(`tempo ${bpm} BPM x ${rowsPerBeat} rows is outside 1 row per ${TEMPO_ONE} frames .. 1 row per frame`);
  return r;
}

const WAVES: Record<string, [number, boolean]> = {
  pulse12: [0, false], pulse25: [1, false], pulse50: [2, false], pulse75: [3, false],
  triangle: [4, false], saw: [5, false], wavetable: [6, false], silent: [7, false],
  noise: [0, true], buzz: [1, true],
};

export type Instrument = {
  name: string; index: number; line: number;
  wave: number; noise: boolean; env: number; fixed: number; slide: number;
  vdepth: number; vspeed: number; vdelay: number; arp: number[];
};
export type Row = { kind: "note"; note: number; inst: Instrument; line: number } | { kind: "rest" } | { kind: "off" };
export type Pattern = { name: string; line: number; rows: Row[] };
export type Step = { line: number; patterns: (string | null)[]; rows: number };
export type Song = {
  name: string; line: number; title?: string; rate: number; voices: number[];
  wavetable?: number[]; steps: Step[]; loopStep: number | null;
};
export type Sfx = { name: string; line: number; voice: number; priority: number; speed: number; rows: Row[] };
export type SongFile = { prefix: string; instruments: Instrument[]; patterns: Pattern[]; songs: Song[]; sfx: Sfx[] };

type Line = { n: number; toks: string[]; text: string };
type Block = { kind: string; head: Line; body: Line[] };

const IDENT = /^[A-Za-z_]\w*$/;
const KINDS = ["instrument", "pattern", "song", "sfx"];

function tokenize(raw: string): string[] {
  const out: string[] = [];
  const re = /"(?:[^"\\]|\\.)*"|[^\s"]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) out.push(m[0]);
  return out;
}
function stripComment(raw: string): string {
  let q = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && q) { i++; continue; }
    if (c === '"') q = !q;
    else if (c === ";" && !q) return raw.slice(0, i);
  }
  return raw;
}

/** Parse a .song file into its model. Throws "file:line: message" on the first error. */
export function parseSong(text: string, file: string): SongFile {
  const fail = (line: number, msg: string): never => { throw new Error(`${file}:${line}: ${msg}`); };
  const num = (s: string | undefined, line: number, what: string, lo: number, hi: number): number => {
    const m = s === undefined ? null : /^(-?)(?:\$([0-9A-Fa-f]+)|0x([0-9A-Fa-f]+)|(\d+))$/.exec(s);
    if (!m) return fail(line, `${what}: expected a number, got '${s ?? ""}'`);
    const v = (m[1] ? -1 : 1) * (m[2] ? parseInt(m[2], 16) : m[3] ? parseInt(m[3], 16) : Number(m[4]));
    if (v < lo || v > hi) return fail(line, `${what} must be ${lo}-${hi} (got ${s})`);
    return v;
  };

  // ---- blocks
  const blocks: Block[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const t = stripComment(raw).trim();
    if (!t) return;
    const toks = tokenize(t), line = { n: i + 1, toks, text: t };
    if (KINDS.includes(toks[0])) blocks.push({ kind: toks[0], head: line, body: [] });
    else if (!blocks.length) fail(i + 1, `unknown block '${toks[0]}' (expected instrument, pattern, song or sfx)`);
    else blocks[blocks.length - 1].body.push(line);
  });
  const names = new Map<string, Set<string>>(KINDS.map(k => [k, new Set<string>()]));
  for (const b of blocks) {
    const name = b.head.toks[1];
    if (!name || !IDENT.test(name)) fail(b.head.n, `${b.kind} needs a name (letters, digits, _), got '${name ?? ""}'`);
    if (KINDS.includes(name)) fail(b.head.n, `'${name}' is a keyword and cannot be a name`);
    if (names.get(b.kind)!.has(name)) fail(b.head.n, `${b.kind} '${name}' defined twice`);
    names.get(b.kind)!.add(name);
  }

  // ---- instruments
  const instruments: Instrument[] = [];
  for (const b of blocks.filter(x => x.kind === "instrument")) {
    if (b.head.toks.length > 2) fail(b.head.n, `unexpected '${b.head.toks[2]}' after instrument name`);
    const ins: Instrument = { name: b.head.toks[1], index: instruments.length, line: b.head.n, wave: 2, noise: false, env: 15, fixed: 0, slide: 0, vdepth: 0, vspeed: 0, vdelay: 0, arp: [] };
    for (const l of b.body) {
      const [k, ...a] = l.toks;
      if (k === "wave") {
        const w = WAVES[a[0]];
        if (!w || a.length !== 1) fail(l.n, `unknown wave '${a.join(" ")}' (pulse12 pulse25 pulse50 pulse75 triangle saw wavetable silent noise buzz)`);
        [ins.wave, ins.noise] = w;
      } else if (k === "env") {
        const vol = num(a[0], l.n, "env start volume", 0, 15);
        const dir = a[1] ?? "hold";
        if (!["down", "up", "hold"].includes(dir)) fail(l.n, `env direction must be down, up or hold (got '${dir}')`);
        const period = dir === "hold" ? 0 : a[2] === undefined ? 1 : num(a[2], l.n, "env period", 1, 7);
        if (a.length > (dir === "hold" ? 2 : 3)) fail(l.n, `too many env values`);
        ins.env = vol | (dir === "up" ? 16 : 0) | (period << 5);
      } else if (k === "vibrato") {
        ins.vdepth = num(a[0], l.n, "vibrato depth", 1, 31);
        ins.vspeed = num(a[1], l.n, "vibrato speed", 1, 127);
        if (a.length > 2) {
          if (a[2] !== "delay" || a.length !== 4) fail(l.n, `vibrato DEPTH SPEED [delay FRAMES]`);
          ins.vdelay = num(a[3], l.n, "vibrato delay", 0, 255);
        }
      } else if (k === "arp") {
        if (a.length < 1 || a.length > 16) fail(l.n, `arp takes 1-16 semitone offsets`);
        ins.arp = a.map(x => num(x, l.n, "arp offset", -107, 107));
      } else if (k === "slide") {
        if (a.length !== 1) fail(l.n, `slide takes one value`);
        ins.slide = num(a[0], l.n, "slide", -32768, 32767);
      } else if (k === "fixed") {
        if (a.length !== 1) fail(l.n, `fixed takes one value`);
        ins.fixed = num(a[0], l.n, "fixed FREQ", 1, 65535);
      } else fail(l.n, `unknown instrument property '${k}' (wave env vibrato arp slide fixed)`);
    }
    instruments.push(ins);
  }
  if (instruments.length > 256) fail(instruments[256].line, `at most 256 instruments per file`);
  const instByName = new Map(instruments.map(i => [i.name, i]));
  const instRef = (name: string, line: number) => instByName.get(name) ?? fail(line, `unknown instrument '${name}'`);

  // ---- rows (patterns and sfx)
  const parseRows = (body: Line[], dflt: Instrument | undefined, head: Line, what: string): Row[] => {
    const rows: Row[] = [];
    for (const l of body) for (const tok of l.toks) {
      if (tok === "|") continue;
      const m = /^([^@:]+)(?:@([^:]*))?(?::(\d+))?$/.exec(tok);
      if (!m) fail(l.n, `bad token '${tok}'`);
      const [, ev, at, count] = m!;
      const n = count === undefined ? 1 : Number(count);
      if (n < 1 || n > 4096) fail(l.n, `rows must be 1-4096 in '${tok}'`);
      let row: Row;
      if (ev === "---" || ev === "...") { if (at !== undefined) fail(l.n, `a rest has no instrument: '${tok}'`); row = { kind: "rest" }; }
      else if (ev === "off" || ev === "===") { if (at !== undefined) fail(l.n, `off has no instrument: '${tok}'`); row = { kind: "off" }; }
      else if (noteNumber(ev) >= 0) {
        const inst = at !== undefined ? instRef(at, l.n) : dflt ?? fail(l.n, `note ${ev} has no instrument (give the ${what} 'inst NAME' or write ${ev}@NAME)`);
        const note = noteNumber(ev);
        if (!inst.fixed) for (const o of inst.arp) if (note + o < 0 || note + o >= NOTES) fail(l.n, `arp offset ${o} takes ${ev} outside C-0..B-8`);
        row = { kind: "note", note, inst, line: l.n };
      } else if (IDENT.test(ev) && at === undefined) {
        const inst = instRef(ev, l.n);
        if (!inst.fixed) fail(l.n, `instrument '${ev}' has no fixed pitch: write a note, e.g. C-4@${ev}`);
        row = { kind: "note", note: 0, inst, line: l.n };
      } else fail(l.n, `bad note or token '${tok}'`);
      rows.push(row!);
      for (let i = 1; i < n; i++) rows.push({ kind: "rest" });
    }
    if (!rows.length) fail(head.n, `${what} '${head.toks[1]}' is empty`);
    return rows;
  };
  const headOpts = (l: Line, from: number, allowed: string[]) => {
    const o: Record<string, string> = {};
    for (let i = from; i < l.toks.length; i += 2) {
      const k = l.toks[i];
      if (!allowed.includes(k)) fail(l.n, `unexpected '${k}' (expected ${allowed.join(", ")})`);
      if (l.toks[i + 1] === undefined) fail(l.n, `'${k}' needs a value`);
      o[k] = l.toks[i + 1];
    }
    return o;
  };

  const patterns: Pattern[] = [];
  for (const b of blocks.filter(x => x.kind === "pattern")) {
    const o = headOpts(b.head, 2, ["inst"]);
    const dflt = o.inst !== undefined ? instRef(o.inst, b.head.n) : undefined;
    patterns.push({ name: b.head.toks[1], line: b.head.n, rows: parseRows(b.body, dflt, b.head, "pattern") });
  }
  const patByName = new Map(patterns.map(p => [p.name, p]));
  const checkVoice = (rows: Row[], voice: number, line: number, what: string) => {
    for (const r of rows) if (r.kind === "note") {
      if (r.inst.noise && voice !== 3) fail(line, `${what} uses noise instrument '${r.inst.name}' but plays on tone voice ${voice}`);
      if (!r.inst.noise && voice === 3) fail(line, `${what} uses tone instrument '${r.inst.name}' but plays on noise voice 3`);
    }
  };

  // ---- songs
  const songs: Song[] = [];
  for (const b of blocks.filter(x => x.kind === "song")) {
    if (b.head.toks.length > 2) fail(b.head.n, `unexpected '${b.head.toks[2]}' after song name`);
    const s: Song = { name: b.head.toks[1], line: b.head.n, rate: 0, voices: [0, 1, 2, 3], steps: [], loopStep: null };
    let loopLine = 0;
    const orderLines: Line[] = [];
    for (const l of b.body) {
      const [k, ...a] = l.toks;
      if (k === "title") {
        const m = a.length === 1 ? /^"((?:[^"\\]|\\.)*)"$/.exec(a[0]) : null;
        if (!m || !/^[\x20-\x7e]*$/.test(m[1])) fail(l.n, `title "TEXT" (printable ASCII)`);
        s.title = m![1];
      } else if (k === "speed") {
        if (a.length !== 1) fail(l.n, `speed FRAMES_PER_ROW`);
        s.rate = rateForSpeed(num(a[0], l.n, "speed", 1, 255));
      } else if (k === "tempo") {
        const bpm = num(a[0], l.n, "tempo BPM", 1, 3600);
        let beat = 4;
        if (a.length > 1) { if (a[1] !== "beat" || a.length !== 3) fail(l.n, `tempo BPM [beat ROWS]`); beat = num(a[2], l.n, "rows per beat", 1, 64); }
        try { s.rate = rateForBpm(bpm, beat); } catch (e) { fail(l.n, (e as Error).message); }
      } else if (k === "voices") {
        if (!a.length || a.length > 4) fail(l.n, `voices takes 1-4 voice numbers`);
        s.voices = a.map(x => num(x, l.n, "voice", 0, 3));
        const dup = s.voices.find((v, i) => s.voices.indexOf(v) !== i);
        if (dup !== undefined) fail(l.n, `voice ${dup} listed twice`);
      } else if (k === "wavetable") {
        const hex = a.join("");
        if (!/^[0-9A-Fa-f]{32}$/.test(hex)) fail(l.n, `wavetable needs 32 hex digits (one 4-bit sample each)`);
        s.wavetable = [...hex].map(c => parseInt(c, 16));
      } else if (k === "order") {
        if (a.length !== s.voices.length) fail(l.n, `order has ${a.length} entries for ${s.voices.length} voices`);
        if (loopLine) { s.loopStep = orderLines.length; loopLine = 0; }
        orderLines.push(l);
      } else if (k === "loop") {
        if (a.length) fail(l.n, `loop takes no values`);
        if (s.loopStep !== null || loopLine) fail(l.n, `only one loop point per song`);
        loopLine = l.n;
      } else fail(l.n, `unknown song property '${k}' (title speed tempo voices wavetable order loop)`);
    }
    if (loopLine) fail(loopLine, `loop must be followed by an order line`);
    if (!s.rate) fail(b.head.n, `song '${s.name}' has no tempo: add 'speed N' or 'tempo BPM'`);
    if (!orderLines.length) fail(b.head.n, `song '${s.name}' has no order lines`);
    for (const l of orderLines) {
      const pats = l.toks.slice(1).map(x => (x === "-" ? null : x));
      let rows = -1;
      pats.forEach((name, c) => {
        if (name === null) return;
        const p = patByName.get(name) ?? fail(l.n, `unknown pattern '${name}'`);
        if (rows >= 0 && p.rows.length !== rows) fail(l.n, `patterns in one order line must have the same length (${pats.filter(Boolean).map(x => `${x} ${patByName.get(x!)?.rows.length}`).join(", ")} rows)`);
        rows = p.rows.length;
        checkVoice(p.rows, s.voices[c], l.n, `pattern '${name}'`);
      });
      if (rows < 0) fail(l.n, `an order line needs at least one pattern`);
      s.steps.push({ line: l.n, patterns: pats, rows });
    }
    songs.push(s);
  }

  // ---- sound effects
  const sfx: Sfx[] = [];
  for (const b of blocks.filter(x => x.kind === "sfx")) {
    const o = headOpts(b.head, 2, ["voice", "priority", "speed", "inst"]);
    if (o.voice === undefined) fail(b.head.n, `sfx '${b.head.toks[1]}' needs 'voice N' (the voice it borrows)`);
    const voice = num(o.voice, b.head.n, "voice", 0, 3);
    const dflt = o.inst !== undefined ? instRef(o.inst, b.head.n) : undefined;
    const rows = parseRows(b.body, dflt, b.head, "sfx");
    checkVoice(rows, voice, b.head.n, `sfx '${b.head.toks[1]}'`);
    sfx.push({
      name: b.head.toks[1], line: b.head.n, voice, rows,
      priority: o.priority === undefined ? 1 : num(o.priority, b.head.n, "priority", 0, 255),
      speed: o.speed === undefined ? 1 : num(o.speed, b.head.n, "speed", 1, 255),
    });
  }

  const base = file.replace(/\\/g, "/").split("/").pop()!.replace(/\.song$/i, "");
  const prefix = base.replace(/\W/g, "_").replace(/^(\d)/, "_$1");
  return { prefix, instruments, patterns, songs, sfx };
}

/** Driver bytecode for a run of rows (see roms/lib/README.md "Pattern bytes"). */
export function encodeRows(rows: Row[]): number[] {
  const out: number[] = [];
  let inst: Instrument | null = null, rest = 0;
  const flush = () => { while (rest > 0) { const k = Math.min(rest, 64); out.push(0x80 + k - 1); rest -= k; } };
  for (const r of rows) {
    if (r.kind === "rest") { rest++; continue; }
    flush();
    if (r.kind === "off") { out.push(0xc0); continue; }
    if (r.inst !== inst) { out.push(0xc1, r.inst.index); inst = r.inst; }
    out.push(r.note);
  }
  flush();
  out.push(0xff);
  return out;
}

const hex = (v: number, d: number) => "$" + (v & (16 ** d - 1)).toString(16).toUpperCase().padStart(d, "0");
function byteLines(bytes: number[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) out.push("        .byte " + bytes.slice(i, i + 16).map(b => hex(b, 2)).join(", "));
  return out;
}

/** Convert a .song file to CYASM include text. Throws "file:line: message" on errors. */
export function convertSong(text: string, file: string): string {
  const m = parseSong(text, file), P = m.prefix;
  const out = [`; Generated from ${file.replace(/\\/g, "/")} by tools/song.ts — do not edit.`, "; Cue Sound Driver data (roms/lib/cuesound.inc).", "        .align 2"];
  // instruments: 16 bytes each
  out.push(`SNDI_${P}:`);
  for (const i of m.instruments) {
    out.push(`        ; ${i.index}: ${i.name}`);
    out.push(`        .byte ${i.wave}, ${hex(i.env, 2)}`);
    out.push(`        .word ${hex(i.fixed, 4)}, ${i.slide}`);
    out.push(`        .byte ${i.vdepth}, ${i.vspeed}, ${i.vdelay}, ${i.arp.length}`);
    out.push(`        .word ${i.arp.length ? `SNDA_${P}_${i.name}` : 0}, 0, 0`);
  }
  for (const i of m.instruments) if (i.arp.length) out.push(`SNDA_${P}_${i.name}:`, `        .byte ${i.arp.join(", ")}`);
  // patterns
  for (const p of m.patterns) out.push(`SNDP_${P}_${p.name}:          ; ${p.rows.length} rows`, ...byteLines(encodeRows(p.rows)));
  const restLens = [...new Set(m.songs.flatMap(s => s.steps.filter(st => st.patterns.includes(null)).map(st => st.rows)))].sort((a, b) => a - b);
  for (const n of restLens) out.push(`SNDR_${P}_${n}:`, ...byteLines(encodeRows(Array.from({ length: n }, () => ({ kind: "rest" as const })))));
  // songs
  for (const s of m.songs) {
    const lists: string[] = [];
    const orderLabel = (v: number) => `SNDO_${P}_${s.name}_${v}`;
    for (let v = 0; v < 4; v++) {
      const c = s.voices.indexOf(v);
      if (c < 0) continue;
      lists.push(`${orderLabel(v)}:`);
      s.steps.forEach((st, k) => {
        const name = st.patterns[c];
        lists.push(`${k === s.loopStep ? `${orderLabel(v)}_L: ` : "        "}.word ${name === null ? `SNDR_${P}_${st.rows}` : `SNDP_${P}_${name}`}`);
      });
      lists.push(`        .word 0, ${s.loopStep === null ? 0 : `${orderLabel(v)}_L`}`);
    }
    const heads = [0, 1, 2, 3].map(v => (s.voices.includes(v) ? orderLabel(v) : "0"));
    const total = s.steps.reduce((n, st) => n + st.rows, 0);
    const loopRows = s.loopStep === null ? 0 : s.steps.slice(s.loopStep).reduce((n, st) => n + st.rows, 0);
    out.push("        .align 2", `SONG_${s.name}:`, `        .word ${s.rate}, SNDI_${P}, ${s.wavetable ? `SNDW_${P}_${s.name}` : 0}`, `        .word ${heads.join(", ")}`, ...lists);
    if (s.wavetable) {
      const w = s.wavetable;
      out.push(`SNDW_${P}_${s.name}:`, "        .word " + [0, 1, 2, 3, 4, 5, 6, 7].map(i => hex(w[4 * i] | (w[4 * i + 1] << 4) | (w[4 * i + 2] << 8) | (w[4 * i + 3] << 12), 4)).join(", "));
    }
    out.push(`SONG_${s.name}_RATE = ${s.rate}`, `SONG_${s.name}_ROWS = ${total}`, `SONG_${s.name}_LOOP_ROWS = ${loopRows}`);
    if (s.title !== undefined) out.push(`SONG_${s.name}_TITLE:`, `        .asciz "${s.title}"`);
  }
  // sound effects
  for (const x of m.sfx) {
    out.push("        .align 2", `SFX_${x.name}:`, `        .byte ${x.voice}, ${x.priority}, ${x.speed}, 0`, `        .word SNDI_${P}`, ...byteLines(encodeRows(x.rows)));
  }
  return out.join("\n") + "\n";
}
