// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// File-name helpers shared by the SCRIM compiler stages (INCLUDE, INCBIN, LINK, ASSET).

const ABSOLUTE = /^([A-Za-z]:)?[\\/]/;

/** Resolve `name` relative to the directory of `from` (absolute names are kept). */
export function resolvePath(from: string, name: string): string {
  if (ABSOLUTE.test(name)) return name;
  const i = Math.max(from.lastIndexOf("/"), from.lastIndexOf("\\"));
  const parts: string[] = [];
  for (const seg of ((i < 0 ? "" : from.slice(0, i + 1)) + name).split(/[\\/]/)) {
    if (seg === "." || seg === "") continue;
    if (seg === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(seg);
  }
  return (/^[\\/]/.test(from) ? "/" : "") + parts.join("/");
}

/**
 * `to` (a resolvePath result) written relative to the directory of `fromFile`, with forward
 * slashes, so that resolvePath(fromFile, relativePath(fromFile, to)) names the same file. Absolute
 * targets that share nothing with `fromFile` are returned unchanged.
 */
export function relativePath(fromFile: string, to: string): string {
  const dir = resolvePath(fromFile, "x").split("/").slice(0, -1);
  const target = to.split(/[\\/]/);
  if (ABSOLUTE.test(to) !== ABSOLUTE.test(fromFile) || (ABSOLUTE.test(to) && dir[0] !== target[0])) return to;
  let k = 0;
  while (k < dir.length && k < target.length - 1 && dir[k] === target[k]) k++;
  if (dir.slice(k).includes("..")) return to;
  return [...dir.slice(k).map(() => ".."), ...target.slice(k)].join("/");
}
