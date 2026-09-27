// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Differential test: random (seeded, deterministic) INT and WORD expressions and conditions are
// compiled, run on the emulator and compared with a reference model of SCRIM's 16-bit semantics.
// Deep nesting forces the register-spill path; calls and divisions appear at every depth; operands
// come from register locals, stack locals, local and global arrays.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, u16, s16 } from "./scrim-harness.ts";

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type N = { src: string; v: number; lit?: number }; // v: 16-bit value 0..65535; lit: a constant leaf

function fuzz(signed: boolean, seed: number) {
  const rand = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const T = signed ? "INT" : "WORD";
  const val = (x: number) => (signed ? s16(x) : u16(x));
  const lit = (v: number): string => { const x = val(v); return x < 0 ? `(${x})` : String(x); };
  const locals = ["a", "b", "c", "d", "e", "f"].map((n) => ({ n, v: u16(int(-40000, 70000)) }));
  const globals = locals.map((l, i) => ({ n: `g${i}`, v: l.v }));
  const arr = Array.from({ length: 8 }, () => u16(int(-40000, 70000)));

  const bin = (op: string, a: number, b: number): number => {
    const as = s16(a), bs = s16(b);
    switch (op) {
      case "+": return u16(a + b);
      case "-": return u16(a - b);
      case "*": return u16(Number((BigInt(a) * BigInt(b)) & 0xffffn));
      case "/": return b === 0 ? 0 : signed ? u16(Math.trunc(as / bs)) : Math.floor(a / b);
      case "MOD": return b === 0 ? a : signed ? u16(as - Math.trunc(as / bs) * bs) : a % b;
      case "AND": return a & b;
      case "OR": return a | b;
      case "XOR": return a ^ b;
      case "SHL": return (a << (b & 15)) & 0xffff;
      default: return signed ? u16(as >> (b & 15)) : a >>> (b & 15); // SHR
    }
  };

  const bytes = ["p", "q"].map((n) => ({ n, v: int(0, 255) }));
  const bytes0 = bytes.map((b) => b.v);
  const leaf = (): N => {
    if (rand() < 0.1) { const b = pick(bytes); return { src: signed ? `INT(${b.n})` : b.n, v: b.v }; }
    switch (int(0, 6)) {
      case 0: case 1: { const l = pick(locals); return { src: l.n, v: l.v }; }
      case 2: { const v = u16(pick([0, 1, 2, 3, 7, 8, 16, 100, 255, 256, 1000, int(0, 65535), -1, -2, -128, -32768])); return { src: `${T}(${lit(v)})`, v, lit: v }; }
      case 3: { const g = pick(globals); return { src: g.n, v: g.v }; }
      case 4: { const k = int(0, 7); return { src: `arr[${k}]`, v: arr[k] }; }
      case 5: { const k = int(0, 7); return { src: `garr[${k}]`, v: arr[k] }; }
      default: { const l = pick(locals); return { src: `id(${l.n})`, v: l.v }; }
    }
  };

  const expr = (depth: number): N => {
    if (depth <= 0 || rand() < 0.15) return leaf();
    const r = rand();
    if (r < 0.06) { const x = expr(depth - 1); return { src: `-(${x.src})`, v: u16(-x.v) }; }
    if (r < 0.1) { const x = expr(depth - 1); return { src: `id(${x.src})`, v: x.v }; }
    if (r < 0.14) { const i = expr(depth - 1); const k = i.v & 7; return { src: `arr[(${i.src}) AND 7]`, v: arr[k] }; }
    if (r < 0.17) { const i = expr(depth - 1); const k = i.v & 7; return { src: `garr[(${i.src}) AND 7]`, v: arr[k] }; }
    const op = pick(["+", "-", "*", "/", "MOD", "AND", "OR", "XOR", "SHL", "SHR", "+", "-", "*", "/"]);
    const a = expr(depth - 1);
    if ((op === "SHL" || op === "SHR") && rand() < 0.6) { const n = int(0, 20); return { src: `(${a.src}) ${op} ${n}`, v: bin(op, a.v, n) }; }
    if ((op === "/" || op === "MOD" || op === "*") && rand() < 0.3) { const n = pick([0, 1, 2, 4, 16, 256, 3, 10]); return { src: `(${a.src}) ${op} ${n}`, v: bin(op, a.v, n) }; }
    const b = expr(depth - 1);
    // an untyped literal next to a typed operand adapts to it (only one side, so no exact-constant folding)
    if (a.lit !== undefined && b.lit === undefined && rand() < 0.5) a.src = lit(a.lit);
    else if (b.lit !== undefined && a.lit === undefined && op !== "SHL" && op !== "SHR" && rand() < 0.5) b.src = lit(b.lit);
    return { src: `(${a.src}) ${op} (${b.src})`, v: bin(op, a.v, b.v) };
  };

  const cmp = (a: number, b: number, op: string): boolean => {
    const x = signed ? s16(a) : a, y = signed ? s16(b) : b;
    return op === "=" ? x === y : op === "<>" ? x !== y : op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
  };
  const cond = (depth: number): { src: string; v: boolean } => {
    const r = rand();
    if (depth > 0 && r < 0.2) { const a = cond(depth - 1), b = cond(depth - 1); return { src: `(${a.src}) AND (${b.src})`, v: a.v && b.v }; }
    if (depth > 0 && r < 0.4) { const a = cond(depth - 1), b = cond(depth - 1); return { src: `(${a.src}) OR (${b.src})`, v: a.v || b.v }; }
    if (depth > 0 && r < 0.5) { const a = cond(depth - 1); return { src: `NOT (${a.src})`, v: !a.v }; }
    const op = pick(["=", "<>", "<", "<=", ">", ">="]);
    const a = expr(2), b = rand() < 0.3 ? { src: "0", v: 0 } : expr(2);
    return { src: `(${a.src}) ${op} (${b.src})`, v: cmp(a.v, b.v, op) };
  };

  const NE = 50, NC = 40;
  // statements, generated in execution order so leaves see the locals' current values
  const body: string[] = [];
  const exprs: N[] = [];
  for (let i = 0; i < NE; i++) {
    const e = expr(int(2, 6));
    exprs.push(e);
    body.push(`  res[${i}] := ${e.src};`);
    const r = rand();
    if (r < 0.25) { const l = pick(locals), x = expr(int(1, 4)); body.push(`  ${l.n} := ${x.src};`); l.v = x.v; }
    else if (r < 0.5) {
      const l = pick(locals), op = pick(["+", "-", "AND", "OR", "XOR", "*"]), x = expr(int(0, 3));
      body.push(`  ${l.n} := ${l.n} ${op} (${x.src});`);
      l.v = bin(op, l.v, x.v);
    } else if (r < 0.65) {
      const b = pick(bytes), x = expr(int(0, 3));
      body.push(`  ${b.n} := ${signed ? `BYTE(${x.src})` : x.src};`);
      b.v = x.v & 255;
    } else if (r < 0.75) {
      const b = pick(bytes), x = int(0, 255);
      body.push(`  ${b.n} := ${b.n} + ${x};`);
      b.v = (b.v + x) & 255;
    }
  }
  const conds = Array.from({ length: NC }, () => cond(3));
  const finals = [...locals.map((l) => ({ n: l.n, v: l.v })), ...bytes.map((b) => ({ n: b.n, v: b.v }))];
  const src = `
PROGRAM Fuzz;
VAR res: ARRAY [${NE}] OF ${T};
    flags: ARRAY [${NC}] OF BYTE;
    fin: ARRAY [8] OF ${T};
    garr: ARRAY [8] OF ${T};
    ${globals.map((g) => g.n).join(", ")}: ${T};
FUNC id(x: ${T}): ${T}; BEGIN RETURN x END;
PROC work;
VAR a, b, c, d, e, f: ${T}; arr: ARRAY [8] OF ${T}; k: WORD; p, q: BYTE;
BEGIN
  ${globals.map((_g, i) => `${"abcdef"[i]} := g${i};`).join(" ")}
  p := ${bytes0[0]}; q := ${bytes0[1]};
  FOR k := 0 TO 7 DO arr[k] := garr[k] END;
${body.join("\n")}
${conds.map((c, i) => `  IF ${c.src} THEN flags[${i}] := 1 ELSE flags[${i}] := 2 END;`).join("\n")}
${finals.map((f, i) => `  fin[${i}] := ${signed && (f.n === "p" || f.n === "q") ? `INT(${f.n})` : f.n};`).join("\n")}
END;
BEGIN
  ${globals.map((g) => `${g.n} := ${lit(g.v)};`).join(" ")}
  ${arr.map((v, k) => `garr[${k}] := ${lit(v)};`).join(" ")}
  work
END.`;
  const t = run(src, { frames: 120 });
  assert.equal(t.stopped, true, "program finished");
  exprs.forEach((e, i) => assert.equal(t.w("res", i), e.v, `res[${i}] := ${e.src}`));
  conds.forEach((c, i) => assert.equal(t.b("flags", i), c.v ? 1 : 2, `IF ${c.src}`));
  finals.forEach((f, i) => assert.equal(t.w("fin", i), f.v, `final value of ${f.n}`));
}

