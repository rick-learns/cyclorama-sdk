// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// A node --test reporter that tools/test-tier.ts adds next to spec (on stderr): it sums each
// file's top-level test durations and warns about fast-tier files over 5 s, so `npm run test:fast`
// stays a quick loop (docs/guide/testing.md "Tiers"). It only ever prints; nothing here can fail a run.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { classify } from "./test-tier.ts";

export const FAST_FILE_WARN_MS = 5000;

// Every node:test event reaches the reporter (diagnostics carry `message`, and so on); only
// test:pass / test:fail with a file and nesting 0 are read.
type Event = { type: string; data?: { file?: string; nesting?: number; details?: { duration_ms?: number }; [other: string]: unknown } };
type Options = { cwd?: string; read?: (file: string) => string; env?: NodeJS.ProcessEnv };

export default async function* fastFileTimer(source: AsyncIterable<Event>, opts: Options = {}): AsyncGenerator<string> {
  const cwd = opts.cwd ?? process.cwd(), read = opts.read ?? ((f: string) => readFileSync(f, "utf8")), env = opts.env ?? process.env;
  const ms = new Map<string, number>();
  for await (const e of source) {
    try {
      if ((e.type === "test:pass" || e.type === "test:fail") && e.data?.nesting === 0 && e.data.file)
        ms.set(e.data.file, (ms.get(e.data.file) ?? 0) + (e.data.details?.duration_ms ?? 0));
    } catch { /* never fail the run */ }
  }
  const prefix = env.GITHUB_ACTIONS === "true" ? "::warning::" : "test-tier: warning: ";
  for (const [file, total] of [...ms].sort((a, b) => b[1] - a[1])) {
    if (total <= FAST_FILE_WARN_MS) continue;
    let tier: string;
    try { tier = classify(read(file)); } catch { continue; }
    if (tier !== "fast") continue;
    const rel = relative(cwd, file).replace(/\\/g, "/");
    yield `${prefix}${rel}: fast-tier file took ${(total / 1000).toFixed(1)} s (over ${FAST_FILE_WARN_MS / 1000} s); mark it \`// test-tier: slow\` or split the slow test out\n`;
  }
}
