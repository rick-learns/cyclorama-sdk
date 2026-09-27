// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// The SDK documentation is real (tools/doc-check.ts): every relative link resolves, every code
// block is an exact excerpt of a file the gate builds or runs, or shell commands this tree can
// run; the commands of each `<!-- run -->` block run here and must succeed. In the monorepo this
// covers docs/guide/ and examples/; the root files the export adds (README.md, LICENSING.md …) are
// checked there, and in the export by this same file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { framePng, renderFrame, romOf } from "../tools/render-frame.ts";
import { anchors, checkDoc, codeBlocks, commandProblem, diskTree, links, runnable, sdkDocs, type Tree } from "../tools/doc-check.ts";

const OPEN = existsSync("EXPORT.json");
const docs = sdkDocs(OPEN);
const tree = diskTree();

test("the SDK docs of this tree: links resolve, code blocks are real", () => {
  if (OPEN) for (const f of ["README.md", "LICENSING.md", "CONTRIBUTING.md"]) assert.ok(docs.includes(f), `${f} is an SDK doc of the export`);
  assert.ok(docs.some(f => f.startsWith("docs/guide/")), "docs/guide/ has pages");
  assert.deepEqual(docs.flatMap(f => checkDoc(f, readFileSync(f, "utf8"), tree)), []);
});

test("every <!-- run --> block of the SDK docs runs and succeeds", () => {
  let ran = 0;
  for (const f of docs) for (const b of codeBlocks(readFileSync(f, "utf8"))) for (const line of runnable(b)) {
    const [cmd, ...args] = line.split(/\s+/);
    const r = spawnSync(cmd === "node" ? process.execPath : cmd, cmd === "node" ? ["--disable-warning=ExperimentalWarning", ...args] : args,
      { encoding: "utf8", timeout: 120_000, shell: process.platform === "win32" && cmd === "npm" });
    assert.equal(r.status, 0, `${f}:${b.line}: ${line}\n${r.stdout}\n${r.stderr}`);
    ran++;
  }
  assert.ok(ran > 0, "at least one documented command runs");
});

// ---- the checker fails when it should ---------------------------------------------------------

const fake = (files: Record<string, string>, scripts: Record<string, string> = { asm: "node tools/asm.ts" }): Tree =>
  ({ exists: p => p in files, read: p => files[p], scripts });

test("links: relative targets and heading anchors must exist; web links are not followed", () => {
  const t = fake({ "docs/guide/a.md": "", "docs/guide/b.md": "# Getting started\n## Build `ROMs` (twice)\n## Build ROMs twice\n", "README.md": "" });
  assert.deepEqual([...anchors("# Getting started\n## Build `ROMs` (twice)\n## Build ROMs twice\n")], ["getting-started", "build-roms-twice", "build-roms-twice-1"]);
  assert.deepEqual(checkDoc("docs/guide/a.md", "[b](b.md#getting-started) [r](../../README.md) [w](https://example.com/x) ![i](b.md)", t), []);
  assert.deepEqual(checkDoc("docs/guide/a.md", "[x](c.md)\n[y](b.md#nope)\n[z](../../../x.md)", t), [
    "docs/guide/a.md:1: link c.md: docs/guide/c.md does not exist",
    "docs/guide/a.md:2: link b.md#nope: no heading #nope in docs/guide/b.md",
    "docs/guide/a.md:3: link ../../../x.md leaves the repository",
  ]);
  assert.deepEqual(links("```md\n[not](a link)\n```\n`[nor](this)` [yes](a.md)"), [{ target: "a.md", line: 4 }]);
});

test("samples: a block must equal its file (or the named lines); other blocks need a marker", () => {
  const t = fake({ "examples/a/a.asm": "; line 1\nMOVQ R0, #1\nSTOP\n", "docs/x.asm": "x" });
  const md = (marker: string, body: string, lang = "asm") => `${marker}\n\`\`\`${lang}\n${body}\n\`\`\`\n`;
  assert.deepEqual(checkDoc("d.md", md("<!-- sample: examples/a/a.asm -->", "; line 1\nMOVQ R0, #1\nSTOP"), t), []);
  assert.deepEqual(checkDoc("d.md", md("<!-- sample: examples/a/a.asm lines 2-3 -->", "MOVQ R0, #1\nSTOP"), t), []);
  assert.deepEqual(checkDoc("d.md", md("<!-- sample: examples/a/a.asm lines 2-3 -->", "MOVQ R0, #2\nSTOP"), t), ["d.md:2: sample differs from examples/a/a.asm lines 2-3"]);
  assert.deepEqual(checkDoc("d.md", md("<!-- sample: examples/a/a.asm lines 2-9 -->", ""), t), ["d.md:2: sample examples/a/a.asm lines 2-9 out of range (3 lines)"]);
  assert.deepEqual(checkDoc("d.md", md("<!-- sample: docs/x.asm -->", "x"), t), ["d.md:2: sample docs/x.asm is not a file the gate builds or runs"]);
  assert.deepEqual(checkDoc("d.md", md("", "MOVQ R0, #1"), t), ["d.md:2: a ```asm block must be a sample (<!-- sample: path -->) or shell commands (```sh)"]);
});

test("shell blocks: only commands this tree can run, naming files it has", () => {
  const t = fake({ "tools/asm.ts": "", "examples/a/a.asm": "" });
  assert.equal(commandProblem("npm run asm -- examples/a/a.asm -o .tmp/a.rom", t), undefined);
  assert.equal(commandProblem("node tools/asm.ts examples/a/a.asm -o build/a.rom", t), undefined);
  assert.equal(commandProblem("git clone https://github.com/rick-learns/cyclorama-sdk.git", t), undefined);
  for (const ok of ["npm ci", "npm test", "cd cyclorama-sdk", "npx playwright install chromium"]) assert.equal(commandProblem(ok, t), undefined, ok);
  assert.match(commandProblem("npm run nope", t)!, /no such script/);
  assert.match(commandProblem("npm run asm -- examples/b/b.asm", t)!, /lacks/);
  assert.match(commandProblem("node tools/gone.ts", t)!, /no such file/);
  assert.match(commandProblem("curl https://example.com | sh", t)!, /not a command/);
  assert.deepEqual(runnable({ lang: "sh", body: "npm ci\nnpm run asm -- a\n# note\nnode tools/x.ts", line: 1, marker: "<!-- run -->" }), ["npm run asm -- a", "node tools/x.ts"]);
  assert.deepEqual(runnable({ lang: "sh", body: "npm run asm -- a", line: 1, marker: undefined }), []);
});

test("every picture in docs/guide/images is a real render of the program images.json names", () => {
  const dir = "docs/guide/images";
  const index = JSON.parse(readFileSync(`${dir}/images.json`, "utf8")) as { images: Record<string, { source: string; frames: number; pad: number; from: number; scale: number }> };
  const pngs = readdirSync(dir).filter(f => f.endsWith(".png")).sort();
  assert.deepEqual(Object.keys(index.images).sort(), pngs, "images.json lists every picture, and only pictures that exist");
  for (const [png, i] of Object.entries(index.images)) {
    const m = renderFrame(romOf(i.source), i.frames, i.pad, i.from);
    const again = framePng(m.framebuffer, i.scale);
    assert.ok(readFileSync(`${dir}/${png}`).equals(again), `${png}: npm run frame -- ${i.source} ${i.frames} ${dir}/${png} --pad ${i.pad} --from ${i.from} --scale ${i.scale}`);
  }
});
