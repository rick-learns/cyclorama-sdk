// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// The module rules (tests/module-graph.ts) hold over every TypeScript file of this tree, each
// declared exception is still needed, and each rule fires on a planted edge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { allowancesOf, cycles, edgesOf, ruleViolations } from "./module-graph.ts";
import { tsFiles } from "../tools/source-scan.ts";

/** Every top-level folder of the tree that can hold sources (not dependencies or outputs). */
const roots = readdirSync(".", { withFileTypes: true })
  .filter(e => e.isDirectory() && !e.name.startsWith(".") && !["node_modules", "build", "coverage"].includes(e.name)).map(e => e.name);
const files = tsFiles(roots).map(file => ({ file, src: readFileSync(file, "utf8") }));
const edges = edgesOf(files);

test("dependency rules hold across the tree's TypeScript; every declared exception is still needed", () => {
  assert.ok(roots.includes("src") && roots.includes("tools") && roots.includes("tests"), roots.join(", "));
  assert.ok(edges.length > 300, `expected the tree's import graph, found ${edges.length} edges`);
  const allow = allowancesOf(files);
  const bad = ruleViolations(edges, allow);
  assert.deepEqual(bad, [], `import boundary broken:\n${bad.join("\n")}`);
  const stale = allow.filter(a => ruleViolations(edges.filter(e => e.from === a.from && e.line === a.line), []).length === 0);
  assert.deepEqual(stale, [], "a `// module-rules: allow` marker sits on a line that breaks no rule: remove it");
});

test("the tree's own modules import each other without cycles", () => {
  const found = cycles(edges);
  assert.deepEqual(found, [], `import cycle(s):\n${found.map(c => c.join(" <-> ")).join("\n")}`);
});

test("each rule fires on a planted edge and names file:line and the rule; a marker with a reason excuses its line only", () => {
  const plant = (file: string, src: string) => { const f = [{ file, src: `// header\n${src}\n` }]; return ruleViolations(edgesOf(f), allowancesOf(f)); };
  assert.deepEqual(plant("src/scrim/x.ts", 'import { a } from "../../tools/art.ts";'),
    ["src/scrim/x.ts:2: src/** must not import tools/** or tests/**: tools/art.ts"]);
  assert.deepEqual(plant("src/web/x.ts", 'import type { T } from "../../tests/h.ts";'),
    ["src/web/x.ts:2: src/** must not import tools/** or tests/**: tests/h.ts"]);
  assert.deepEqual(plant("tools/x.ts", 'export { r } from "../tests/route.ts";'),
    ["tools/x.ts:2: tools/** must not import tests/**: tests/route.ts"]);
  assert.deepEqual(plant("src/machine/x.ts", 'import { d } from "../asm/assembler.ts";'),
    ["src/machine/x.ts:2: src/machine may import only src/machine, src/hw and src/isa: src/asm/assembler.ts"]);
  assert.deepEqual(plant("src/machine/x.ts", 'import { readFileSync } from "node:fs";'),
    ["src/machine/x.ts:2: src/machine may import only src/machine, src/hw and src/isa: node:fs"]);
  assert.deepEqual(plant("src/machine/x.ts", 'const m = await import("../web/player.ts");'),
    ["src/machine/x.ts:2: src/machine may import only src/machine, src/hw and src/isa: src/web/player.ts"]);
  assert.deepEqual(plant("src/machine/x.ts", 'import { A } from "../isa/isa.ts";\nimport { B } from "../hw/registers.ts";\nimport { C } from "./video/render.ts";'), []);
  // comments and strings are not imports
  assert.deepEqual(plant("src/scrim/x.ts", '// import { a } from "../../tools/art.ts";\nconst s = \'import x from "../../tests/y.ts"\';'), []);
  // an allowance marker excuses its own line, and only with a reason
  assert.deepEqual(plant("tools/x.ts", 'import { r } from "../tests/route.ts"; // module-rules: allow — shares the route data\nimport { q } from "../tests/q.ts";'),
    ["tools/x.ts:3: tools/** must not import tests/**: tests/q.ts"]);
  assert.deepEqual(plant("tools/x.ts", 'import { r } from "../tests/route.ts"; // module-rules: allow —'), ["tools/x.ts:2: tools/** must not import tests/**: tests/route.ts"]);
});

test("cycle detection finds a planted cycle, including through a type-only import", () => {
  const planted = edgesOf([
    { file: "src/a.ts", src: 'import { b } from "./b.ts";' },
    { file: "src/b.ts", src: 'import type { C } from "./c.ts";' },
    { file: "src/c.ts", src: 'import { a } from "./a.ts";' },
    { file: "src/d.ts", src: 'import { a } from "./a.ts";' },
  ]);
  assert.deepEqual(cycles(planted), [["src/a.ts", "src/b.ts", "src/c.ts"]]);
});
