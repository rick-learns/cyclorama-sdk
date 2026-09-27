// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Checks for the SDK documentation (README.md, docs/guide/, examples/ and the policy files):
// every relative link resolves, and every code block is real.
//   node tools/doc-check.ts [file.md ...]      (no files: the SDK docs of this tree)
// A fenced code block must be one of:
//   - a sample: the line before the fence is `<!-- sample: <path> -->` or
//     `<!-- sample: <path> lines <a>-<b> -->`, and the block is exactly that file (or those lines).
//     The file must be something the gate builds or runs: under examples/, roms/, tests/, src/ or
//     tools/ (tests/sdk-examples.test.ts builds and runs every example);
//   - shell commands (```sh): each line is `npm ci`, `npm test`, `npm run <script>` (a script of
//     package.json), `node <file>` (a file of this tree), `npx playwright install …`, or the clone
//     of the public repo and `cd` into it; paths it names must exist (outputs under .tmp/ and
//     build/ excepted). With `<!-- run -->` on the line before the fence, tests/sdk-docs.test.ts
//     also runs its `npm run` and `node` lines and requires exit 0.
// Anything else (a block without a marker, a sample that differs from its file) is a problem.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { posix } from "node:path";
import { isCliEntry } from "./cli-entry.ts";
import { headingSlug } from "./heading-slug.ts";

export const REPO = "rick-learns/cyclorama-sdk";

export type Block = { lang: string; body: string; line: number; marker: string | undefined };
export type Tree = { exists: (path: string) => boolean; read: (path: string) => string; scripts: Record<string, string> };

/** Fenced code blocks, with the HTML comment on the line before each opening fence. */
export function codeBlocks(md: string): Block[] {
  const lines = md.split("\n"), out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,})([\w-]*)\s*$/.exec(lines[i]);
    if (!open) continue;
    let j = i + 1;
    while (j < lines.length && lines[j] !== open[1]) j++;
    let k = i - 1;
    while (k >= 0 && lines[k].trim() === "") k--;
    const marker = k >= 0 && /^<!--.*-->$/.test(lines[k].trim()) ? lines[k].trim() : undefined;
    out.push({ lang: open[2], body: lines.slice(i + 1, j).join("\n"), line: i + 1, marker });
    i = j;
  }
  return out;
}

