# Embedding the emulator

The emulator is a TypeScript library with no dependencies and no I/O of its own: you give it a
ROM and controller input, and it gives you machine state, pictures and sound. The same code runs
the tests in Node and the reference player in the browser. This page walks through
[`examples/embed/headless.ts`](../../examples/embed/headless.ts), a complete program that a test
runs on every check.

<!-- run -->
```sh
node examples/embed/headless.ts
```

It prints the lamp's position, the picture and sound it collected, and two lines saying that a
restored save state and a fresh run both reach exactly the same state.

## A ROM and a machine

<!-- sample: examples/embed/headless.ts lines 7-15 -->
```ts
import { Machine } from "../../src/machine/machine.ts";
import { Tally } from "../../src/machine/cpu.ts";
import { buildOne } from "../../tools/build-roms.ts";

// 1. A ROM: any cartridge image works; here Tutorial 1's step 2, built from source.
const rom = buildOne({ name: "step2", file: "examples/tutorial-1/step2.asm", lang: "asm" });

// 2. A machine: the Tally CPU core is passed in; the Cue audio chip is the default.
const m = new Machine(rom, { cpu: new Tally() });
```

A ROM is a `Uint8Array`: read one from a file, or build one from source with `buildOne` (CYASM or
SCRIM, the same function the ROM build uses). The `Machine` powers on at construction: registers
take their reset values and the CPU starts at the RESET vector. A cartridge without the `CYCL`
signature at 0010 is refused as the console would refuse it: `m.running` is then false and no
instruction executes.

## Running it

<!-- sample: examples/embed/headless.ts lines 17-20 -->
```ts
// 3. Run frames. Each runFrame takes the two controllers' buttons (bit 0 Up, 1 Down,
//    2 Left, 3 Right, 4 A, 5 B, 6 C, 7 START) and runs until the next frame starts.
const RIGHT = 8, A = 16;
for (let f = 0; f < 30; f++) m.runFrame(f === 5 ? A : RIGHT, 0);
```

`runFrame(pad1, pad2)` emulates one frame, 358,416 master clock cycles (59,736 CPU cycles), about
1/60 s of console time. It takes as long as it takes on your computer: the machine has no idea of
host time, so it can run faster than real time for tests or be paced by a display. The buttons
you pass are what the controllers show when the console samples them at the start of vertical
blank. `m.frame` counts the frames run.

## Reading the results

<!-- sample: examples/embed/headless.ts lines 22-29 -->
```ts
// 4. Read what the program did: work RAM (8000-BFFF is wram[0..16383]), the picture
//    (256 x 224 pixels, 0xRRGGBB), the sound (16-bit mono samples at about 47,940 Hz).
const word = (addr: number) => m.wram[addr - 0x8000] | (m.wram[addr - 0x8000 + 1] << 8);
const lit = m.framebuffer.filter(p => p !== m.framebuffer[0]).length;
const sound = m.audio.takeSamples();
let peak = 0;
for (const v of sound) peak = Math.max(peak, Math.abs(v));
console.log(`after ${m.frame} frames: lamp at x=${word(0x8000)} y=${word(0x8002)}, ${lit} lamp pixels, ${sound.length} audio samples, peak ${peak}`);
```

- **Memory.** `m.wram` is work RAM (a CPU address *a* in 8000-BFFF is `wram[a - 0x8000]`; words
  are little-endian). `m.cartRam` is the cartridge's battery-backed RAM, `m.video` holds VRAM,
  OAM and CRAM, and `m.inspect()` returns a copy of every I/O register, the bank, the beam line
  and the latched pads, without side effects.
- **Picture.** `m.framebuffer` is the last completed frame, 256 × 224 pixels, one `0xRRGGBB`
  number each, row by row. `npm run frame` writes it as a PNG
  ([command-line reference](cli.md#npm-run-frame-a-screenshot-from-the-emulator)).
- **Sound.** `m.audio.takeSamples()` returns the signed 16-bit mono samples the Cue chip made
  since the last call, one every 448 master cycles (about 47,940 a second). The browser player
  resamples them to the sound card's rate.

## Save states

<!-- sample: examples/embed/headless.ts lines 31-38 -->
```ts
// 5. Save states: a save names its ROM by SHA-256 and restores the machine exactly.
const saved = m.saveState();
for (let f = 0; f < 60; f++) m.runFrame(0, 0);
const later = m.hash();
const copy = new Machine(rom, { cpu: new Tally() });
copy.loadState(saved);
for (let f = 0; f < 60; f++) copy.runFrame(0, 0);
console.log(`save state: ${saved.length} bytes; restored and re-run: ${copy.hash() === later ? "identical" : "DIFFERENT"} (hash ${later})`);
```

`saveState()` returns the complete machine (CPU, registers, work RAM, cartridge RAM, video memory,
the audio chip and the beam position) as one byte array that names its ROM by SHA-256.
`loadState` checks everything first and throws a `SaveStateError` without changing the machine if
the state is truncated, corrupt, from another ROM or from an unknown version. The format is
specified in the [spec notes](../spec-notes.md) ("Save-state format").

## Determinism

<!-- sample: examples/embed/headless.ts lines 40-44 -->
```ts
// 6. Determinism: a fresh machine given the same input reaches the same state, bit for bit.
const again = new Machine(rom, { cpu: new Tally() });
for (let f = 0; f < 30; f++) again.runFrame(f === 5 ? A : RIGHT, 0);
for (let f = 0; f < 60; f++) again.runFrame(0, 0);
console.log(`fresh run with the same input: ${again.hash() === later ? "identical" : "DIFFERENT"}`);
```

The emulated clock alone decides timing, and nothing in the machine reads the host's time or
randomness. So a ROM and a list of per-frame controller inputs determine every later state:
`m.hash()` (8 hex digits over the complete state) is equal for equal histories on any computer,
in Node or in a browser, at any display rate. That is what makes completion replays, golden
frames and these guides' pictures reproducible, and what a netplay or rewind feature can rely on.

## In a web page

The reference player ([`src/web/player.ts`](../../src/web/player.ts)) is the browser host: it
paces whole frames to the display, draws the framebuffer on a canvas, plays the sound through an
AudioWorklet, and reads the keyboard and gamepads. Its entry script is short:

<!-- sample: src/web/main.ts lines 10-22 -->
```ts
const bin = atob(window.__ROM_B64__);
const rom = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) rom[i] = bin.charCodeAt(i);

const canvas = document.getElementById("screen") as HTMLCanvasElement;
const player = new Player(canvas, rom);
window.__player = player;
player.start();

const overlay = document.getElementById("start")!;
const begin = async () => { overlay.remove(); try { await player.enableAudio(); } catch (e) { console.warn("audio unavailable", e); } };
overlay.addEventListener("click", begin, { once: true });
window.addEventListener("keydown", () => { if (overlay.isConnected) begin(); }, { once: true });
```

`npm run player` bundles it with a ROM into one page; for your own page, bundle
`src/web/player.ts` with your tool of choice and hand the `Player` a canvas and a ROM. Browsers
only allow sound after a user gesture, hence `enableAudio` on the first click or key press. In the standalone
page F5 saves a state and F8 restores it.
