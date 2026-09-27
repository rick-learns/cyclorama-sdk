// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// tools/test-tier.ts: splits tests/**/*.test.ts into tiers (fast / slow / browser) by what each
// file does, so `npm run test:fast` stays a quick no-browser loop and `npm test` stays everything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, concurrencyArgs, parseCli, reporterArgs, selectTier, selectTiers, testFiles, tierArgs, timeoutArgs, TIERS } from "../tools/test-tier.ts";
import fastFileTimer from "../tools/test-tier-reporter.ts";

// Spelled by concatenation so this file itself does not look like a browser test.
const PW = "play" + "wright";

test("a file that imports playwright is a browser test", () => {
  assert.equal(classify(`import { chromium } from "${PW}";\n`), "browser");
  assert.equal(classify(`import { chromium, type Page } from '${PW}';\n`), "browser");
  assert.equal(classify(`const { chromium } = await import("${PW}");\n`), "browser");
});

test("the slow marker makes a Node-only file slow; everything else is fast", () => {
  assert.equal(classify(`// test-tier: slow (plays the whole game)\nimport { test } from "node:test";\n`), "slow");
  assert.equal(classify(`import { test } from "node:test";\n`), "fast");
  // Mentioning playwright in prose is not an import.
  assert.equal(classify(`// the browser tests use playwright; this one does not\n`), "fast");
  // A browser file stays browser even if it is also marked slow.
  assert.equal(classify(`// test-tier: slow\nimport { chromium } from "${PW}";\n`), "browser");
});

test("tiers select disjoint files whose union is the whole suite", () => {
  const files = { "tests/a.test.ts": "fast", "tests/b.test.ts": "slow", "tests/c.test.ts": "browser" } as const;
  const src = (f: string) => ({ fast: "", slow: "// test-tier: slow\n", browser: `import "${PW}";\n` })[files[f as keyof typeof files]];
  const all = Object.keys(files);
  assert.deepEqual(selectTier("fast", all, src), ["tests/a.test.ts"]);
  assert.deepEqual(selectTier("slow", all, src), ["tests/b.test.ts"]);
  assert.deepEqual(selectTier("browser", all, src), ["tests/c.test.ts"]);
  assert.deepEqual(selectTier("node", all, src), ["tests/a.test.ts", "tests/b.test.ts"]);
  assert.deepEqual(selectTier("all", all, src), all);
  assert.throws(() => selectTier("nope" as never, all, src), /unknown tier/);
});

test("several tiers at once (verify --part): `fast,browser` is the union in suite order; unknown names are refused", () => {
  const files = { "tests/a.test.ts": "browser", "tests/b.test.ts": "fast", "tests/c.test.ts": "slow" } as const;
  const src = (f: string) => ({ fast: "", slow: "// test-tier: slow\n", browser: `import "${PW}";\n` })[files[f as keyof typeof files]];
  const all = Object.keys(files);
  assert.deepEqual(selectTiers("fast,browser", all, src), ["tests/a.test.ts", "tests/b.test.ts"]);
  assert.deepEqual(selectTiers("slow", all, src), ["tests/c.test.ts"]);
  assert.deepEqual(selectTiers("fast,slow,browser", all, src), all);
  assert.deepEqual(selectTiers("node,fast", all, src), ["tests/b.test.ts", "tests/c.test.ts"], "overlapping tiers list each file once");
  assert.throws(() => selectTiers("fast,nope", all, src), /unknown tier 'nope'/);
  assert.throws(() => selectTiers("", all, src), /unknown tier/);
});

test("the real suite: every test file lands in exactly one tier and the browser files are the playwright ones", () => {
  const all = testFiles();
  assert.ok(all.length > 40, `found ${all.length} test files`);
  assert.ok(all.every(f => f.endsWith(".test.ts") && !f.includes("\\")), "posix paths ending .test.ts");
  const fast = selectTier("fast", all), slow = selectTier("slow", all), browser = selectTier("browser", all);
  assert.equal(fast.length + slow.length + browser.length, all.length);
  assert.ok(browser.includes("tests/browser-player.test.ts") && browser.includes("tests/browser-conformance.test.ts"));
  assert.ok(fast.includes("tests/test-tier.test.ts") && fast.includes("tests/cpu.test.ts"));
  assert.ok(!fast.includes("tests/browser-conformance.test.ts"));
  assert.deepEqual(TIERS, ["fast", "slow", "browser", "node", "all"]);
});

