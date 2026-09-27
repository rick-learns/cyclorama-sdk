// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Embedding the emulator: build a cartridge, run it headless, read its memory, picture and sound,
// save and restore its state, and show that the same input always gives the same machine.
//   node examples/embed/headless.ts
import { Machine } from "../../src/machine/machine.ts";
import { Tally } from "../../src/machine/cpu.ts";
import { buildOne } from "../../tools/build-roms.ts";

// 1. A ROM: any cartridge image works; here Tutorial 1's step 2, built from source.
const rom = buildOne({ name: "step2", file: "examples/tutorial-1/step2.asm", lang: "asm" });

// 2. A machine: the Tally CPU core is passed in; the Cue audio chip is the default.
const m = new Machine(rom, { cpu: new Tally() });

// 3. Run frames. Each runFrame takes the two controllers' buttons (bit 0 Up, 1 Down,
//    2 Left, 3 Right, 4 A, 5 B, 6 C, 7 START) and runs until the next frame starts.
const RIGHT = 8, A = 16;
for (let f = 0; f < 30; f++) m.runFrame(f === 5 ? A : RIGHT, 0);

// 4. Read what the program did: work RAM (8000-BFFF is wram[0..16383]), the picture
//    (256 x 224 pixels, 0xRRGGBB), the sound (16-bit mono samples at about 47,940 Hz).
const word = (addr: number) => m.wram[addr - 0x8000] | (m.wram[addr - 0x8000 + 1] << 8);
const lit = m.framebuffer.filter(p => p !== m.framebuffer[0]).length;
const sound = m.audio.takeSamples();
let peak = 0;
for (const v of sound) peak = Math.max(peak, Math.abs(v));
console.log(`after ${m.frame} frames: lamp at x=${word(0x8000)} y=${word(0x8002)}, ${lit} lamp pixels, ${sound.length} audio samples, peak ${peak}`);

// 5. Save states: a save names its ROM by SHA-256 and restores the machine exactly.
const saved = m.saveState();
for (let f = 0; f < 60; f++) m.runFrame(0, 0);
const later = m.hash();
const copy = new Machine(rom, { cpu: new Tally() });
copy.loadState(saved);
for (let f = 0; f < 60; f++) copy.runFrame(0, 0);
console.log(`save state: ${saved.length} bytes; restored and re-run: ${copy.hash() === later ? "identical" : "DIFFERENT"} (hash ${later})`);

// 6. Determinism: a fresh machine given the same input reaches the same state, bit for bit.
const again = new Machine(rom, { cpu: new Tally() });
for (let f = 0; f < 30; f++) again.runFrame(f === 5 ? A : RIGHT, 0);
for (let f = 0; f < 60; f++) again.runFrame(0, 0);
console.log(`fresh run with the same input: ${again.hash() === later ? "identical" : "DIFFERENT"}`);