// SCRIM_FUZZ_SEEDS=n runs n seeds per type (default 4) for a longer local soak.
// SCRIM_FUZZ_SEED_BASE=b starts at seed b+1 instead of 1 (the nightly run moves the window every day;
// a failure names its seed, so it reproduces with SCRIM_FUZZ_SEED_BASE=<seed-1> SCRIM_FUZZ_SEEDS=1).
const SEEDS = Number(process.env.SCRIM_FUZZ_SEEDS ?? 4);
const BASE = Number(process.env.SCRIM_FUZZ_SEED_BASE ?? 0);
for (let seed = BASE + 1; seed <= BASE + SEEDS; seed++) {
  test(`differential fuzz: INT expressions and conditions (seed ${seed})`, () => fuzz(true, seed));
  test(`differential fuzz: WORD expressions and conditions (seed ${seed})`, () => fuzz(false, seed + 100));
}

function fixedFuzz(seed: number) {
  const rand = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const fx = Array.from({ length: 4 }, () => u16(int(-6000, 6000)));
  const ix = Array.from({ length: 3 }, () => u16(int(-60, 60)));
  type F = { src: string; v: number };
  const fexpr = (depth: number): F => {
    if (depth <= 0 || rand() < 0.2) { const k = int(0, 3); return { src: `f${k}`, v: fx[k] }; }
    const i = int(0, 2), r = rand();
    const a = fexpr(depth - 1);
    if (r < 0.2) { const b = fexpr(depth - 1); return { src: `(${a.src}) * (${b.src})`, v: u16((s16(a.v) * s16(b.v)) >> 8) }; }
    if (r < 0.35) { const b = fexpr(depth - 1); return { src: `(${a.src}) + (${b.src})`, v: u16(a.v + b.v) }; }
    if (r < 0.5) { const b = fexpr(depth - 1); return { src: `(${a.src}) - (${b.src})`, v: u16(a.v - b.v) }; }
    if (r < 0.6) return { src: `(${a.src}) * i${i}`, v: u16(s16(a.v) * s16(ix[i])) };
    if (r < 0.7) return { src: `(${a.src}) / i${i}`, v: ix[i] === 0 ? 0 : u16(Math.trunc(s16(a.v) / s16(ix[i]))) };
    if (r < 0.8) return { src: `-(${a.src})`, v: u16(-a.v) };
    if (r < 0.9) return { src: `FIXED(TRUNC(${a.src}))`, v: u16((s16(a.v) >> 8) * 256) };
    return { src: `(${a.src}) + 1.25`, v: u16(a.v + 320) };
  };
  const exprs = Array.from({ length: 60 }, () => fexpr(int(1, 5)));
  const fixedLit = (raw: number) => { const x = s16(raw); return `${x < 0 ? "-" : ""}${Math.floor(Math.abs(x) / 256)}.${String(Math.round(((Math.abs(x) % 256) / 256) * 1e8)).padStart(8, "0")}`; };
  const t = run(`
PROGRAM FixFuzz;
VAR r: ARRAY [60] OF FIXED; tr: ARRAY [60] OF INT;
    ${fx.map((_, k) => `f${k}`).join(", ")}: FIXED; ${ix.map((_, k) => `i${k}`).join(", ")}: INT;
BEGIN
  ${fx.map((v, k) => `f${k} := ${fixedLit(v)};`).join(" ")}
  ${ix.map((v, k) => `i${k} := ${s16(v)};`).join(" ")}
${exprs.map((e, k) => `  r[${k}] := ${e.src}; tr[${k}] := TRUNC(r[${k}]);`).join("\n")}
END.`);
  fx.forEach((v, k) => assert.equal(t.w(`f${k}`), v, `literal ${fixedLit(v)}`));
  exprs.forEach((e, k) => {
    assert.equal(t.w("r", k), e.v, `r[${k}] := ${e.src}`);
    assert.equal(t.s("tr", k), s16(e.v) >> 8, `TRUNC of r[${k}]`);
  });
}

for (let seed = BASE + 1; seed <= BASE + SEEDS; seed++) test(`differential fuzz: FIXED arithmetic, FMUL, FIXED*INT, FIXED/INT, TRUNC (seed ${seed})`, () => fixedFuzz(seed + 500));