test("CLI --list into a pipe exits cleanly (Windows: no libuv assertion from exiting with a pending write)", () => {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "tools/test-tier.ts", "all", "--list"], { encoding: "utf8" });
  assert.equal(r.stderr, "");
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.trim().split("\n"), testFiles());
  const both = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "tools/test-tier.ts", "slow,browser", "--list"], { encoding: "utf8" });
  assert.equal(both.status, 0);
  assert.deepEqual(both.stdout.trim().split("\n"), selectTiers("slow,browser", testFiles()));
  const bad = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "tools/test-tier.ts", "fast,nope", "--list"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage/);
});

test("node --test arguments: tier files after the flags, extra flags passed through", () => {
  const args = tierArgs(["tests/a.test.ts"], ["--test-name-pattern=x"]);
  assert.deepEqual(args.slice(-3), ["--test", "--test-name-pattern=x", "tests/a.test.ts"]);
  assert.ok(args.includes("--disable-warning=ExperimentalWarning"));
});

test("CLI flags: `npm run test:fast -- --test-name-pattern=x` reaches node --test (npm drops the `--`)", () => {
  assert.deepEqual(parseCli(["fast", "--test-name-pattern=x"]), { tier: "fast", list: false, extra: ["--test-name-pattern=x"] });
  assert.deepEqual(parseCli(["all", "--list"]), { tier: "all", list: true, extra: [] });
  assert.deepEqual(parseCli(["browser", "--", "--test-only", "--list"]), { tier: "browser", list: false, extra: ["--test-only", "--list"] });
  assert.deepEqual(parseCli(["fast,slow", "--list"]), { tier: "fast,slow", list: true, extra: [] });
  assert.equal(parseCli(["--test-only"]).tier, undefined);
});

test("test concurrency: 4 in agent worktrees, Node's default for CI and the main checkout, CYC_TEST_CONCURRENCY overrides", () => {
  const agent = "C:\\repo\\.claude\\worktrees\\agent-1", posixAgent = "/home/x/repo/.claude/worktrees/agent-1", lead = "C:\\repo";
  assert.deepEqual(concurrencyArgs({}, agent), ["--test-concurrency=4"]);
  assert.deepEqual(concurrencyArgs({}, posixAgent), ["--test-concurrency=4"]);
  assert.deepEqual(concurrencyArgs({}, lead), []);
  assert.deepEqual(concurrencyArgs({ CI: "true" }, agent), []);
  assert.deepEqual(concurrencyArgs({ CI: "false" }, agent), ["--test-concurrency=4"]);
  assert.deepEqual(concurrencyArgs({ CYC_TEST_CONCURRENCY: "8" }, agent), ["--test-concurrency=8"]);
  assert.deepEqual(concurrencyArgs({ CYC_TEST_CONCURRENCY: "2" }, lead), ["--test-concurrency=2"]);
  assert.deepEqual(concurrencyArgs({ CYC_TEST_CONCURRENCY: "2", CI: "true" }, lead), ["--test-concurrency=2"]);
  assert.deepEqual(concurrencyArgs({ CYC_TEST_CONCURRENCY: "default" }, agent), []);
  assert.throws(() => concurrencyArgs({ CYC_TEST_CONCURRENCY: "lots" }, lead), /CYC_TEST_CONCURRENCY/);
  assert.throws(() => concurrencyArgs({ CYC_TEST_CONCURRENCY: "0" }, lead), /CYC_TEST_CONCURRENCY/);
});

test("hang protection: --test-timeout=900000 plus --test-force-exit unless CYC_TEST_TIMEOUT_MS or an explicit --test-timeout says otherwise", () => {
  assert.deepEqual(timeoutArgs([], {}), ["--test-timeout=900000", "--test-force-exit"]);
  assert.deepEqual(timeoutArgs([], { CYC_TEST_TIMEOUT_MS: "600000" }), ["--test-timeout=600000", "--test-force-exit"]);
  assert.deepEqual(timeoutArgs(["--test-timeout=5000"], {}), ["--test-force-exit"], "an explicit timeout wins; force-exit stays");
  assert.deepEqual(timeoutArgs(["--test-timeout", "5000"], { CYC_TEST_TIMEOUT_MS: "1" }), ["--test-force-exit"]);
  assert.deepEqual(timeoutArgs(["--test-force-exit"], {}), ["--test-timeout=900000"], "not passed twice");
  assert.throws(() => timeoutArgs([], { CYC_TEST_TIMEOUT_MS: "soon" }), /CYC_TEST_TIMEOUT_MS/);
  // It bounds each test (next test), so it must exceed the slowest single test with room: a
  // whole-game completion test took 166 s in CI run 36276647768 and more than 180 s in a loaded full
  // run on the Mac (the first default, 180 s, killed four files there). 15 min is ~2x the slowest
  // runner's slowest test (~280 s) plus load, and still under verify's own step timeouts.
});

