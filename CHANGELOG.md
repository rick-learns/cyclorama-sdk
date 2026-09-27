# Changelog

All notable changes to the Cyclorama SDK. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Until 1.0.0 a minor version may change the toolchain's
interfaces; the machine itself never changes.

## [Unreleased]

## [0.1.0]

The first public release.

### Added

- The hardware and programmer's manual HED-0041, the spec notes and the SCRIM language
  specification, with the hardware facts as data in `canon/canon-public.json`.
- The deterministic reference emulator (Tally CPU, Barndoor video with the light field, Cue audio,
  controllers, cartridge banking and cartridge RAM, DMA, interrupts, timer) with save states
  (format version 2; version 1 states load on explicit opt-in).
- CYASM, the assembler and disassembler; SCRIM, the compiler; the `.art` and `.song` asset
  converters; the Cue Sound Driver and the SCRIM runtime as SDK runtime code.
- Command-line tools: `asm`, `scrim`, `build:roms` (reproducible builds against
  `roms/manifest.json`), `conformance`, `budget`, `replay`, `golden`, `player`, `frame`,
  `manual`, and the whole gate as `npm run verify`.
- The reference browser player, the browser conformance harness and the debugger logic.
- 15 conformance ROMs; the demo cartridges Lantern Test (CYASM and SCRIM), Sound Test and the
  SLICE test cartridge with its completion replay.
- The SDK guides: getting started, two tutorials (a first cartridge in CYASM, a small game in
  SCRIM), references for the tools, embedding, debugging, conformance, testing and the
  architecture; each code sample an excerpt of a program the tests build and run.
