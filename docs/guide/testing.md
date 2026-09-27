# Testing

Everything in this repository is checked by tests that run offline in a few minutes, and
`npm run verify` runs all of them the same way CI does. This page explains what kinds of test
there are, how to run them, and how to test a cartridge of your own.

## Tiers

<!-- run -->
```sh
npm run test:fast
```

The tests are `node:test` files, `tests/*.test.ts`. Each file belongs to one tier, decided by
what it does, so a new file needs no registration:

| Tier | What is in it | Run it with |
|---|---|---|
| fast | everything that runs in Node in seconds: the assembler, the compiler, the CPU, the manual, the docs | `npm run test:fast` |
| slow | files with a `// test-tier: slow` line: whole-cartridge playthroughs and long comparisons | `npm run test:slow` |
| browser | files that import Playwright: the player and the conformance ROMs in headless Chromium | `npm run test:browser` |

`npm test` runs all three. `CYC_TEST_CONCURRENCY=<n>` sets how many files run at once (Node's
default is one fewer than your CPU cores). `npm test`, `npm run test:browser` and the gate's test
step first take one of two machine-wide "heavy-run slots" (lock folders under
`.git/cyc-slots/`, by `tools/slot.ts`), so two checkouts on one computer never run more than two
full suites at once; a run waits for a free slot for up to 20 minutes, then runs anyway.
`CYC_HEAVY_SLOTS=0` turns the slots off. A fast file that takes more than five seconds gets a
warning, so the fast tier stays fast.

## The gate

`npm run verify` is the full gate, in order: the doctor, the type check, the ROM build, the
cartridge budgets and completion replays, the conformance ROMs, and every test tier. A clean
checkout passes it; a change is ready when it still does. `node tools/verify.ts --part static`
(or `emulation`, `browser`) runs one part.

## What the tests pin

- **ROM bytes.** Every ROM is rebuilt twice and compared with the SHA-256 in
  [`roms/manifest.json`](../../roms/manifest.json).
- **The machine.** The [conformance ROMs](conformance.md), and unit tests of the instruction set,
  the CPU, the video and audio chips and save states.
- **Whole programs.** A completion replay ([`replays/`](../../replays/)) plays a cartridge to its
  end and must reach a recorded machine-state hash and the game's own win value.
- **Pictures.** Golden frames ([`tests/golden/frames.json`](../../tests/golden/frames.json)) hash
  the picture at checkpoints of each replay; a mismatch writes the expected, actual and
  difference images to `.tmp/golden/`.
- **Determinism.** [`tests/determinism-rules.test.ts`](../../tests/determinism-rules.test.ts)
  refuses host time, randomness, timers and engine-dependent Math functions in the emulator and the
  toolchain, and the browser tests compare Node's and Chromium's machine states.
- **The docs.** Every code block in these guides is an excerpt of a file the tests build or run,
  every link resolves, and every picture is re-rendered and compared byte for byte.

## Testing your own cartridge

A cartridge test builds the program, runs it from power-on with scripted input, and checks what
the program did: pixels, work RAM, sound. Tutorial 1's test,
[`tests/example-tutorial-1.test.ts`](../../tests/example-tutorial-1.test.ts), is a small model:

<!-- sample: tests/example-tutorial-1.test.ts lines 16-33 -->
```ts
const STEP1 = "examples/tutorial-1/step1.asm", STEP2 = "examples/tutorial-1/step2.asm";
const rom = (file: string) => buildOne({ name: file, file, lang: "asm" });
const run = (r: Uint8Array, frames: number, pad = (_f: number) => 0) => {
  const m = new Machine(r, { cpu: new Tally() });
  for (let f = 0; f < frames; f++) m.runFrame(pad(f), 0);
  return m;
};
const px = (m: Machine, x: number, y: number) => m.framebuffer[y * 256 + x];
const cram = (m: Machine, i: number) => rgbOf(m.video.cram[i]);
const BACKDROP = 7 * 64, AMBER = 7 * 64 + 4 * 8 + 3, COOL = 7 * 64 + 5 * 8 + 3;   // colour 3: the lamp's centre

test(`${STEP1}: a lamp in the middle of a dark stage`, () => {
  const m = run(rom(STEP1), 10);
  assert.equal(px(m, 0, 0), cram(m, BACKDROP), "backdrop in the corner");
  assert.equal(px(m, 128, 112), cram(m, AMBER), "the lamp's white-hot centre at 128,112");
  assert.equal(px(m, 118, 112), cram(m, BACKDROP), "transparent outside the lamp");
  const lit = [...m.framebuffer].filter(p => p !== cram(m, BACKDROP)).length;
  assert.ok(lit > 150 && lit < 256, `${lit} lamp pixels of 256`);
```

Compare pixels with the colour CRAM holds (`rgbOf`) rather than with numbers typed in by hand,
so a palette change is one edit. For costs, `budgetReport` from
[`tools/budget.ts`](../../tools/budget.ts) measures a run (CPU per frame, sprites per line,
lights, voices) and lists any violation.

To pin a whole game, put it under `roms/<name>/`, run `npm run build:roms -- --write-manifest`,
and record a completion replay: `recordReplay` in [`tools/replay.ts`](../../tools/replay.ts)
plays a list of `[frame, pad1, pad2]` entries and writes `replays/<name>.replay.json` with the
final state hash and the win variable you name (a work-RAM address the game itself sets when it
is won, and its value there), after which
`npm run budget` judges it on every run.