/** Markdown links and images outside code blocks: [text](target). */
export function links(md: string): { target: string; line: number }[] {
  const out: { target: string; line: number }[] = [];
  let fence = "";
  md.split("\n").forEach((l, i) => {
    const f = /^(`{3,})/.exec(l);
    if (f) { fence = fence ? (l.trim() === fence ? "" : fence) : f[1]; return; }
    if (fence) return;
    for (const m of l.replace(/`[^`]*`/g, "").matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push({ target: m[1], line: i + 1 });
  });
  return out;
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, repeats numbered. */
export function anchors(md: string): Set<string> {
  const seen = new Map<string, number>(), out = new Set<string>();
  let fence = "";
  for (const l of md.split("\n")) {
    const f = /^(`{3,})/.exec(l);
    if (f) { fence = fence ? (l.trim() === fence ? "" : fence) : f[1]; continue; }
    const h = fence ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l);
    if (!h) continue;
    const base = headingSlug(h[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

const SAMPLE = /^<!--\s*sample:\s*(\S+)(?:\s+lines\s+(\d+)-(\d+))?\s*-->$/;
const SAMPLE_ROOTS = ["examples/", "roms/", "tests/", "src/", "tools/"];
const OUTPUT_DIRS = [".tmp/", "build/"];

/** A shell line's problem, or undefined. */
export function commandProblem(line: string, tree: Tree): string | undefined {
  const words = line.trim().split(/\s+/);
  const [cmd, a1, a2] = words;
  const pathsExist = (args: string[]) => {
    for (const a of args) {
      if (!/^[\w.-]+\/[\w./-]*\.\w+$/.test(a) || OUTPUT_DIRS.some(d => a.startsWith(d))) continue;
      if (!tree.exists(a)) return `names ${a}, which this tree lacks`;
    }
    return undefined;
  };
  if (cmd === "npm" && (a1 === "ci" || a1 === "test")) return pathsExist(words.slice(2));
  if (cmd === "npm" && a1 === "run") return a2 && a2 in tree.scripts ? pathsExist(words.slice(3)) : `npm run ${a2 ?? ""}: no such script in package.json`;
  if (cmd === "node") return a1 && tree.exists(a1) ? pathsExist(words.slice(2)) : `node ${a1 ?? ""}: no such file`;
  if (cmd === "npx" && a1 === "playwright" && a2 === "install") return undefined;
  if (cmd === "git" && a1 === "clone" && (a2 === `https://github.com/${REPO}.git` || a2 === `https://github.com/${REPO}`)) return undefined;
  if (cmd === "cd" && (a1 === REPO.split("/")[1] || a1 === "..")) return undefined;
  return `not a command the docs may show: ${line.trim()}`;
}

/** The file and line range each sample of `md` quotes (a whole-file sample has no range), in page order. */
export function sampleRanges(md: string): { path: string; from?: number; to?: number; line: number }[] {
  return codeBlocks(md).flatMap(b => {
    const s = b.marker ? SAMPLE.exec(b.marker) : null;
    return s ? [s[2] ? { path: s[1], from: +s[2], to: +s[3], line: b.line } : { path: s[1], line: b.line }] : [];
  });
}

/** The runnable lines of a `<!-- run -->` block: its `npm run` and `node` lines. */
export function runnable(block: Block): string[] {
  return block.marker === "<!-- run -->" ? block.body.split("\n").map(l => l.trim()).filter(l => /^(npm run|node) /.test(l)) : [];
}

/** Every problem of one Markdown file in `tree`. */
export function checkDoc(file: string, md: string, tree: Tree): string[] {
  const problems: string[] = [];
  const dir = posix.dirname(file);
  for (const { target, line } of links(md)) {
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [path, anchor] = target.split("#") as [string, string | undefined];
    const resolved = path ? posix.normalize(posix.join(dir, decodeURI(path))) : file;
    if (resolved.startsWith("../")) { problems.push(`${file}:${line}: link ${target} leaves the repository`); continue; }
    const asDir = resolved.replace(/\/$/, "");
    if (!tree.exists(resolved) && !tree.exists(asDir + "/README.md")) { problems.push(`${file}:${line}: link ${target}: ${resolved} does not exist`); continue; }
    if (anchor && resolved.endsWith(".md") && !anchors(tree.read(resolved)).has(anchor)) problems.push(`${file}:${line}: link ${target}: no heading #${anchor} in ${resolved}`);
  }
  for (const b of codeBlocks(md)) {
    const at = `${file}:${b.line}`;
    const s = b.marker ? SAMPLE.exec(b.marker) : null;
    if (s) {
      const [, path, from, to] = s;
      if (!SAMPLE_ROOTS.some(r => path.startsWith(r))) { problems.push(`${at}: sample ${path} is not a file the gate builds or runs`); continue; }
      if (!tree.exists(path)) { problems.push(`${at}: sample ${path} does not exist`); continue; }
      const src = tree.read(path).replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
      const want = from ? src.slice(+from - 1, +to).join("\n") : src.join("\n");
      if (from && (+from < 1 || +to > src.length || +from > +to)) problems.push(`${at}: sample ${path} lines ${from}-${to} out of range (${src.length} lines)`);
      else if (b.body !== want) problems.push(`${at}: sample differs from ${path}${from ? ` lines ${from}-${to}` : ""}`);
    } else if (b.lang === "sh") {
      for (const l of b.body.split("\n")) {
        if (!l.trim() || l.trim().startsWith("#")) continue;
        const p = commandProblem(l, tree);
        if (p) problems.push(`${at}: ${p}`);
      }
    } else problems.push(`${at}: a \`\`\`${b.lang} block must be a sample (<!-- sample: path -->) or shell commands (\`\`\`sh)`);
  }
  return problems;
}

/** The SDK documentation of the tree at the working directory. */
export function sdkDocs(open: boolean): string[] {
  const walk = (d: string): string[] => existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith(".md") ? [`${d}/${e.name}`] : []) : [];
  const root = open ? ["README.md", "LICENSING.md", "TRADEMARKS.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", "CHANGELOG.md"].filter(f => existsSync(f)) : [];
  return [...root, ...walk("docs/guide"), ...walk("examples")].sort();
}

export function diskTree(): Tree {
  return { exists: p => existsSync(p), read: p => readFileSync(p, "utf8"), scripts: JSON.parse(readFileSync("package.json", "utf8")).scripts ?? {} };
}

if (isCliEntry(import.meta.url)) {
  const files = process.argv.slice(2).length ? process.argv.slice(2) : sdkDocs(existsSync("EXPORT.json"));
  const tree = diskTree();
  const problems = files.flatMap(f => checkDoc(f, readFileSync(f, "utf8"), tree));
  for (const p of problems) console.log(`FAIL ${p}`);
  console.log(`doc-check: ${files.length} file(s), ${problems.length} problem(s)`);
  process.exitCode = problems.length ? 1 : 0;
}
