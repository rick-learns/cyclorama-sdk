// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// The kit's ".art" asset converter and the on-demand source reader every ROM build uses.
// The implementation lives in src/assets/art.ts, because the SCRIM compiler links assets through
// it and src/ never imports tools/ (docs/guide/architecture.md); this module keeps the tools/ entry point.
export { convertArt, sourceReader } from "../src/assets/art.ts";
