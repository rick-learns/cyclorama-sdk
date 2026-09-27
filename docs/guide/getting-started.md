# Getting started

This page takes you from a fresh clone to a cartridge running in your browser, with every
check of the project passing on your machine.

## What you need

- **Node.js 24.21.0**, exactly: the version in [`.nvmrc`](../../.nvmrc). With nvm run `nvm use`
  in the folder (fnm with `--use-on-cd` switches by itself). The toolchain is TypeScript that Node runs
  directly, so there is no compile step. The doctor refuses any other version, and the ROM
  manifest records the one the ROMs were built with.
- **git**.
- A few hundred megabytes of disk for the dependencies and the headless Chromium the browser
  tests use.

Nothing else: no C compiler, no emulator to install, no network once the dependencies are in.

## Install

```sh
git clone https://github.com/rick-learns/cyclorama-sdk.git
cd cyclorama-sdk
npm ci
npx playwright install chromium
npm run doctor
```

`npm ci` installs the four pinned development dependencies (TypeScript, esbuild, Playwright and
the Node type definitions) from the lockfile. Playwright's Chromium runs the browser tests. On
Linux, Chromium also needs system libraries: `npx playwright install --with-deps chromium`
installs them too (it asks for administrator rights).
`npm run doctor` checks the Node version, the installed dependency versions, that Chromium
launches, and that the working tree is clean.

## Build every ROM

<!-- run -->
```sh
npm run build:roms
npm run conformance
```

`build:roms` assembles or compiles every cartridge under [`roms/`](../../roms/) and every
conformance ROM under [`tests/conformance/`](../../tests/conformance/) into `build/roms/`. The
build is a pure function of the sources: [`roms/manifest.json`](../../roms/manifest.json) records
each ROM's size and SHA-256, and the tests rebuild every ROM twice and compare it with the
manifest. `conformance` runs the conformance ROMs, the executable definition of the machine: each
one exercises part of the hardware and reports pass or the number of the check that failed.

## Play a cartridge

<!-- run -->
```sh
npm run player -- roms/lantern-test/lantern-test.asm .tmp/lantern-test.html
```

This writes one self-contained web page with the reference player and the ROM inside. Open
`.tmp/lantern-test.html` in a browser; it needs no server and no network. Click or press a key
to start (browsers only allow sound after a click or a key), then use the arrow keys for the D-pad, Z, X and C for
A, B and C, and Enter for START. A gamepad works too. In Lantern Test the D-pad walks the cat
around a dark room lit by the lantern it carries, and A widens the light.

The cartridges in this repository:

| Cartridge | Language | What it shows |
|---|---|---|
| [`roms/lantern-test/`](../../roms/lantern-test/) | CYASM | The light field: one moving light over a tiled room, a sprite drawn unlit |
| [`roms/lantern-scrim/`](../../roms/lantern-scrim/) | SCRIM | The same demo written in SCRIM |
| [`roms/sound-test/`](../../roms/sound-test/) | CYASM | The Cue Sound Driver: a theme and sound effects over it |
| [`roms/slice-test/`](../../roms/slice-test/) | SCRIM | A complete small game with a title screen, lives and a completion replay |

## Run the gate

```sh
npm run verify
```

`verify` is every check the project has, in order: the doctor, the type check, the ROM build,
cartridge budgets and completion replays, the conformance ROMs, and every test (unit tests, ROM
hashes, golden frames, the browser tests in headless Chromium). It prints one PASS or FAIL line
per step and keeps each step's full output in `.tmp/verify/`. A clean checkout passes; if it does
not on your machine, that is a bug worth reporting. The doctor step requires a clean git tree:
while you have uncommitted changes, run `node tools/verify.ts --allow-dirty`. To experiment with a
tutorial program, copy its folder (for example to `examples/my-lamp/`) and change the copy: the
tests check that the tutorials' own programs match their pages, so editing those makes the gate
fail on purpose, and a copy in `examples/` is built and run by the tests like any example.

## Where to go next

- [Tutorial 1](tutorial-1-cyasm.md): your first cartridge, in assembly.
- The [command-line reference](cli.md) lists every tool, and the [guides index](README.md) the
  rest.
- The [hardware and programmer's manual](../manual/index.html) (HED-0041) describes the whole
  machine: the Tally CPU, memory, cartridges, the Barndoor video chip and its light field, the
  Cue audio chip, the controllers and the CYASM assembler.
