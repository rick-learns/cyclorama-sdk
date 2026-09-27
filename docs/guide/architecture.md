# Architecture

A map of the code for people changing it. What the machine does is specified in the
[manual](../manual/index.html) and settled in the [spec notes](../spec-notes.md); the code
implements exactly that.

## Module map

| Path | What it is |
|---|---|
| [`src/isa/`](../../src/isa/) | The Tally instruction set: encodings and cycle counts (`isa.ts`, the one table the assembler, disassembler, emulator and manual share) and the manual's instruction prose (`reference.ts`) |
| [`src/hw/`](../../src/hw/) | The I/O register map (`registers.ts`), shared by the emulator, the assembler's predefined symbols and the manual |
| [`src/machine/`](../../src/machine/) | The emulator core: the CPU (`cpu.ts`), the bus, interrupts, timer, DMA and the master-cycle scheduler (`machine.ts`), the video chip (`video/render.ts`), the audio chip (`audio.ts`) and save states (`savestate.ts`) |
| [`src/asm/`](../../src/asm/) | CYASM: the two-pass assembler and the disassembler |
| [`src/assets/`](../../src/assets/) | The `.art` and `.song` converters, and `sourceReader`, which converts them on demand while a ROM builds |
| [`src/scrim/`](../../src/scrim/) | The SCRIM compiler: lexer, parser, checker, code generator and driver (`compile.ts`), which emits CYASM and assembles it; `runtime.inc` is the runtime it links in |
| [`src/web/`](../../src/web/) | Browser hosts: the reference player (`player.ts`) with its frame pacing, input, resampling and audio output, the conformance harness, and the debugger logic (`debugger/session.ts`, `debugger/views.ts`) |
| [`tools/`](../../tools/) | The command-line tools behind `npm run …` ([reference](cli.md)); `tools/art.ts` and `tools/song.ts` re-export `src/assets/` for scripts |
| [`tests/`](../../tests/) | The `node --test` suites, the conformance ROM sources (`tests/conformance/`), golden frames and fixtures ([Testing](testing.md)) |
| [`roms/`](../../roms/) | Cartridge sources (`roms/<name>/`), the SDK runtime includes (`roms/lib/`) and `roms/manifest.json` |
| [`replays/`](../../replays/) | Completion replays: the input that wins a cartridge and the machine state it must end in |
| [`examples/`](../../examples/) | The programs these guides quote, each built and run by the tests |

## How a ROM is made

1. **Assets.** A source includes `x.art.inc` or `x.song.inc`; `sourceReader` produces it from
   `x.art` or `x.song` when no such file exists, so pictures and music stay readable text.
2. **SCRIM** compiles to CYASM text (`src/scrim/compile.ts`), linking only the runtime routines the
   program uses and the libraries and assets it names with `LINK` and `ASSET`.
3. **CYASM** assembles in two passes (`src/asm/assembler.ts`): the first fixes every symbol and
   every instruction's size, the second encodes, fills unused space with FF in whole 16 KiB banks, and writes the header's
   checksum.
4. **The manifest.** [`roms/manifest.json`](../../roms/manifest.json) records every ROM's size and
   SHA-256. A ROM is a pure function of the sources, so the tests rebuild each one twice and
   compare them with the manifest.

## How the machine runs

`Machine` counts master clock cycles (21.477 MHz, 358,416 per frame). The CPU core executes one
instruction at a time and reports its cycles; the bus adds the wait cycles of video ports and DMA
stalls; the scheduler raises VBLANK, LINE and TIMER interrupts at the exact master cycle the
manual gives, and runs the video chip one line at a time, latching registers at the dots the
manual names. The audio chip is brought up to the current master cycle before each write to one of
its registers and at the end of each frame, producing one sample every 448 master cycles. `runFrame`
runs to the end of the frame and leaves the finished picture in `framebuffer`.

The core imports nothing from Node or the browser: hosts (the tests, the player, the tools) give
it ROM bytes and controller values and read its state back.

## Dependency rules

Checked by [`tests/module-rules.test.ts`](../../tests/module-rules.test.ts) over every TypeScript
file of the tree (the rules are in [`tests/module-graph.ts`](../../tests/module-graph.ts)):

1. `src/` never imports `tools/` or `tests/`: what ships does not depend on scripts or tests.
2. `tools/` never imports `tests/`.
3. `src/machine/` imports only `src/machine/`, `src/hw/` and `src/isa/`: the core has no host
   dependencies at all.
4. No import cycles, type-only imports included.

A known exception is declared on the import line itself, with its reason
(`// module-rules: allow — <why>`); a marker that no longer excuses anything fails the test.

## Where determinism lives

The same ROM and the same controller input must give the same machine state, frame and sample on
every host: that is what makes a replay a proof.

- **The machine owns time.** Machine state is integers only, and nothing in the core reads the
  host's clock or randomness.
- **The host decides only how many whole frames to run.** `src/web/pacing.ts` turns elapsed wall
  time into a frame count; the display rate changes when frames are shown, never what they contain.
- **ROMs are pure functions of the sources.** `src/asm`, `src/assets` and `src/scrim` read nothing
  but their input files.
- **Checked by** [`tests/determinism-rules.test.ts`](../../tests/determinism-rules.test.ts) (no host
  time, randomness, timers, or Math functions whose last bit may differ between JavaScript engines,
  in the core and the toolchain), the conformance ROMs (each run twice), the completion replays
  and golden frames, and a browser test that compares Node's and Chromium's state hashes after the
  same frames.