test("a test that hangs with a live timer fails and its process exits under the runner's flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "cyc-tt-"));
  try {
    const f = join(dir, "hang.test.ts"), g = join(dir, "one.test.ts");
    // A never-settling test holding an interval: the per-test timeout fires, and force-exit ends
    // the process although the interval keeps its event loop alive (Node 24 no longer bounds the
    // file-level test, so without the flag this run never ends).
    writeFileSync(f, `import { test } from "node:test";\ntest("hang", () => new Promise(() => { setInterval(() => {}, 1000); }));\n`);
    writeFileSync(g, `import { test } from "node:test";\ntest("quick", () => {});\n`);
    // Without NODE_TEST_CONTEXT, which would make the nested run report into this one instead.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", ...timeoutArgs([], { CYC_TEST_TIMEOUT_MS: "600" }), "--test-reporter=tap", f, g], { encoding: "utf8", env, timeout: 30_000 });
    assert.equal(r.error, undefined, "the run ended by itself (spawnSync's 30 s kill did not fire)");
    assert.notEqual(r.status, 0, "the hung test fails the run");
    assert.match(r.stdout, /test timed out after 600ms/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reporters: spec on stdout plus the fast-file timer on stderr, unless the caller chose reporters", () => {
  const r = reporterArgs([]);
  assert.deepEqual(r.slice(0, 2), ["--test-reporter=spec", "--test-reporter-destination=stdout"]);
  assert.match(r[2], /^--test-reporter=file:.*test-tier-reporter\.ts$/);
  assert.equal(r[3], "--test-reporter-destination=stderr");
  assert.deepEqual(reporterArgs(["--test-reporter=tap"]), []);
});

test("fast-tier drift: a fast file whose tests take over 5 s is reported (a warning, never a failure)", async () => {
  const PWI = `import "${PW}";`;
  const src: Record<string, string> = { "/r/tests/a.test.ts": "", "/r/tests/b.test.ts": "// test-tier: slow\n", "/r/tests/c.test.ts": PWI, "/r/tests/d.test.ts": "" };
  const ev = (type: string, file: string, ms: number, nesting = 0) => ({ type, data: { file, nesting, name: "t", details: { duration_ms: ms } } });
  async function* events() {
    yield ev("test:pass", "/r/tests/a.test.ts", 3000);
    yield ev("test:pass", "/r/tests/a.test.ts", 2500); // 5.5 s in all: warn
    yield ev("test:pass", "/r/tests/a.test.ts", 9000, 1); // a subtest: already inside its parent's time
    yield ev("test:fail", "/r/tests/b.test.ts", 60000); // slow tier: fine
    yield ev("test:pass", "/r/tests/c.test.ts", 60000); // browser tier: fine
    yield ev("test:pass", "/r/tests/d.test.ts", 4900); // under the line
    yield { type: "test:diagnostic", data: { message: "x" } };
    yield ev("test:pass", "/r/tests/gone.test.ts", 9000); // unreadable: skipped, never a crash
  }
  let out = "";
  for await (const chunk of fastFileTimer(events(), { cwd: "/r", read: f => { if (!(f in src)) throw new Error("ENOENT"); return src[f]; }, env: {} })) out += chunk;
  assert.match(out, /warning: tests\/a\.test\.ts: fast-tier file took 5\.5 s \(over 5 s\); mark it `\/\/ test-tier: slow`/);
  assert.doesNotMatch(out, /b\.test|c\.test|d\.test|gone/);
  let gh = "";
  for await (const chunk of fastFileTimer(events(), { cwd: "/r", read: f => src[f] ?? "", env: { GITHUB_ACTIONS: "true" } })) gh += chunk;
  assert.match(gh, /^::warning::tests\/a\.test\.ts: fast-tier file took 5\.5 s/m, "an annotation in CI");
});

test("npm scripts: the full run and the browser tier take a heavy-run slot; the Node-only tiers do not", () => {
  const scripts: Record<string, string> = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  const slotted = /^node --disable-warning=ExperimentalWarning tools\/slot\.ts 2 -- node --disable-warning=ExperimentalWarning tools\/test-tier\.ts (\w+)$/;
  assert.equal(slotted.exec(scripts.test)?.[1], "all");
  assert.equal(slotted.exec(scripts["test:browser"])?.[1], "browser");
  for (const s of ["test:fast", "test:slow"]) {
    assert.doesNotMatch(scripts[s], /slot\.ts/, s);
    assert.match(scripts[s], /tools\/test-tier\.ts (fast|slow)$/, s);
  }
  for (const [name, cmd] of Object.entries(scripts)) for (const m of cmd.matchAll(/tools\/[\w/.-]+\.ts/g)) assert.ok(existsSync(m[0]), `${name}: ${m[0]} exists`);
});
