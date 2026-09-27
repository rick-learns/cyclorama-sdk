// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// isCliEntry(import.meta.url): true only when this module is the script node was started with.
// It compares the module's own file with process.argv[1], both resolved to absolute real paths,
// so a look-alike (tools/foo-budget.ts importing tools/budget.ts) is never taken for the CLI, as
// it once was by a suffix test on the script name.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function canonical(path: string): string {
  const abs = resolve(path);
  try { return realpathSync(abs); } catch { return abs; }
}

/** Is the module at `moduleUrl` (pass `import.meta.url`) the entry script `argv1`? */
export function isCliEntry(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  return canonical(argv1) === canonical(fileURLToPath(moduleUrl));
}
