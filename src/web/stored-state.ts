// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// The load rule for save states a front end stored itself (the museum's store, the app's slots,
// the debugger's memory slot and localStorage), shared by the open debugger logic and the
// official app so neither depends on the other.
import { SaveStateError, saveStateInfo, type LoadStateOptions } from "../machine/savestate.ts";

/**
 * Load options for a state from a front end's own store. Front ends have written only v2 states
 * since save states v2 (docs/spec-notes.md "Save-state format"), so a v1 state there was written
 * before v2 and may load without a ROM check; anything else must match the ROM.
 */
export function storedStateLoadOptions(state: Uint8Array): LoadStateOptions {
  try { return { allowUnverifiedV1: saveStateInfo(state).version === 1 }; } catch { return { allowUnverifiedV1: false }; }
}

/** What to tell the player when a save state does not load (app, museum and debugger). */
export function loadFailureMessage(e: unknown, title: string): string {
  if (!(e instanceof SaveStateError)) return `The save could not be loaded: ${(e as Error)?.message ?? e}`;
  switch (e.kind) {
    case "wrong-rom": return `This save is from a different version of ${title}. It was not loaded and is kept.`;
    case "truncated": return "This save is incomplete (it was cut short) and was not loaded.";
    case "corrupt": return "This save is damaged and was not loaded.";
    case "unsupported-version": return "This save was made by a newer version of the player and was not loaded.";
    case "unverified-v1": return `This save's cartridge version cannot be checked, so it was not loaded.`;
  }
}
