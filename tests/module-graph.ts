// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// The module graph of the TypeScript sources and its rules (tests/module-rules.test.ts):
//   1. src/** never imports tools/** or tests/**   (the product does not depend on build scripts or tests)
//   2. tools/** never imports tests/**
//   3. src/machine imports only src/machine, src/hw and src/isa   (the core has no host dependencies)
//   4. no import cycles among the repo's own modules (type-only imports included)
// A known exception is declared on the import line itself, with its reason:
//   import { x } from "../tests/y.ts"; // module-rules: allow — <why>
// Specifiers are read from code only: comments and strings are blanked first (tools/source-scan.ts).
import { posix } from "node:path";
import { importsOf } from "../tools/source-scan.ts";

export type Edge = { from: string; to: string; line: number; typeOnly: boolean };

/** Every import edge from `files`: relative specifiers resolved to repo paths, bare ones kept as written. */
export function edgesOf(files: { file: string; src: string }[]): Edge[] {
  const edges: Edge[] = [];
  for (const { file, src } of files) {
    for (const r of importsOf(src)) {
      const to = r.spec.startsWith(".") ? posix.normalize(posix.join(posix.dirname(file), r.spec)) : r.spec;
      edges.push({ from: file, to, line: r.line, typeOnly: r.typeOnly });
    }
  }
  return edges;
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + "/");

/** An exception a file declares on the import line itself: `// module-rules: allow — <reason>`. */
export type Allowance = { from: string; line: number; why: string };

/** The allowances declared in `files`: a marker with a reason, on a line that imports something
 *  (a marker inside a string, or on a line without an import, is not one). */
export function allowancesOf(files: { file: string; src: string }[]): Allowance[] {
  const out: Allowance[] = [];
  for (const { file, src } of files) {
    const importLines = new Set(importsOf(src).map(r => r.line));
    src.split("\n").forEach((l, i) => {
      const m = /\/\/\s*module-rules:\s*allow\s*—\s*(\S.*)$/.exec(l);
      if (m && importLines.has(i + 1)) out.push({ from: file, line: i + 1, why: m[1] });
    });
  }
  return out;
}

/** Rule violations among `edges`, as "file:line: rule: target" strings, except on allowed lines. */
export function ruleViolations(edges: Edge[], allow: Allowance[] = []): string[] {
  const out: string[] = [];
  for (const e of edges) {
    let rule = "";
    if (under(e.from, "src") && (under(e.to, "tools") || under(e.to, "tests"))) rule = "src/** must not import tools/** or tests/**";
    else if (under(e.from, "tools") && under(e.to, "tests")) rule = "tools/** must not import tests/**";
    // Bare specifiers (node:fs, esbuild) stay as written, so they are under none of these.
    else if (under(e.from, "src/machine") && !["src/machine", "src/hw", "src/isa"].some(d => under(e.to, d)))
      rule = "src/machine may import only src/machine, src/hw and src/isa";
    if (!rule) continue;
    if (allow.some(a => a.from === e.from && a.line === e.line)) continue;
    out.push(`${e.from}:${e.line}: ${rule}: ${e.to}`);
  }
  return out;
}

/** Import cycles among repo files (Tarjan's strongly connected components), each as a path list. */
export function cycles(edges: Edge[]): string[][] {
  const graph = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!graph.has(e.from)) graph.set(e.from, new Set());
    if (/\.ts$/.test(e.to) && !/^[a-z]+:/.test(e.to)) graph.get(e.from)!.add(e.to);
  }
  let index = 0;
  const idx = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>();
  const found: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      let w: string;
      do { w = stack.pop()!; on.delete(w); scc.push(w); } while (w !== v);
      if (scc.length > 1 || graph.get(v)?.has(v)) found.push(scc.sort());
    }
  };
  for (const v of [...graph.keys()].sort()) if (!idx.has(v)) visit(v);
  return found;
}
