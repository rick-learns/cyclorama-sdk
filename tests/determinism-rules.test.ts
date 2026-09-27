// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Determinism rules for the code that decides machine behaviour and ROM bytes (docs/guide/architecture.md
// "Where determinism lives"): the emulator core (src/machine, src/isa, src/hw)
// and the toolchain that produces ROMs (src/asm, src/scrim, src/assets) must not read host time
// or randomness, must not use Math functions whose results the language leaves to the host
// (ECMAScript lets sin, pow, log, ... differ in the last bit between engines), and must not use
// timers. Comments, strings and regex literals are blanked first (tools/source-scan.ts), so only
// code can trip a rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blankNonCode, importsOf, lineAt, tsFiles } from "../tools/source-scan.ts";

export const DETERMINISTIC_DIRS = ["src/machine", "src/isa", "src/hw", "src/asm", "src/scrim", "src/assets"];

type Rule = { name: string; re: RegExp };
const INEXACT_MATH = "sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|pow|exp|expm1|log|log1p|log2|log10|sqrt|cbrt|hypot";
export const RULES: Rule[] = [
  { name: "host time or randomness", re: /\bDate\b|\bperformance\s*\.|\bMath\s*\.\s*random\b|\bcrypto\s*\.|\bgetRandomValues\b|\brandom(?:UUID|Bytes|Int)\b|\bprocess\s*\.\s*(?:hrtime|uptime|cpuUsage)\b/g },
  { name: "non-exact Math (result may differ between hosts)", re: new RegExp(`\\bMath\\s*\\.\\s*(?:${INEXACT_MATH})\\b`, "g") },
  { name: "Math used indirectly (call Math.<fn> directly so these rules can see it)", re: /\bMath\b(?!\s*\.)/g },
  { name: "timer", re: /\b(?:setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate|requestAnimationFrame|cancelAnimationFrame|requestIdleCallback)\b/g },
];
/** Host modules the deterministic code must not import. */
const HOST_MODULES = /^(?:node:)?(?:crypto|perf_hooks|timers(?:\/promises)?|worker_threads)$/;

/**
 * Exact uses of a flagged expression, by file and expression text. Each entry must match exactly
 * `count` times, so a new use (or a removed one) fails until this list is updated on purpose.
 */
export const ALLOW: { file: string; expr: string; count: number; why: string }[] = [
  // SCRIM codegen strength-reduces x * 2^k and x / 2^k to shifts. Each call sits behind
  // isPow2(...) (codegen.ts: n > 0 && (n & (n - 1)) === 0), and log2 of a power of two up to
  // 2^16 is an exact integer on every IEEE-754 host.
  { file: "src/scrim/codegen.ts", expr: "Math.log2(size)", count: 1, why: "scale(): element size, isPow2-guarded" },
  { file: "src/scrim/codegen.ts", expr: "Math.log2(k)", count: 2, why: "* and / by a constant, isPow2-guarded" },
];

export type Violation = { file: string; line: number; rule: string; text: string };

/** Rule hits in one file's source, before the allowlist. */
export function scan(file: string, src: string): (Violation & { offset: number })[] {
  const code = blankNonCode(src);
  const out: (Violation & { offset: number })[] = [];
  for (const { name, re } of RULES) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(code));) out.push({ file, line: lineAt(code, m.index), rule: name, text: m[0], offset: m.index });
  }
  for (const r of importsOf(src)) if (HOST_MODULES.test(r.spec)) out.push({ file, line: r.line, rule: "host time or randomness (module import)", text: r.spec, offset: -1 });
  return out;
}

/** Violations across `files` after the allowlist, plus allowlist entries whose count is off. */
export function check(files: { file: string; src: string }[], allow = ALLOW): { violations: Violation[]; stale: string[] } {
  const used = new Map<(typeof allow)[number], number>();
  const violations: Violation[] = [];
  for (const { file, src } of files) {
    const code = blankNonCode(src);
    for (const v of scan(file, src)) {
      const entry = allow.find(a => a.file === file && v.offset >= 0 && code.startsWith(a.expr, v.offset));
      if (entry) { used.set(entry, (used.get(entry) ?? 0) + 1); continue; }
      violations.push({ file: v.file, line: v.line, rule: v.rule, text: v.text });
    }
  }
  const scanned = new Set(files.map(f => f.file));
  const stale = allow.filter(a => scanned.has(a.file) && (used.get(a) ?? 0) !== a.count)
    .map(a => `${a.file}: allowlisted "${a.expr}" expected ${a.count}x, found ${used.get(a) ?? 0}x`);
  return { violations, stale };
}

