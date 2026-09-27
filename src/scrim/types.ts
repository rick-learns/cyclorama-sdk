// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// SCRIM types (docs/scrim-spec.md §2).

export type Field = { name: string; off: number; type: Type };

export type Type =
  | { k: "byte" } | { k: "word" } | { k: "int" } | { k: "fixed" } | { k: "bool" }
  | { k: "ulit" }                 // untyped integer constant (adapts to its context)
  | { k: "nil" }
  | { k: "addr" }                 // runtime-library parameter: any pointer, WORD or NIL
  | { k: "void" }
  | { k: "err" }                  // result of an erroneous expression (suppresses follow-on errors)
  | { k: "array"; len: number | null; elem: Type }
  | { k: "record"; name: string; fields: Field[]; size: number; align: number }
  | { k: "pointer"; to: Type };

export const T = {
  byte: { k: "byte" } as Type, word: { k: "word" } as Type, int: { k: "int" } as Type,
  fixed: { k: "fixed" } as Type, bool: { k: "bool" } as Type, ulit: { k: "ulit" } as Type,
  nil: { k: "nil" } as Type, addr: { k: "addr" } as Type, void: { k: "void" } as Type, err: { k: "err" } as Type,
};

export function sizeOf(t: Type): number {
  switch (t.k) {
    case "byte": case "bool": return 1;
    case "array": return (t.len ?? 0) * sizeOf(t.elem);
    case "record": return t.size;
    default: return 2;
  }
}

export function alignOf(t: Type): number {
  switch (t.k) {
    case "byte": case "bool": return 1;
    case "array": return alignOf(t.elem);
    case "record": return t.align;
    default: return 2;
  }
}

export const isScalar = (t: Type) => t.k !== "array" && t.k !== "record" && t.k !== "void";
export const isInteger = (t: Type) => t.k === "byte" || t.k === "word" || t.k === "int" || t.k === "ulit";
export const isNumeric = (t: Type) => isInteger(t) || t.k === "fixed";
export const isSigned = (t: Type) => t.k === "int" || t.k === "fixed";
export const isUnsigned = (t: Type) => t.k === "byte" || t.k === "word";
/** Values of this type always lie in 0..255 (so a BYTE store needs no masking). */
export const isByteRange = (t: Type) => t.k === "byte" || t.k === "bool";

export function typeEq(a: Type, b: Type, depth = 0): boolean {
  if (a === b) return true;
  if (a.k !== b.k || depth > 32) return false;
  switch (a.k) {
    case "array": return b.k === "array" && a.len === b.len && typeEq(a.elem, b.elem, depth + 1);
    case "record": return false; // records are equal only by identity
    case "pointer": return b.k === "pointer" && typeEq(a.to, b.to, depth + 1);
    default: return true;
  }
}

export function typeName(t: Type, depth = 0): string {
  switch (t.k) {
    case "ulit": return "integer constant";
    case "nil": return "NIL";
    case "addr": return "address";
    case "void": return "no value";
    case "err": return "?";
    case "array": return `ARRAY [${t.len ?? ""}] OF ${depth > 3 ? "..." : typeName(t.elem, depth + 1)}`;
    case "record": return t.name;
    case "pointer": return `POINTER TO ${depth > 3 ? "..." : typeName(t.to, depth + 1)}`;
    default: return t.k.toUpperCase();
  }
}
