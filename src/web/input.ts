// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Controller input for the browser host: keyboard and Gamepad API (standard
// mapping) to the Cyclorama pad byte: bit 0 Up, 1 Down, 2 Left, 3 Right,
// 4 A, 5 B, 6 C, 7 START.

export const KEYMAP: Record<string, number> = {
  ArrowUp: 1 << 0, ArrowDown: 1 << 1, ArrowLeft: 1 << 2, ArrowRight: 1 << 3,
  KeyZ: 1 << 4, KeyX: 1 << 5, KeyC: 1 << 6, Enter: 1 << 7,
};

export function padFromKeys(down: Set<string>): number {
  let p = 0;
  for (const k of down) p |= KEYMAP[k] ?? 0;
  return p;
}

type PadLike = { buttons: readonly { pressed: boolean }[]; axes: readonly number[] };
const BUTTONS: [index: number, bit: number][] = [[12, 0], [13, 1], [14, 2], [15, 3], [0, 4], [1, 5], [2, 6], [3, 6], [9, 7]];
const DEAD = 0.5;

export function padFromGamepad(g: PadLike): number {
  let p = 0;
  for (const [i, bit] of BUTTONS) if (g.buttons[i]?.pressed) p |= 1 << bit;
  const [x = 0, y = 0] = g.axes;
  if (y < -DEAD) p |= 1; if (y > DEAD) p |= 2; if (x < -DEAD) p |= 4; if (x > DEAD) p |= 8;
  return p;
}
