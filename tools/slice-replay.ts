// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// node tools/slice-replay.ts
// Records replays/slice-test.replay.json: the SLICE TEST cartridge won from power-on by a fixed,
// scripted controller-1 input (run-length [frame, pad1, pad2] entries, as in tools/replay.ts).
// The script: wait on the title, tap START, walk down to the bottom lamp, up-left to the
// top-left lamp, then right along the top to the top-right lamp. No life is lost.
// Pad bits: 1 Up, 2 Down, 4 Left, 8 Right, 16 A, 32 B, 64 C, 128 START.
import { recordReplay, type PadEntry } from "./replay.ts";
import { isCliEntry } from "./cli-entry.ts";

/** GAME_STATE (VAR ... AT $A000 in roms/slice-test/slice-test.scr) and its values. */
export const GAME_STATE_ADDR = 0xa000;
export const ST = { TITLE: 1, PLAY: 2, OVER: 3, WIN: 4 } as const;

export const SLICE_PADS: PadEntry[] = [
  [10, 128, 0],   // START on the title
  [12, 0, 0],
  [14, 2, 0],     // down to the bottom lamp (124, 192)
  [47, 5, 0],     // up-left ...
  [93, 1, 0],     // ... up to the top-left lamp (32, 40)
  [113, 9, 0],    // up-right ...
  [118, 8, 0],    // ... right along the top to the top-right lamp (216, 40): WIN
  [200, 0, 0],
];
export const SLICE_FRAMES = 230;
export const SLICE_WIN = { addr: "$A000", value: "$0004", note: "GAME_STATE = 4 (WIN): all three lamps relit with no life lost" } as const;

if (isCliEntry(import.meta.url)) {
  const file = await recordReplay("slice-test", SLICE_PADS, SLICE_FRAMES, SLICE_WIN);
  console.log(`recorded ${file}`);
}
