# Command-line reference

Every tool is a TypeScript file in [`tools/`](../../tools/) that Node runs directly. Most have an
`npm run` script; `npm run <script> -- <arguments>` passes the arguments on (the `--` is npm's).
The usage line under each heading is quoted from the tool's own source, so this page and the
tool cannot disagree. Tools exit 0 on success and non-zero otherwise: 1 when a build or check
fails, and 2 for arguments they cannot use (`frame`, `verify`, the test tiers; `asm` and `scrim`
use 1 for both).

## Building

### `npm run asm`: assemble a CYASM program

<!-- sample: tools/asm.ts lines 4-4 -->
```text
// npm run asm -- input.asm -o out.rom [--sym out.sym] [--lst out.lst]
```

Assembles `input.asm` and everything it `.include`s into a cartridge image, with the header's
checksum filled in. An `.include "x.art.inc"` or
`"x.song.inc"` that does not exist on disk is converted from `x.art` or `x.song`. `--sym` writes
the symbol table, one symbol per line: `BB:HHHH name` for a label (its bank and address) and
`HHHH name` for a constant (its value); `--lst` writes a listing. Errors print as
`file:line: error: message` and nothing is written. The language is
[chapter 8 of the manual](../manual/index.html#assembler).

<!-- run -->
```sh
npm run asm -- examples/tutorial-1/step2.asm -o .tmp/step2.rom --sym .tmp/step2.sym
```

### `npm run scrim`: compile a SCRIM program

<!-- sample: tools/scrim.ts lines 4-4 -->
```text
// npm run scrim -- input.scr -o out.rom [--asm out.asm] [--report]
```

Compiles SCRIM to CYASM and assembles it. `--asm` also writes the generated assembly;
`--report` prints each procedure's size in bytes and its static worst-case cycle count for one
pass. Errors print as `file:line:col: error: message`. The language:
[SCRIM specification](../scrim-spec.md).

<!-- run -->
```sh
npm run scrim -- roms/lantern-scrim/lantern-scrim.scr -o .tmp/lantern-scrim.rom --report
```

### `npm run build:roms`: every ROM, reproducibly

<!-- sample: tools/build-roms.ts lines 4-4 -->
```text
// npm run build:roms [-- --write-manifest]
```

Builds each `roms/<name>/<name>.asm` or `.scr` and each conformance ROM in
[`tests/conformance/`](../../tests/conformance/) into `build/roms/`. The build is a pure function
of the sources; [`roms/manifest.json`](../../roms/manifest.json) records every ROM's size and
SHA-256, and the tests require two builds to match it byte for byte. After adding a cartridge
folder or changing a ROM on purpose, run it with `--write-manifest` and commit the manifest with
the change.

### `npm run player`: a cartridge as one web page

<!-- sample: tools/build-player.ts lines 4-4 -->
```text
// npm run player -- <cartridge.asm | cartridge.scr> [out.html]
```

Builds the cartridge and bundles the reference player with the ROM into one HTML file (default
`build/player/index.html`) that runs from `file://` with no network. Keys: arrows = D-pad, Z X C
= A B C, Enter = START; a standard gamepad works too. The page title is the ROM header's title.

## Running and measuring

### `npm run conformance`: the machine's own tests

<!-- sample: tools/conformance.ts lines 4-4 -->
```text
// npm run conformance
```

Runs every conformance ROM in [`tests/conformance/`](../../tests/conformance/) twice: each must
reach `STOP` with 600D in work RAM word 8000 and both runs must end in the same state hash. A
failing ROM reports the number of its failing check. See [Conformance](conformance.md).

### `npm run budget`: what a cartridge costs

<!-- sample: tools/budget.ts lines 4-6 -->
```text
// npm run budget [-- name... [--frames N] [--replays <dir>]]
// Resource budget report for each cartridge, measured by running the real ROM on the emulator. A
// name is a ROM of the project (roms/<name>/, conformance/<name>) or the path of a .asm or .scr
```

Runs each cartridge on the emulator (600 frames without input, or its completion replay) and
measures what a real console would limit: ROM size and the smallest cartridge board it fits,
CPU cycles busy per frame against the 59,736 available, sprites per line against 16, lights per
line against 4, and the Cue voices used. A displayed frame that never reaches `WAI` has overrun.
It writes `build/budget/<name>.json` and exits 1 if anything is over a limit or a completion
replay fails. With no names it checks every cartridge and every replay.

<!-- run -->
```sh
npm run budget -- examples/tutorial-1/step2.asm --frames 120
```

### `npm run replay`: completion replays

<!-- sample: tools/replay.ts lines 4-4 -->
```text
// npm run replay [-- --dir <folder>]
```

A completion replay (`replays/<name>.replay.json`) is the controller input that wins a
cartridge, frame by frame. The tool rebuilds the ROM, requires its SHA-256 to match the replay
and the manifest, plays the input from power-on, and passes only if the final machine state and
the game's own win variable match what the replay records.
[`replays/slice-test.replay.json`](../../replays/slice-test.replay.json) is one.

### `npm run frame`: a screenshot from the emulator

<!-- sample: tools/render-frame.ts lines 4-4 -->
```text
// npm run frame -- <cartridge.asm | cartridge.scr | image.rom> <frames> <out.png> [--pad <bits>] [--from <frame>] [--scale <n>]
```

Runs the cartridge from power-on for the given number of frames and writes the last picture as a
PNG. `--pad` holds controller-1 buttons from frame `--from` on (bit 0 Up, 1 Down, 2 Left, 3 Right,
4 A, 5 B, 6 C, 7 START); `--scale` repeats each pixel. The same arguments always give the same
bytes: every picture in these guides is made this way and re-rendered by the tests
([`docs/guide/images/images.json`](images/images.json)).

<!-- run -->
```sh
npm run frame -- examples/tutorial-1/step2.asm 40 .tmp/step2.png --pad 9 --from 10
```

### `node tools/song-wav.ts`: hear a song

<!-- sample: tools/song-wav.ts lines 4-4 -->
```text
// node tools/song-wav.ts [cartridge.asm] [--song SONG_name] [--seconds N] [--out file.wav] [--skip-frame F]
```

Runs a cartridge until the Cue Sound Driver starts the named song, then records the Cue's output
to a 16-bit mono WAV at its own sample rate (47,940 Hz). The default is the Sound Test's theme.
It also prints the driver's measured cost per frame.

### `npm run golden`: golden frames

<!-- sample: tools/golden-frames.ts lines 4-4 -->
```text
// node tools/golden-frames.ts [--update]
```

Plays each completion replay and compares the picture at a few checkpoints with
[`tests/golden/frames.json`](../../tests/golden/frames.json) and its reference PNGs; a mismatch
writes the expected, actual and difference pictures to `.tmp/golden/`. `--update` rewrites them
(only after a deliberate change of what a cartridge draws).

## Checking

### `npm run verify`: the whole gate

<!-- sample: tools/verify.ts lines 6-6 -->
```text
//   node tools/verify.ts [--allow-dirty] [--part <static|emulation|browser>]... [--list]
```

Every check in order, each in its own process with a timeout: the doctor, the type check, the ROM
build, budgets and completion replays, the conformance ROMs and every test tier. It prints one
PASS or FAIL line per step and writes each step's full output to `.tmp/verify/`. `--part` runs
one part (static, emulation or browser) as CI does; `--list` shows the plan; `--allow-dirty` lets
the doctor pass with uncommitted changes.

### `npm test` and the test tiers

<!-- sample: tools/test-tier.ts lines 5-5 -->
```text
//   node tools/test-tier.ts <fast|slow|browser|node|all>[,<tier>...] [--list] [<node --test flags>] [-- <flags>]
```

`npm test` runs every tier; `npm run test:fast`, `npm run test:slow` and `npm run test:browser`
run one. A test file's tier comes from what it does: *browser* files import Playwright, *slow*
files carry a `// test-tier: slow` line (whole-game playthroughs), everything else is *fast*.
`CYC_TEST_CONCURRENCY=<n>` sets how many files run at once. See [Testing](testing.md).

### `npm run coverage`

<!-- sample: tools/coverage.ts lines 4-4 -->
```text
// npm run coverage [-- --tier fast|node] [--enforce]
```

Line, branch and function coverage from Node's built-in coverage, written to `.tmp/coverage/`
(an lcov file and a summary). The thresholds are reported, and fail the run only with
`--enforce`.

### `npm run doctor` and `npm run typecheck`

<!-- sample: tools/doctor.ts lines 4-4 -->
```text
// npm run doctor [-- --allow-dirty] [--no-browser]
```

The doctor checks the Node version against `.nvmrc`, every dependency's installed version against
`package.json`, that headless Chromium launches, and that the git working tree is clean.
`npm run typecheck` runs the TypeScript compiler over the whole tree without emitting anything.

<!-- run -->
```sh
npm run typecheck
```

### `node tools/doc-check.ts`: the docs are real

<!-- sample: tools/doc-check.ts lines 6-6 -->
```text
//   node tools/doc-check.ts [file.md ...]      (no files: the SDK docs of this tree)
```

Checks the guides: every relative link resolves, and every code block is either an exact excerpt
of a file the tests build or run, marked `<!-- sample: path lines a-b -->`, or shell commands this
tree can run. See [CONTRIBUTING.md](../../CONTRIBUTING.md) ("Docs are code").

## Other scripts

- `npm run manual` rebuilds [`docs/manual/index.html`](../manual/index.html) from the fragments in
  `docs/manual/src/`; a test requires the committed page to equal a fresh build.
