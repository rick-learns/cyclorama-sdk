// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Source scanning for the repo-rule tests (tests/determinism-rules.test.ts, tests/module-graph.ts)
// and the SDK exporter's import check: a small TypeScript lexer that blanks comments, string
// literals and regular-expression literals, so a rule matched against the result only ever
// sees code. Blanking replaces every character with a space and keeps newlines, so offsets and
// line numbers in the blanked text are the same as in the original.
import { readdirSync, statSync } from "node:fs";

/** Keywords after which a `/` starts a regular expression rather than a division. */
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);

/**
 * `src` with comments, string contents, template-literal text and regex literals replaced by
 * spaces (newlines kept). Quote characters stay, so `from "x"` becomes `from " "`; the code
 * inside a template's `${ ... }` stays code.
 */
export function blankNonCode(src: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " "; };
  // Brace stack: "code" for an ordinary `{`, "tpl" for the `${` that opened a template hole.
  const braces: ("code" | "tpl")[] = [];
  let i = 0;
  let prev = ""; // last significant code character, or the last word
  const scanTemplate = () => {
    // i is just after a backtick or just after the `}` that closed a hole
    const start = i;
    while (i < n) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { blank(start, i); i++; prev = "`"; return; }
      if (c === "$" && src[i + 1] === "{") { blank(start, i); braces.push("tpl"); i += 2; prev = "{"; return; }
      i++;
    }
    blank(start, n);
  };
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      blank(i, stop); i = stop; continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      blank(i, stop); i = stop; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(j, n)); i = j + 1; prev = c; continue;
    }
    if (c === "`") { i++; scanTemplate(); continue; }
    if (c === "/") {
      const isRegex = prev === "" || REGEX_AFTER_WORD.has(prev) || (prev.length === 1 && !/[\w$)\].]/.test(prev) && prev !== "`" && prev !== "'" && prev !== '"');
      if (isRegex) {
        let j = i + 1, inClass = false;
        while (j < n && src[j] !== "\n") {
          const d = src[j];
          if (d === "\\") { j += 2; continue; }
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        blank(i, j); i = j; prev = ")"; continue;
      }
      prev = "/"; i++; continue;
    }
    if (c === "{") { braces.push("code"); prev = "{"; i++; continue; }
    if (c === "}") {
      const top = braces.pop();
      i++;
      if (top === "tpl") { scanTemplate(); continue; }
      prev = "}"; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      prev = src.slice(i, j); i = j; continue;
    }
    if (/\d/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      prev = "0"; i = j; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

/** 1-based line number of `offset` in `text`. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let k = 0; k < offset; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

/** Every `.ts` file under `dirs` (recursive), as sorted posix paths relative to the cwd. */
export function tsFiles(dirs: string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) {
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    for (const f of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
      const p = `${dir}/${f.replace(/\\/g, "/")}`;
      if (p.endsWith(".ts") && !p.includes("/node_modules/")) files.push(p);
    }
  }
  return files.sort();
}

export type ImportRef = { spec: string; line: number; typeOnly: boolean };

/** The module specifiers `src` imports or re-exports (static and literal dynamic imports). */
export function importsOf(src: string): ImportRef[] {
  const code = blankNonCode(src);
  const refs: ImportRef[] = [];
  const add = (quoteAt: number, typeOnly: boolean) => {
    const q = src[quoteAt];
    const end = src.indexOf(q, quoteAt + 1);
    refs.push({ spec: src.slice(quoteAt + 1, end), line: lineAt(src, quoteAt), typeOnly });
  };
  // import x from "m"; import { a } from "m"; import type { T } from "m"; import "m"; export { a } from "m"; export * from "m"
  const stat = /(^|[^\w$.])(import|export)(\s+type\b)?(?:\s*[\w$*{][^;"'`]*?\bfrom)?\s*(["'])/g;
  for (let m; (m = stat.exec(code));) {
    // `export const x = "..."` has no `from`, and its quote is not a specifier.
    const between = code.slice(m.index + m[1].length + m[2].length, m.index + m[0].length - 1);
    if (m[2] === "export" && !/\bfrom\s*$/.test(between)) continue;
    if (m[2] === "import" && /^\s*\(/.test(between)) continue; // dynamic import, below
    add(m.index + m[0].length - 1, Boolean(m[3]));
  }
  const dyn = /(^|[^\w$.])import\s*\(\s*(["'])/g;
  for (let m; (m = dyn.exec(code));) add(m.index + m[0].length - 1, false);
  return refs.sort((a, b) => a.line - b.line);
}
