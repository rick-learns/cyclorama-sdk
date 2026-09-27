// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Save-state container format (docs/spec-notes.md "Save-state format"). All header words are little-endian u32.
//
//   v2 (written):  magic "SCYC" (0x43594353) | version 2 | ROM SHA-256 (32 bytes) | part count n
//                  | n part lengths | the n parts
//   v1 (read on opt-in only, and the input of Machine.hash()):
//                  magic | version 1 | part count n | n part lengths | the n parts
//
// The parts are identical in both versions: scalars, work RAM, cartridge RAM, VRAM, OAM, CRAM,
// CPU state, audio state. The v1 layout carries no ROM identity, so decodeState accepts it only
// when the caller opts in; v2 is accepted only for the ROM whose SHA-256 it names.
import { sha256, toHex } from "./sha256.ts";

export const STATE_MAGIC = 0x43594353;
export const STATE_VERSION = 2;
export const STATE_PARTS = 8;
const V1_HEADER = 12, V2_HEADER = 44;       // bytes before the part lengths

export type SaveStateErrorKind = "wrong-rom" | "truncated" | "corrupt" | "unsupported-version" | "unverified-v1";

/** Why a state was refused. The machine that refused it is unchanged. */
export class SaveStateError extends Error {
  readonly kind: SaveStateErrorKind;
  /** The SHA-256 the state names (v2 only), so a UI can say which build it came from. */
  readonly stateRomSha256: string | null;
  constructor(kind: SaveStateErrorKind, message: string, stateRomSha256: string | null = null) {
    super(message);
    this.name = "SaveStateError";
    this.kind = kind;
    this.stateRomSha256 = stateRomSha256;
  }
}

export type LoadStateOptions = {
  /** Accept a v1 state, which cannot say which ROM it belongs to. Only for storage written before v2. */
  allowUnverifiedV1?: boolean;
};

export type SaveStateInfo = { version: 1 | 2; romSha256: string | null };

const romIds = new WeakMap<Uint8Array, Uint8Array>();
/** The ROM's SHA-256, computed once per ROM array (a Machine never changes its ROM bytes). */
export function romSha256(rom: Uint8Array): Uint8Array {
  let id = romIds.get(rom);
  if (!id) { id = sha256(rom); romIds.set(rom, id); }
  return id;
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Encode parts as v2 (when `rom` is the ROM's SHA-256) or as the v1 layout (when it is null). */
export function encodeState(parts: Uint8Array[], rom: Uint8Array | null): Uint8Array {
  const head = rom ? V2_HEADER : V1_HEADER;
  const out = new Uint8Array(head + 4 * parts.length + parts.reduce((n, p) => n + p.length, 0));
  const d = view(out);
  d.setUint32(0, STATE_MAGIC, true);
  d.setUint32(4, rom ? 2 : 1, true);
  if (rom) out.set(rom, 8);
  d.setUint32(head - 4, parts.length, true);
  let o = head;
  for (const p of parts) { d.setUint32(o, p.length, true); o += 4; }
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Version and ROM identity from a state's header, without decoding the parts. */
export function saveStateInfo(b: Uint8Array): SaveStateInfo {
  if (b.length < 8) throw new SaveStateError("truncated", `save state is ${b.length} bytes, too short for a header`);
  const d = view(b);
  if (d.getUint32(0, true) !== STATE_MAGIC) throw new SaveStateError("corrupt", "not a Cyclorama save state (bad magic)");
  const version = d.getUint32(4, true);
  if (version !== 1 && version !== 2) throw new SaveStateError("unsupported-version", `save state version ${version} is not supported (this emulator reads 1 and 2)`);
  if (version === 1) return { version, romSha256: null };
  if (b.length < 40) throw new SaveStateError("truncated", "save state ends inside its ROM identity");
  return { version, romSha256: toHex(b.subarray(8, 40)) };
}

/**
 * Validate a state's container against the loading machine and return copies of its parts.
 * Checks, in order: header, version, ROM identity (or the v1 opt-in), part count, each part's
 * length against `lengths`, and the total size. Throws SaveStateError; never touches a machine.
 */
export function decodeState(b: Uint8Array, expect: { rom: Uint8Array; lengths: number[] }, o: LoadStateOptions = {}): Uint8Array[] {
  const info = saveStateInfo(b);
  if (info.version === 1 && !o.allowUnverifiedV1)
    throw new SaveStateError("unverified-v1", "version 1 save state has no ROM identity; load it only from storage written before version 2");
  const want = toHex(expect.rom);
  if (info.romSha256 !== null && info.romSha256 !== want)
    throw new SaveStateError("wrong-rom", `save state belongs to ROM ${info.romSha256.slice(0, 12)}…, not this ROM ${want.slice(0, 12)}…`, info.romSha256);
  const head = info.version === 1 ? V1_HEADER : V2_HEADER;
  if (b.length < head) throw new SaveStateError("truncated", "save state ends inside its header");
  const d = view(b);
  const n = d.getUint32(head - 4, true);
  if (n !== expect.lengths.length) throw new SaveStateError("corrupt", `save state has ${n} parts, expected ${expect.lengths.length}`);
  if (b.length < head + 4 * n) throw new SaveStateError("truncated", "save state ends inside its part table");
  let total = head + 4 * n;
  for (let i = 0; i < n; i++) {
    const len = d.getUint32(head + 4 * i, true);
    if (len !== expect.lengths[i]) throw new SaveStateError("corrupt", `save state part ${i} is ${len} bytes, expected ${expect.lengths[i]}`);
    total += len;
  }
  if (b.length < total) throw new SaveStateError("truncated", `save state is ${b.length} bytes, its header promises ${total}`);
  if (b.length > total) throw new SaveStateError("corrupt", `save state has ${b.length - total} bytes after its last part`);
  const parts: Uint8Array[] = [];
  let at = head + 4 * n;
  for (const len of expect.lengths) { parts.push(b.slice(at, at + len)); at += len; }
  return parts;
}
