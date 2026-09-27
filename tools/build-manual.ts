// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// npm run manual — assemble docs/manual/index.html from the fragments in
// docs/manual/src/*.html (filename order) inside the shared page shell.
//
//  * Generator markers are expanded:
//      <!--GEN:instruction-reference-->  <!--GEN:register-table-->  <!--GEN:opcode-map-->
//      <!--GEN:instruction-layouts-->    <!--GEN:cycle-table-->     <!--GEN:example:NN-name-->
//      <!--GEN:toc-->  (table of contents, built from the h2/h3 headings)
//  * h2/h3/h4 headings are numbered (2, 2.4, 2.4.1). Headings whose text already
//    starts with a number or "Appendix X" keep it; class="unnumbered" opts out.
//    Fragments numbered 90 and above are appendices (lettered).
//  * <a class="xref" href="#id"></a> is filled with the target's number and title.
// Output is a pure function of the inputs: same sources, byte-identical file.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderInstructionReference, renderRegisterTable, renderOpcodeMap, renderCycleTable, renderLayouts, renderExample, esc } from "./manual/generate.ts";
import { pageShell } from "./manual/shell.ts";

const ROOT = new URL("../", import.meta.url);
export const MANUAL_SRC = new URL("docs/manual/src/", ROOT);
export const EXAMPLES_DIR = new URL("docs/manual/examples/", ROOT);
export const MANUAL_OUT = new URL("docs/manual/index.html", ROOT);

const plain = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const slug = (s: string) => s.toLowerCase().replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

type Head = { level: number; id: string; num: string; title: string };

function expandMarkers(html: string, file: string): string {
  return html.replace(/<!--GEN:([a-z0-9:-]+)-->/g, (all, name: string) => {
    if (name === "toc") return "<!--TOC-->";
    if (name === "instruction-reference") return renderInstructionReference();
    if (name === "register-table") return renderRegisterTable();
    if (name === "opcode-map") return `<div class="opmapwrap">${renderOpcodeMap()}</div>`;
    if (name === "cycle-table") return renderCycleTable();
    if (name === "instruction-layouts") return renderLayouts();
    if (name.startsWith("example:")) return renderExample(name.slice(8), EXAMPLES_DIR);
    throw new Error(`${file}: unknown generator marker ${all}`);
  });
}

/** A fragment as the manual uses it: LF line ends, and without its SPDX header lines, which license
 *  the source file and stay out of the in-world page (the published copies state the licence in
 *  their page footer). */
export function fragmentSource(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/^<!-- SPDX-[^\n]*-->\n/gm, "");
}

export function buildManual(): string {
  const files = readdirSync(MANUAL_SRC).filter(f => f.endsWith(".html")).sort();
  const heads: Head[] = [];
  const titles = new Map<string, string>();
  const usedIds = new Set<string>();
  let chapter = "0", appendix = "", h3 = 0, h4 = 0;

  const parts = files.map(file => {
    const isAppendix = parseInt(file, 10) >= 90;
    let html = expandMarkers(fragmentSource(readFileSync(new URL(file, MANUAL_SRC), "utf8")), file);
    html = html.replace(/<h([234])((?:\s[^>]*)?)>([\s\S]*?)<\/h\1>/g, (_all, lv: string, attrs: string, inner: string) => {
      const level = +lv;
      const text = plain(inner);
      const unnumbered = /\bclass="[^"]*\bunnumbered\b/.test(attrs);
      // An existing number must have the shape of its level: "5" / "Appendix E", "5.1" / "E.1", "5.9.1".
      const PRE = [/^(Appendix ([A-Z])|(\d+))(?=[\s:.]|$)/, /^(()([A-Z0-9]+\.\d+))(?=\s|$)/, /^(()([A-Z0-9]+\.\d+\.\d+))(?=\s|$)/][level - 2];
      const pre = PRE.exec(text);
      let num = "";
      if (!unnumbered) {
        if (level === 2) {
          if (pre) { num = pre[1]; if (pre[2]) appendix = pre[2]; chapter = pre[2] ?? pre[3]; }
          else if (isAppendix) { appendix = appendix ? String.fromCharCode(appendix.charCodeAt(0) + 1) : "A"; chapter = appendix; num = `Appendix ${appendix}`; }
          else { chapter = String(parseInt(chapter, 10) + 1 || 1); num = chapter; }
          h3 = 0; h4 = 0;
        } else if (level === 3) {
          if (pre?.[3]) { num = pre[3]; h3 = +num.split(".").pop()!; } else num = `${chapter}.${++h3}`;
          h4 = 0;
        } else {
          if (pre?.[3]) { num = pre[3]; h4 = +num.split(".").pop()!; } else num = `${chapter}.${h3}.${++h4}`;
        }
      }
      let id = /\sid="([^"]+)"/.exec(attrs)?.[1];
      if (!id) {
        id = "sec-" + (num ? slug(num) : slug(text));
        attrs += ` id="${id}"`;
      }
      if (usedIds.has(id)) throw new Error(`${file}: duplicate heading id ${id}`);
      usedIds.add(id);
      const title = pre && num === pre[1] ? text.slice(pre[0].length).replace(/^[:.\s]+/, "") : text;
      if (num && !pre) inner = `<span class="secno">${num}</span> ${inner}`;
      else if (num && inner.startsWith(num)) inner = `<span class="secno">${num}</span>${inner.slice(num.length)}`;
      titles.set(id, num ? `${num.startsWith("Appendix") ? "" : "§"}${num} ${title}` : title);
      if (level <= 3) heads.push({ level, id, num, title });
      return `<h${lv}${attrs}>${inner}</h${lv}>`;
    });
    return `<section class="part" data-src="${esc(file)}">\n${html.trim()}\n</section>`;
  });

  let body = parts.join("\n\n");
  body = body.replace(/<a class="xref" href="#([^"]+)"><\/a>/g, (_all, id: string) => {
    const t = titles.get(id) ?? (() => { throw new Error(`cross-reference to unknown heading #${id}`); })();
    return `<a class="xref" href="#${id}">${esc(t)}</a>`;
  });

  // Table of contents: h2 entries with nested h3 entries.
  const items: string[] = [];
  let open = false;
  for (const h of heads) {
    const label = `<a href="#${h.id}">${h.num ? `<span class="secno">${esc(h.num)}</span> ` : ""}${esc(h.title)}</a>`;
    if (h.level === 2) { if (open) items.push("</ol></li>"); items.push(`<li>${label}<ol>`); open = true; }
    else items.push(`<li>${label}</li>`);
  }
  if (open) items.push("</ol></li>");
  const toc = `<nav class="toc" aria-label="Contents"><p class="toc-title">Contents</p><ol>${items.join("\n").replace(/<ol><\/ol>/g, "")}</ol></nav>`;
  if (!body.includes("<!--TOC-->")) body = "<!--TOC-->\n" + body;
  return pageShell(body, toc);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const html = buildManual();
  writeFileSync(MANUAL_OUT, html);
  console.log(`wrote ${fileURLToPath(MANUAL_OUT)} (${html.length} bytes)`);
}
