# Cyclorama SDK guides

Start with [Getting started](getting-started.md), then the tutorials.

## Learn

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | Install, build every ROM, run the gate, play a cartridge in the browser |
| [Tutorial 1: a lamp on the stage (CYASM)](tutorial-1-cyasm.md) | A first cartridge in assembly: colours, a sprite, the pad, a note |
| [Tutorial 2: gems in the dark (SCRIM)](tutorial-2-scrim.md) | A small complete game in SCRIM: the light field, music and sound effects from the Cue Sound Driver, winning |

## Reference

| Page | What it covers |
|---|---|
| [Command-line reference](cli.md) | Every tool: build, run, measure, check |
| [SDK library reference](sdk-library.md) | Every routine of the Cue Sound Driver and the SCRIM runtime: arguments, results, registers changed, stack, measured cycles |
| [Embedding the emulator](embedding.md) | The headless machine: running frames, memory, pictures, sound, save states, determinism, the browser player |
| [Debugging](debugger.md) | Breakpoints, stepping, watchpoints and the video-chip views, as a library |
| [Conformance](conformance.md) | The ROMs that define the machine, and using them for another implementation |
| [Testing](testing.md) | The test tiers, what the tests pin, and testing your own cartridge |
| [Architecture](architecture.md) | The module map, how a ROM is made, how the machine runs, the dependency and determinism rules |

## The specification

- The [hardware and programmer's manual](../manual/index.html) (HED-0041): the whole machine.
- The [spec notes](../spec-notes.md): rulings that settle what the manual left open.
- The [SCRIM language specification](../scrim-spec.md).
