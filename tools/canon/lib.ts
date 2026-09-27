// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Canon checking library. canon/canon.json is authoritative; prose extraction
// is defence in depth. Each check returns a list of human-readable problems.
import { readFileSync } from "node:fs";

export type Canon = any;

export function loadCanon(path: string | URL = new URL("../../canon/canon.json", import.meta.url)): Canon {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The committed open extract of canon.json (OPEN-SPEC; `node tools/canon-check.ts --write-public`). */
export const PUBLIC_CANON = new URL("../../canon/canon-public.json", import.meta.url);
export const loadPublicCanon = (): Canon => loadCanon(PUBLIC_CANON);

/**
 * The open extract of the canon (LICENSING.md "canon.json"): the machine and what the open
 * specification states about it, in canon.json's own shape so every check here runs on it
 * unchanged. Kept: the schema notes, `core.hardware`, `core.signatureBehavior`, the cartridge
 * boards, the development kit, the console models, the product the light field descends from
 * (the manual's engineering appendix names it), the people those parts name (id, name, born) and
 * the denylist. Dropped: the lore (company, sales, prices, timeline, failure, extended canon).
 */
export function extractPublicCanon(canon: Canon): Canon {
  const c = canon.core;
  const machine = { hardware: c.hardware, signatureBehavior: c.signatureBehavior, cartridgeGenerations: c.cartridgeGenerations, developmentKit: c.developmentKit };
  const named = JSON.stringify(machine);
  const { title, frozen, currencyFormat, dateFormat } = canon.meta;
  return {
    meta: {
      title: `${title}: open extract`, frozen, currencyFormat, dateFormat,
      note: "Generated from canon/canon.json by extractPublicCanon (tools/canon/lib.ts); never edit by hand. The hardware facts are CC BY 4.0; the names in it remain trademarks (TRADEMARKS.md).",
    },
    core: {
      ...machine,
      console: { models: c.console.models },
      products: c.products,
      people: c.people.filter((p: { id: string }) => named.includes(`"${p.id}"`)).map(({ id, name, born }: { id: string; name: string; born: number }) => ({ id, name, born })),
    },
    extended: {},
    denylist: canon.denylist,
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Every "YYYY-MM" / "YYYY-MM-DD" string value anywhere in the canon object. */
export function canonDates(canon: Canon): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?$/.test(v)) out.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk({ core: canon.core, extended: canon.extended });
  return out;
}

/** Extract prose dates: "September 18, 1987" -> 1987-09-18, "June 1987" -> 1987-06. */
export function proseDates(text: string): { iso: string; raw: string }[] {
  const out: { iso: string; raw: string }[] = [];
  const re = new RegExp(`\\b(${MONTHS.join("|")})(?:\\s+(\\d{1,2}))?,?\\s+(\\d{4})\\b`, "g");
  for (const m of text.matchAll(re)) {
    const mon = MONTHS.indexOf(m[1]) + 1;
    out.push({ iso: m[2] ? `${m[3]}-${pad(mon)}-${pad(+m[2])}` : `${m[3]}-${pad(mon)}`, raw: m[0] });
  }
  return out;
}

export type Price = { currency: string; amount: number };
const priceKey = (p: Price) => `${p.currency}:${p.amount}`;

export function canonPrices(canon: Canon): Set<string> {
  const out = new Set<string>();
  const walk = (v: any) => {
    if (v && typeof v === "object" && typeof v.amount === "number" && typeof v.currency === "string") out.add(priceKey(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk({ core: canon.core, extended: canon.extended });
  return out;
}

/**
 * Extract prose prices: US$179.99, CA$229.99, £149.99. A bare `$` counts as USD only when
 * written with cents ($179.99): in technical documents a bare `$` followed by digits is
 * assembler hexadecimal notation ($1F, $8000), not money.
 */
export function prosePrices(text: string): { key: string; raw: string }[] {
  const out: { key: string; raw: string }[] = [];
  for (const m of text.matchAll(/(US\$|CA\$|£|(?<![A-Za-z0-9])\$(?=\d{1,4}(?:,\d{3})*\.\d{2}(?![0-9A-Za-z])))(\d{1,4}(?:,\d{3})*)(?:\.(\d{2}))?/g)) {
    const currency = m[1] === "CA$" ? "CAD" : m[1] === "£" ? "GBP" : "USD";
    const amount = Number(m[2].replace(/,/g, "")) * 100 + (m[3] ? Number(m[3]) : 0);
    out.push({ key: priceKey({ currency, amount }), raw: m[0] });
  }
  return out;
}

/** Case-sensitive whole-word denylist scan. */
export function denylistHits(text: string, terms: string[]): string[] {
  const hits: string[] = [];
  for (const t of terms) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`).test(text)) hits.push(t);
  }
  return hits;
}

/** Hardware facts stated in prose, each tied to a canon value. */
export function hardwareClaims(canon: Canon): { label: string; re: RegExp; expect: (m: RegExpMatchArray) => boolean }[] {
  const h = canon.core.hardware;
  const kib = (bytes: number) => bytes / 1024;
  const num = (s: string) => Number(s.replace(/,/g, ""));
  return [
    { label: "resolution", re: /(\d+) × (\d+) pixels/g, expect: m => +m[1] === h.video.resolution[0] && +m[2] === h.video.resolution[1] },
    { label: "VRAM", re: /(\d+) KiB VRAM/g, expect: m => +m[1] === kib(h.video.vramBytes) },
    { label: "work RAM", re: /(\d+) KiB work RAM/g, expect: m => +m[1] === kib(h.memory.workRamBytes) },
    { label: "sprites per line", re: /(\d+) sprites per line/g, expect: m => +m[1] === h.video.spritesPerLine },
    { label: "sprite count", re: /(\d+) sprites \(/g, expect: m => +m[1] === h.video.sprites },
    { label: "tile count", re: /up to (\d+) tiles/g, expect: m => +m[1] === h.video.maxTiles },
    { label: "CRAM entries", re: /(\d+) CRAM entries/g, expect: m => +m[1] === h.video.cramEntries },
    { label: "shade planes", re: /(\w+) shade planes/g, expect: m => ["8", "eight"].includes(m[1].toLowerCase()) || !/^\d+$|^(one|two|three|four|five|six|seven|nine|ten)$/i.test(m[1]) },
    { label: "lights", re: /(\d+|four) (?:positioned )?lights/g, expect: m => (m[1] === "four" ? 4 : +m[1]) === h.video.lights },
    // Line-length statements only: "= N CPU cycles" in a timing equation, or "N CPU cycles per line".
    // Instruction and timer timings ("every 256 CPU cycles") are not claims about the line.
    { label: "CPU cycles per line", re: /(?:= (\d+) CPU cycles(?! per frame)|(\d+) CPU cycles per line)/g, expect: m => +(m[1] ?? m[2]) === h.video_timing.cpuCyclesPerLine },
    { label: "CPU cycles per frame", re: /([\d,]+) CPU cycles per frame/g, expect: m => num(m[1]) === h.video_timing.cpuCyclesPerFrame },
    { label: "master cycles per line", re: /(\d+) master cycles per line/g, expect: m => +m[1] === h.video_timing.masterCyclesPerLine },
    { label: "master cycles per frame", re: /([\d,]+) master cycles =/g, expect: m => num(m[1]) === h.video_timing.masterCyclesPerFrame },
    { label: "dots per line", re: /= (\d+) dots/g, expect: m => +m[1] === h.video_timing.dotsPerLine },
    { label: "lines per frame", re: /(\d+) lines per frame/g, expect: m => +m[1] === h.video_timing.linesPerFrame },
    { label: "visible lines", re: /(\d+) visible/g, expect: m => +m[1] === h.video_timing.visibleLines },
    { label: "cartridge RAM", re: /(\d+) KiB (?:optional )?battery/g, expect: m => +m[1] === kib(h.memory.cartridgeRamBytes) },
    { label: "max banks", re: /up to (\d+) banks/g, expect: m => +m[1] === h.memory.maxRomBanks },
    { label: "general registers", re: /(\d+) general registers/g, expect: m => +m[1] === h.cpu.generalRegisters },
    { label: "controller ports", re: /(\d+) controller ports/g, expect: m => +m[1] === h.input.ports },
    { label: "CPU divider", re: /master clock ÷ (\d+)/g, expect: m => +m[1] === h.cpu.clockDivider },
    { label: "audio divider", re: /sample clock master ÷ (\d+)/g, expect: m => +m[1] === h.audio.sampleRateDivider },
    { label: "tone voices", re: /(\d+) tone voices/g, expect: m => +m[1] === h.audio.toneVoices },
    { label: "noise voices", re: /(\d+) noise voice/g, expect: m => +m[1] === h.audio.noiseVoices },
    { label: "volume bits", re: /(\d+)-bit volume/g, expect: m => +m[1] === h.audio.volumeBits },
  ];
}

export type Report = { file: string; problems: string[] };

/** Check a prose document against the canon. `requireCoverage` demands every core timeline date, price and person appear (used for BIBLE.md). */
export function checkProse(file: string, rawText: string, canon: Canon, opts: { requireCoverage?: boolean } = {}): Report {
  const text = rawText.replace(/[ \t]*\r?\n[ \t]*/g, " ");
  const problems: string[] = [];
  const dates = canonDates(canon);
  for (const d of proseDates(text)) if (!dates.has(d.iso)) problems.push(`date "${d.raw}" (${d.iso}) is not a canon date`);
  const prices = canonPrices(canon);
  for (const p of prosePrices(text)) if (!prices.has(p.key)) problems.push(`price "${p.raw}" is not a canon price`);
  for (const t of denylistHits(text, canon.denylist.terms)) problems.push(`denylisted real-world name "${t}"`);
  for (const c of hardwareClaims(canon)) for (const m of text.matchAll(c.re)) if (!c.expect(m)) problems.push(`hardware claim "${m[0]}" contradicts canon ${c.label}`);
  // Birth years stated as "Name** (born YYYY" or "Name (born YYYY".
  for (const p of canon.core.people.concat(canon.extended.people ?? [])) {
    const re = new RegExp(`${p.name}\\**\\s*\\(born (\\d{4})`, "g");
    for (const m of text.matchAll(re)) if (+m[1] !== p.born) problems.push(`${p.name} born ${m[1]} contradicts canon ${p.born}`);
  }
  if (opts.requireCoverage) {
    const found = new Set(proseDates(text).map(d => d.iso));
    for (const t of canon.core.timeline) {
      if (/^\d{4}$/.test(t.date)) { if (!text.includes(`| ${t.date} |`)) problems.push(`timeline year ${t.date} missing`); }
      else if (!found.has(t.date)) problems.push(`timeline date ${t.date} missing`);
    }
    // Coverage is of core prices only; extended prices (accessories, regional histories...)
    // are allowed in prose but BIBLE.md need not repeat them.
    const seen = new Set(prosePrices(text).map(p => p.key));
    for (const k of canonPrices({ core: canon.core, extended: {} })) if (!seen.has(k)) problems.push(`canon price ${k} missing`);
    for (const p of canon.core.people) if (!text.includes(p.name)) problems.push(`person ${p.name} missing`);
    for (const g of canon.core.signatureBehavior.techniques) if (!text.includes(`**${g.name}**`)) problems.push(`technique ${g.name} missing`);
    const u = canon.core.console.unitsSold;
    if (!text.includes(u.total.toLocaleString("en-US"))) problems.push(`units sold ${u.total} missing`);
    for (const [region, n] of Object.entries<number>(u.byRegion)) if (!text.includes(`${n.toLocaleString("en-US")} in ${region === "United States" ? "the United States" : region === "United Kingdom" ? "the United Kingdom" : region}`)) problems.push(`units sold in ${region} missing or wrong`);
  }
  return { file, problems };
}

/** Structural checks on canon.json itself. */
export function checkCanonStructure(canon: Canon): Report {
  const problems: string[] = [];
  const c = canon.core;
  const timelineDates = c.timeline.map((t: any) => t.date);
  const sorted = [...timelineDates].sort();
  if (timelineDates.join() !== sorted.join()) problems.push("core timeline is not in chronological order");
  const launchDates = c.console.launches.map((l: any) => l.date);
  for (const d of launchDates) if (!timelineDates.includes(d)) problems.push(`launch date ${d} missing from timeline`);
  if (!timelineDates.includes(c.console.discontinued)) problems.push("discontinuation missing from timeline");
  const u = c.console.unitsSold;
  const sum = Object.values<number>(u.byRegion).reduce((a, b) => a + b, 0);
  if (sum !== u.total) problems.push(`unitsSold regions sum ${sum} != total ${u.total}`);
  const t = c.hardware.video_timing, k = c.hardware.clocks;
  if (t.masterCyclesPerLine !== t.dotsPerLine * k.dotDivider) problems.push("dots per line inconsistent with dot divider");
  if (t.masterCyclesPerLine !== t.cpuCyclesPerLine * k.cpuDivider) problems.push("CPU cycles per line inconsistent with CPU divider");
  if (t.masterCyclesPerFrame !== t.masterCyclesPerLine * t.linesPerFrame) problems.push("master cycles per frame inconsistent");
  if (t.cpuCyclesPerFrame * k.cpuDivider !== t.masterCyclesPerFrame) problems.push("CPU cycles per frame inconsistent");
  const v = c.hardware.video;
  if (v.baseColors !== (v.palettes.background + v.palettes.sprite) * v.palettes.colorsPerPalette) problems.push("base colours inconsistent with palettes");
  if (v.cramEntries !== v.baseColors * v.shadePlanes) problems.push("CRAM entries inconsistent with base colours x shade planes");
  if (v.shadePlanes !== 8) problems.push("shade planes must be 8 for a 3-bit adder");
  const m = c.hardware.memory;
  if (m.maxCartridgeRomBytes !== m.maxRomBanks * m.romWindowBytes) problems.push("max cartridge ROM inconsistent with banks x window");
  if (c.signatureBehavior.techniques.length < 3) problems.push("signature behaviour needs at least three techniques");
  const json = JSON.stringify({ ...canon, denylist: undefined });
  for (const hit of denylistHits(json, canon.denylist.terms)) problems.push(`canon.json contains denylisted name "${hit}"`);
  // Extended canon dates must lie inside the company's history and releases inside the console's life.
  for (const g of canon.extended.games ?? []) {
    if (g.released && (g.released < c.console.launches[0].date || g.released > c.console.discontinued)) problems.push(`game ${g.title} released ${g.released} outside console life`);
  }
  problems.push(...checkExtended(canon));
  return { file: "canon/canon.json", problems };
}

// ---------------------------------------------------------------------------
// Extended canon: ids, sources, dates, prices, references and period rules.

/** Currencies of the three launch regions; any registered price must use one of them. */
export const CURRENCIES = ["USD", "CAD", "GBP"];

/** Keys that hold a date (YYYY, YYYY-MM or YYYY-MM-DD) wherever they appear in an extended entry. */
const DATE_KEYS = new Set([
  "date", "founded", "formed", "closed", "opened", "introduced", "released", "joined", "left", "contract",
  "ended", "appointed", "dismissed", "from", "until", "firstIssueDate", "firstOnSale", "lastIssueDate",
  "announced", "surfaced", "cancelled", "shipped", "withdrawn", "firstAired", "leaked", "published", "incorporated",
  "licensed",
]);
/** Start/end pairs that must be in order when both are present on one object. */
const SPANS: [string, string][] = [
  ["founded", "closed"], ["formed", "closed"], ["opened", "closed"], ["joined", "left"], ["appointed", "dismissed"],
  ["contract", "ended"], ["introduced", "withdrawn"], ["from", "until"], ["firstIssueDate", "lastIssueDate"],
  ["incorporated", "closed"], ["firstAired", "withdrawn"],
];
/** Physical products sold with or for the console: introduced within the console's life. */
const PRODUCT_KINDS = new Set(["accessory", "retail display", "chip revision", "regional hardware variant"]);
/** Reference fields that must name a registered id. */
const REF_KEYS = ["parent", "maker", "employer", "magazine", "distributor", "agency", "club", "includes"];
/**
 * Third-party marks that the fictional company may never use in its own voice (slogans). "Cyc" is
 * a registered mark of another company: "the Cyc" survives only as the fans' nickname in fiction.
 */
const SLOGAN_FORBIDDEN = ["Cyc"];
/** Allowed statuses for a game registered before its title is chosen and cleared. */
const UNTITLED_STATUSES = new Set(["legendary", "unreleased prototype"]);

const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
function validDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = +m[1], mo = m[2] ? +m[2] : 1, d = m[3] ? +m[3] : 1;
  if (mo < 1 || mo > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= days;
}
/** Compare two ISO dates of possibly different precision on their common prefix (1987-09 == 1987-09-18). */
export function cmpDate(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  const x = a.slice(0, n), y = b.slice(0, n);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function checkExtended(canon: Canon): string[] {
  const problems: string[] = [];
  const c = canon.core, x = canon.extended ?? {};
  const launch = c.console.launches[0].date, end = c.console.discontinued, founded = c.company.founded;

  // Ids: unique across core and extended.
  const ids = new Map<string, string>();
  const claim = (id: string, where: string) => {
    if (ids.has(id)) problems.push(`duplicate id "${id}" (${ids.get(id)} and ${where})`);
    else ids.set(id, where);
  };
  claim(c.company.id, "core.company");
  for (const d of c.company.divisions) claim(d.id, "core.company.divisions");
  for (const p of c.people) claim(p.id, "core.people");
  for (const p of c.products) claim(p.id, "core.products");
  claim(c.console.id, "core.console");
  const arrays = Object.entries<any[]>(x).filter(([, v]) => Array.isArray(v));
  for (const [name, list] of arrays) for (const e of list) {
    const where = `extended.${name}`;
    if (typeof e.id !== "string" || !e.id) { problems.push(`${where} entry without an id: ${JSON.stringify(e).slice(0, 60)}`); continue; }
    claim(e.id, where);
  }

  for (const [name, list] of arrays) for (const e of list) {
    const tag = `${name} ${e.id}`;
    // Sources: every registered entry says where it came from (built games cite their ROM).
    if (!e.source && !e.rom) problems.push(`${tag} has no source`);
    if (/^pc-/i.test(e.id ?? "") || /^PC-/.test(e.id ?? "")) {
      if (!/^pc-\d{3}(-[a-z0-9]+)*$/.test(e.id)) problems.push(`${tag}: proposal id must look like pc-nnn or pc-nnn-suffix`);
      if (!String(e.source ?? "").includes("history/PROPOSED_CANON.md")) problems.push(`${tag}: proposal source must cite history/PROPOSED_CANON.md`);
    }
    // Dates, spans and prices, anywhere inside the entry.
    const walk = (v: any, path: string) => {
      if (Array.isArray(v)) { v.forEach((item, i) => walk(item, `${path}[${i}]`)); return; }
      if (!v || typeof v !== "object") return;
      for (const [k, val] of Object.entries<any>(v)) {
        if (DATE_KEYS.has(k) && val !== null && val !== undefined && !(typeof val === "string" && validDate(val))) problems.push(`${tag}: invalid date ${path}.${k} = ${JSON.stringify(val)}`);
      }
      for (const [a, b] of SPANS) if (typeof v[a] === "string" && typeof v[b] === "string" && cmpDate(v[a], v[b]) > 0) problems.push(`${tag}: ${path}.${a} ${v[a]} is after ${b} ${v[b]}`);
      if ("amount" in v && "currency" in v) {
        if (!CURRENCIES.includes(v.currency)) problems.push(`${tag}: unknown currency ${v.currency} at ${path}`);
        if (!Number.isInteger(v.amount) || v.amount <= 0) problems.push(`${tag}: price amount must be a positive integer number of cents at ${path}`);
      }
      for (const [k, val] of Object.entries<any>(v)) if (val && typeof val === "object") walk(val, `${path}.${k}`);
    };
    walk(e, "");
    // References resolve.
    for (const k of REF_KEYS) if (typeof e[k] === "string" && !ids.has(e[k])) problems.push(`${tag}: ${k} "${e[k]}" is unknown`);
    // Avenell-affiliated entries cannot predate the company.
    if (e.parent === "avenell" || e.employer === "avenell") {
      for (const k of DATE_KEYS) if (typeof e[k] === "string" && cmpDate(e[k], founded) < 0) problems.push(`${tag}: ${k} ${e[k]} is before Avenell was founded (${founded})`);
    }
    // People: born before they join anything.
    if (name === "people" && Number.isInteger(e.born)) {
      for (const k of ["joined", "from"]) if (typeof e[k] === "string" && +e[k].slice(0, 4) < e.born + 14) problems.push(`${tag}: joined ${e[k]} before age 14 (born ${e.born})`);
    }
    // Products sold for the console exist only during its life.
    if (PRODUCT_KINDS.has(e.kind) && typeof e.introduced === "string" && (cmpDate(e.introduced, launch) < 0 || cmpDate(e.introduced, end) > 0)) problems.push(`${tag}: introduced ${e.introduced} outside console life`);
    // Regional price histories: a launch region, its launch currency, after its launch, inside console life.
    if (e.kind === "regional-price-history") {
      const l = c.console.launches.find((l: any) => l.region === e.region);
      if (!l) problems.push(`${tag}: region ${e.region} is not a launch region`);
      for (const p of e.priceHistory ?? []) {
        if (l && p.price?.currency !== l.price.currency) problems.push(`${tag}: ${p.date} price currency ${p.price?.currency} is not ${l.region}'s currency ${l.price.currency}`);
        if (l && cmpDate(p.date, l.date) < 0) problems.push(`${tag}: ${p.date} is before ${l.region}'s launch ${l.date}`);
        if (cmpDate(p.date, end) > 0) problems.push(`${tag}: ${p.date} is after the console was discontinued`);
      }
    }
    // Competitors: made by a registered competitor company, launched while the Cyclorama was a going concern.
    if (e.kind === "competitor console") {
      const maker = (x.entities ?? []).find((m: any) => m.id === e.maker);
      if (maker && maker.kind !== "competitor company") problems.push(`${tag}: maker ${e.maker} is not a competitor company`);
      for (const l of e.launches ?? []) if (typeof l.date === "string" && cmpDate(l.date, end) > 0) problems.push(`${tag}: competitor launch ${l.date} after the Cyclorama was discontinued`);
    }
    // Slogans are the company's own voice: never a third party's mark.
    if (e.kind === "slogans") for (const s of e.slogans ?? []) for (const t of denylistHits(String(s.line ?? ""), SLOGAN_FORBIDDEN)) problems.push(`${tag}: slogan "${s.line}" uses the third-party mark "${t}"`);
    // The definition of core "sold": shipments at discontinuation plus the included lot equal the core total,
    // and each dated statement is true for its date.
    if (e.kind === "units-sold definition") {
      const total = c.console.unitsSold.total;
      const lot = arrays.flatMap(([, list]) => list).find((o: any) => o.id === e.includes);
      const lotConsoles = Number.isInteger(lot?.consoles) ? lot.consoles : 0;
      if (!Number.isInteger(e.netShipmentsAtDiscontinuation)) problems.push(`${tag}: netShipmentsAtDiscontinuation must be an integer`);
      else if (e.netShipmentsAtDiscontinuation + lotConsoles !== total) problems.push(`${tag}: shipments at discontinuation ${e.netShipmentsAtDiscontinuation} + ${e.includes ?? "no lot"} ${lotConsoles} != core unitsSold ${total}`);
      if (lot && typeof lot.date === "string" && cmpDate(lot.date, end) <= 0) problems.push(`${tag}: included lot ${lot.id} (${lot.date}) is not after discontinuation`);
      for (const st of e.statements ?? []) {
        const known = typeof st.date === "string" && cmpDate(st.date, end) <= 0 ? e.netShipmentsAtDiscontinuation : total;
        if (Number.isInteger(st.claimedMoreThan) && !(st.claimedMoreThan < known)) problems.push(`${tag}: statement ${st.date} claims more than ${st.claimedMoreThan}, but only ${known} were shipped by then`);
        if (Number.isInteger(st.claimed) && st.claimed !== known) problems.push(`${tag}: statement ${st.date} claims ${st.claimed}, but ${known} were shipped by then`);
      }
    }
    // Games registered before their title is chosen.
    if (name === "games" && (e.title === null || e.title === undefined) && !UNTITLED_STATUSES.has(e.status)) problems.push(`${tag}: a game without a title must have status ${[...UNTITLED_STATUSES].join(" or ")}`);
    // Catalogue assignments point at a registered numbering scheme.
    if (e.kind === "catalogue assignment") {
      const scheme = (x.entities ?? []).find((s: any) => s.id === e.scheme);
      if (!scheme || scheme.kind !== "numbering scheme") problems.push(`${tag}: scheme "${e.scheme}" is not a registered numbering scheme`);
    }
  }
  problems.push(...checkCatalogue(canon));
  problems.push(...checkGamesAndDevelopers(canon));
  return problems;
}

/**
 * Games fit the console's life and the technique eras (a technique is never used before its era
 * begins); licensed developers are licensed while the kit was out, list only registered games that
 * credit them, and carry a unique four-hex-digit ROM-header developer code (manual ch. 4, offset 0030).
 */
function checkGamesAndDevelopers(canon: Canon): string[] {
  const problems: string[] = [];
  const c = canon.core, x = canon.extended ?? {};
  const launch = c.console.launches[0].date, end = c.console.discontinued;
  const kitShipped = c.developmentKit.language.released; // timeline 1987-03: kit and SCRIM ship to the first licensees
  const techniques = new Map<string, number>(c.signatureBehavior.techniques.map((t: any) => [t.name, +String(t.era).slice(0, 4)]));
  const games = new Map<string, any>((x.games ?? []).map((g: any) => [g.id, g]));
  for (const g of games.values()) {
    const tag = `games ${g.id}`;
    if (typeof g.released === "string" && (cmpDate(g.released, launch) < 0 || cmpDate(g.released, end) > 0)) problems.push(`${tag}: released ${g.released} outside console life (${launch} .. ${end})`);
    if (typeof g.technique === "string") {
      const from = techniques.get(g.technique);
      if (from === undefined) problems.push(`${tag}: technique "${g.technique}" is not a core technique`);
      else if (typeof g.released === "string" && +g.released.slice(0, 4) < from) problems.push(`${tag}: technique ${g.technique} used in ${g.released}, before its era ${from}`);
    }
  }
  const codes = new Map<string, string>();
  for (const d of x.developers ?? []) {
    const tag = `developers ${d.id}`;
    if (typeof d.licensed === "string" && (cmpDate(d.licensed, kitShipped) < 0 || cmpDate(d.licensed, end) > 0)) problems.push(`${tag}: licensed ${d.licensed} outside ${kitShipped} (kit shipped) .. ${end}`);
    for (const id of d.games ?? []) {
      const g = games.get(id);
      if (!g) problems.push(`${tag}: game "${id}" is not registered`);
      else if (g.developer !== d.name) problems.push(`${tag}: game ${id} names developer "${g.developer}", not "${d.name}"`);
    }
    if (d.developerCode !== undefined) {
      if (typeof d.developerCode !== "string" || !/^[0-9A-F]{4}$/.test(d.developerCode)) problems.push(`${tag}: developerCode ${JSON.stringify(d.developerCode)} must be four hex digits (e.g. "000C")`);
      else if (codes.has(d.developerCode)) problems.push(`${tag}: developerCode ${d.developerCode} is issued more than once (also ${codes.get(d.developerCode)})`);
      else codes.set(d.developerCode, d.id);
    }
  }
  return problems;
}

/** Cartridge catalogue numbers (PC-036): CYC-1nnn/5nnn first-party, CYC-2nnn/6nnn licensed. */
const CATALOGUE_RE = /^CYC-([1256])\d{3}$/;
const FIRST_PARTY_PUBLISHER = "Avenell Stagecraft Ltd.";

/** Every catalogue assignment in extended canon: pc-036's own `assignments` plus `catalogue assignment` entries. */
function catalogueAssignments(canon: Canon): { catalogue: string; game: string; where: string }[] {
  const out: { catalogue: string; game: string; where: string }[] = [];
  for (const e of canon.extended?.entities ?? []) {
    if (e.kind === "numbering scheme") for (const a of e.assignments ?? []) out.push({ catalogue: a.catalogue, game: a.game, where: `${e.id}.assignments` });
    if (e.kind === "catalogue assignment") out.push({ catalogue: e.catalogue, game: e.game, where: e.id });
  }
  return out;
}

/** Game id → catalogue number, for artifacts that print the number (site, boxes, manuals). */
export function catalogueNumbers(canon: Canon): Map<string, string> {
  return new Map(catalogueAssignments(canon).map(a => [a.game, a.catalogue]));
}

function checkCatalogue(canon: Canon): string[] {
  const problems: string[] = [];
  const games = new Map<string, any>((canon.extended?.games ?? []).map((g: any) => [g.id, g]));
  const byNumber = new Map<string, string>(), byGame = new Map<string, string>();
  for (const a of catalogueAssignments(canon)) {
    const m = CATALOGUE_RE.exec(String(a.catalogue));
    if (!m) problems.push(`${a.where}: catalogue number ${a.catalogue} is not in the pc-036 scheme (CYC-1nnn, 2nnn, 5nnn, 6nnn)`);
    if (byNumber.has(a.catalogue)) problems.push(`${a.where}: catalogue number ${a.catalogue} is assigned more than once (also ${byNumber.get(a.catalogue)})`);
    else byNumber.set(a.catalogue, a.where);
    const g = games.get(a.game);
    if (!g) { problems.push(`${a.where}: catalogue number ${a.catalogue} names unknown game "${a.game}"`); continue; }
    if (byGame.has(a.game)) problems.push(`${a.where}: game ${a.game} has more than one catalogue number (${byGame.get(a.game)} and ${a.catalogue})`);
    else byGame.set(a.game, a.catalogue);
    const firstParty = g.publisher === FIRST_PARTY_PUBLISHER;
    if (m && firstParty !== (m[1] === "1" || m[1] === "5")) problems.push(`${a.where}: ${firstParty ? "first-party" : "licensed"} game ${a.game} cannot carry ${a.catalogue}`);
  }
  return problems;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", times: "×", minus: "−", divide: "÷",
  ndash: "–", mdash: "—", hellip: "…", larr: "←", rarr: "→", uarr: "↑", darr: "↓", le: "≤", ge: "≥", ne: "≠",
  middot: "·", deg: "°", copy: "©", reg: "®", sect: "§", para: "¶", laquo: "«", raquo: "»", pound: "£",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", thinsp: " ", ensp: " ", emsp: " ", shy: "",
};

/** Visible text of an HTML document: style/script removed, tags replaced by spaces, entities decoded, whitespace collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e] ?? all)
    .replace(/\s+/g, " ")
    .trim();
}
