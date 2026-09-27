// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// GitHub's anchor for a Markdown heading, shared by the docs checker (tools/doc-check.ts) and the
// site's renderer of the SDK guides, so a guide's #anchor links work in the repository and on the site.

/** A heading's anchor: markup and punctuation dropped, lower case, spaces to hyphens (repeats are numbered by the caller). */
export const headingSlug = (text: string) =>
  text.replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