const fmt = (vs: Violation[]) => vs.map(v => `${v.file}:${v.line}: ${v.rule}: ${v.text}`).join("\n");

test("the deterministic directories are free of host time, randomness, inexact Math and timers", () => {
  const files = tsFiles(DETERMINISTIC_DIRS).map(file => ({ file, src: readFileSync(file, "utf8") }));
  assert.ok(files.length >= 15, `expected the core and toolchain sources, found ${files.length} files`);
  const { violations, stale } = check(files);
  assert.equal(violations.length, 0, `determinism rule broken (docs/guide/architecture.md):\n${fmt(violations)}`);
  assert.deepEqual(stale, [], "update ALLOW in tests/determinism-rules.test.ts");
});

test("every rule fires on a planted violation and names file:line and the rule", () => {
  const planted = [
    "const t = Date.now();", "const d = new Date();", "performance.now();", "Math.random();",
    "crypto.getRandomValues(buf);", "process.hrtime.bigint();", "Math.sin(x);", "Math.pow(2, x);",
    "Math.sqrt(v);", "Math.atan2(y, x);", "Math . log (v);", "const { sin } = Math;",
    "setTimeout(f, 1);", "requestAnimationFrame(f);", 'import { randomBytes } from "node:crypto";',
  ];
  for (const line of planted) {
    const { violations } = check([{ file: "src/machine/planted.ts", src: `// ok\nconst a = 1;\n${line}\n` }]);
    assert.ok(violations.length >= 1, `not caught: ${line}`);
    assert.match(fmt(violations), /^src\/machine\/planted\.ts:3: (host time|non-exact Math|Math used|timer)/, line);
  }
});

test("comments, strings, template text and regex literals do not trip a rule; template holes do", () => {
  const clean = [
    "// Date.now() and Math.sin() in a line comment",
    "/* setTimeout(f) in a block comment\n   Math.random() */ const x = 1;",
    'const s = "Date.now() Math.pow(2, 3)";', "const s = 'performance.now()';",
    "const t = `Math.sqrt(${a + 1}) Date`;", "const re = /Date|Math\\.random/;",
    "const q = a / b; const r = c / Math.max(d, 1);", "const u = { update: 1 }; u.update;",
    "const e = `a${`nested ${b}`}c Math.log(1)`;", 'const esc = "a \\" Math.exp(1)";',
  ];
  for (const src of clean) assert.deepEqual(check([{ file: "src/isa/x.ts", src }]).violations, [], src);
  const hole = check([{ file: "src/isa/x.ts", src: "const t = `v=${Math.cos(a)}`;" }]).violations;
  assert.equal(hole.length, 1);
  assert.equal(hole[0].text, "Math.cos");
});

test("the allowlist is exact: file plus expression, and its count", () => {
  const allow = [{ file: "src/scrim/codegen.ts", expr: "Math.log2(k)", count: 1, why: "test" }];
  const ok = check([{ file: "src/scrim/codegen.ts", src: "x(Math.log2(k));" }], allow);
  assert.deepEqual(ok, { violations: [], stale: [] });
  const otherExpr = check([{ file: "src/scrim/codegen.ts", src: "x(Math.log2(k)); y(Math.log2(n));" }], allow);
  assert.equal(otherExpr.violations.length, 1, "a different expression is not covered");
  const otherFile = check([{ file: "src/scrim/check.ts", src: "x(Math.log2(k));" }], allow);
  assert.equal(otherFile.violations.length, 1, "another file is not covered");
  const extra = check([{ file: "src/scrim/codegen.ts", src: "x(Math.log2(k)); y(Math.log2(k));" }], allow);
  assert.equal(extra.stale.length, 1, "a second use of the same expression needs a count change");
});
