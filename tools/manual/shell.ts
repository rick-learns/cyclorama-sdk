// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Page shell for the M1 manual: a sober two-colour print look (black ink plus
// one spot red), system serif body type, no external resources of any kind.

export const TITLE = "Cyclorama Hardware & Programmer's Reference";

const CSS = `
:root{--ink:#1d1b18;--spot:#a0281c;--paper:#fbf8f1;--tint:#f4e6df;--tint2:#ece7dc;--muted:#5d5850;--rule:#1d1b18;
--serif:"Iowan Old Style","Palatino Linotype","Book Antiqua",Palatino,"URW Palladio L",Georgia,"Times New Roman",serif;
--mono:"Courier New",Courier,"Nimbus Mono PS","Liberation Mono",monospace}
*{box-sizing:border-box}
html{background:var(--paper)}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--serif);font-size:17px;line-height:1.5;-webkit-text-size-adjust:100%}
main{max-width:54rem;margin:0 auto;padding:1.5rem 16px 4rem}
a{color:var(--spot);text-decoration:none}a:hover{text-decoration:underline}
p{margin:.55em 0;hyphens:auto}
code,pre,kbd,samp,.mono{font-family:var(--mono);font-size:.92em}
pre{background:transparent;border-left:3px solid var(--spot);padding:.35em .8em;margin:.7em 0;overflow-x:auto;line-height:1.35;white-space:pre}
h2,h3,h4,h5{line-height:1.25;font-weight:700}
h2{font-size:1.65rem;margin:3.2rem 0 1rem;padding-top:.5rem;border-top:4px solid var(--spot);letter-spacing:.01em}
h2 .secno{color:var(--spot);margin-right:.5em}
h3{font-size:1.2rem;margin:2.2rem 0 .6rem;border-bottom:1px solid var(--rule);padding-bottom:.15rem}
h3 .secno,h4 .secno{color:var(--spot);margin-right:.45em;font-variant-numeric:tabular-nums}
h4{font-size:1.02rem;margin:1.6rem 0 .45rem}
h5{font-size:.95rem;margin:1.2rem 0 .3rem;font-style:italic}
.masthead{border-bottom:2px solid var(--ink);padding:.2rem 0 .4rem;margin-bottom:.6rem}
.masthead svg{display:block;width:100%;max-width:640px;height:auto}
.runhead{display:flex;justify-content:space-between;gap:1rem;font-size:.78rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--ink);padding-bottom:.2rem;margin-bottom:1.5rem;flex-wrap:wrap}
table{border-collapse:collapse;margin:.8em 0;font-size:.9rem}
.ruled,.regtable,.bits{width:100%;border-collapse:collapse;}
.ruled{width:100%;border-top:2px solid var(--rule);border-bottom:2px solid var(--rule)}
.regtable,.bits{border-top:2px solid var(--rule);border-bottom:2px solid var(--rule);margin:1em 0}.regtable th,.bits th{text-align:left;border-bottom:1px solid var(--rule);padding:.3em .5em;vertical-align:bottom}.regtable td,.bits td{padding:.28em .5em;border-top:1px solid #cfc8b8;vertical-align:top}.bits td,.bits th{text-align:center;font-family:var(--mono,monospace);font-size:.85rem}
.ruled th{text-align:left;border-bottom:1px solid var(--rule);padding:.3em .5em;font-weight:700;vertical-align:bottom}
.ruled td{padding:.28em .5em;border-top:1px solid #cfc8b8;vertical-align:top}
.ruled tbody tr:first-child td{border-top:none}
.tablewrap,.iref table.forms,.opmapwrap{overflow-x:auto;display:block;max-width:100%}
.note,.warning{margin:1em 0;padding:.5em .9em;border:1px solid var(--rule);border-left:5px solid var(--spot);background:var(--tint)}
.warning{border-left-width:9px}
figure{margin:1.2em 0}figcaption{font-size:.85rem;font-style:italic;margin-top:.3em;color:var(--muted)}
figure svg{max-width:100%;height:auto;display:block}
.toc{margin:1.5rem 0 2rem;border-top:4px solid var(--spot);padding-top:.5rem}
.toc .toc-title{font-size:1.65rem;font-weight:700;margin:.2rem 0 .6rem}
.toc ol{list-style:none;padding-left:0;margin:0}
.toc>ol>li{margin:.45em 0 0;font-weight:700}
.toc ol ol{padding-left:2.2em;font-weight:400;font-size:.93rem}
.toc .secno{display:inline-block;min-width:2.6em;color:var(--spot)}
.toc ol ol .secno{min-width:3.2em}
.titlepage{padding:1rem 0 2rem;border-bottom:2px solid var(--ink)}
.titlepage .docno{font-family:var(--mono);letter-spacing:.06em}
.titlepage h1{font-size:2.35rem;line-height:1.1;margin:2.2rem 0 .4rem;font-weight:700}
.titlepage .sub{font-size:1.15rem;font-style:italic;margin:0 0 2rem}
.boxed{border:1px solid var(--ink);padding:.6em 1em;margin:1.2em 0}
.out-of-world{margin:2rem 0;padding:.8em 1em;border:2px dashed #555;background:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:.9rem;color:#222}
.out-of-world strong:first-child{display:block;letter-spacing:.06em;text-transform:uppercase;font-size:.8rem;margin-bottom:.3em}
.iref .insn{border-top:1px solid var(--rule);margin-top:1.4rem;padding-top:.1rem}
.iref h4{margin-top:.5rem}
.iref h4 .mn{font-family:var(--mono);font-size:1.12em;color:var(--ink);margin-right:.4em}
.iref table.forms{border-top:2px solid var(--rule);border-bottom:2px solid var(--rule);width:100%}
.iref table.forms>thead th{text-align:left;font-size:.8rem;border-bottom:1px solid var(--rule);padding:.2em .45em}
.iref tr.form>td{padding:.35em .45em;vertical-align:top;border-top:1px solid #cfc8b8}
.iref td.syn code{white-space:nowrap}
.iref .fnote{font-size:.8rem;color:var(--muted)}
.iref td.cyc{white-space:nowrap}
table.enc{margin:0;font-family:var(--mono);font-size:.72rem;border:1px solid var(--rule)}
table.enc td{border:1px solid #8d877b;padding:0 .18em;text-align:center;min-width:1.2em;line-height:1.35}
table.enc tr.bn td{border:none;border-bottom:1px solid #8d877b;color:var(--muted);font-size:.62rem}
table.enc td.fv{background:var(--tint);color:var(--spot);font-style:italic}
table.enc td.fz{background:var(--tint2);color:var(--muted)}
.iref .base{font-family:var(--mono);font-size:.72rem;color:var(--muted)}
.opflags{display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap;margin:.5em 0}
.opflags pre.op{flex:1 1 18rem;margin:0}
table.flags{margin:0;font-family:var(--mono);font-size:.8rem;border:1px solid var(--rule)}
table.flags th,table.flags td{border:1px solid #8d877b;padding:.1em .5em;text-align:center}
ul.notes{margin:.3em 0 .6em;padding-left:1.2em;font-size:.93rem}
table.opmap{font-family:var(--mono);font-size:.62rem;border:2px solid var(--rule);table-layout:fixed;min-width:44rem}
table.opmap th{background:var(--ink);color:var(--paper);padding:.15em;font-weight:700}
table.opmap td{border:1px solid #8d877b;padding:.12em .15em;text-align:center;vertical-align:top;line-height:1.2;word-break:break-word}
table.opmap td b{font-weight:700}
table.opmap td small{color:var(--muted);font-size:.9em}
table.opmap td.g0,table.opmap td.g2,table.opmap td.g4,table.opmap td.g6,table.opmap td.g8,table.opmap td.gA{background:var(--tint)}
table.opmap td.res{background:repeating-linear-gradient(135deg,#fff 0 3px,#e8e3d8 3px 5px);color:var(--muted)}
figure.listing{margin:1em 0 1.4em}
table.listing{font-family:var(--mono);font-size:.8rem;width:100%;border-top:2px solid var(--rule);border-bottom:2px solid var(--rule);display:block;overflow-x:auto}
table.listing th{text-align:left;border-bottom:1px solid var(--rule);padding:.15em .5em}
table.listing td{padding:0 .5em;white-space:pre;vertical-align:top}
table.listing td.a{color:var(--spot)}
table.listing td.w{color:var(--ink);min-width:9.5em}
table.regs td:first-child,table.regs td:nth-child(2){white-space:nowrap}
dl.defs dt{font-weight:700;margin-top:.5em}dl.defs dd{margin-left:1.5em}
.bits{font-family:var(--mono)}
.endmark{margin-top:3rem;text-align:center;letter-spacing:.3em;color:var(--spot)}
.colophon{font-size:.8rem;color:var(--muted);border-top:1px solid var(--ink);margin-top:3rem;padding-top:.4rem;display:flex;justify-content:space-between;flex-wrap:wrap;gap:1rem}
@media (max-width:40rem){main table:not(.enc):not(.flags){display:block;overflow-x:auto;max-width:100%}body{font-size:16px}h2{font-size:1.35rem}.titlepage h1{font-size:1.8rem}}
@media print{html,body{background:#fff}main{max-width:none;padding:0}h2{break-before:page}.insn,figure,table.enc{break-inside:avoid}a{color:inherit}.toc a::after{content:none}}
@page{margin:18mm 16mm}
`;

/** The Avenell masthead: an original mark (a lamp throwing three beams onto a curved cyclorama) and wordmark. */
const MASTHEAD = `<svg viewBox="0 0 640 96" role="img" aria-label="Avenell Stagecraft Ltd., Home Entertainment Division">
<title>Avenell Stagecraft Ltd. — Home Entertainment Division</title>
<g fill="none" stroke-linecap="round">
<path d="M14 84 Q14 18 80 14" stroke="#1d1b18" stroke-width="5"/>
<path d="M22 84 Q22 26 80 22" stroke="#1d1b18" stroke-width="1.5"/>
<path d="M78 76 L40 40 M78 76 L56 30 M78 76 L30 58" stroke="#a0281c" stroke-width="2.5"/>
</g>
<circle cx="80" cy="78" r="7" fill="#a0281c"/>
<rect x="72" y="84" width="16" height="4" fill="#1d1b18"/>
<text x="104" y="52" font-family="Iowan Old Style,Palatino Linotype,Book Antiqua,Palatino,Georgia,serif" font-size="40" font-weight="700" letter-spacing="9" fill="#1d1b18">AVENELL</text>
<line x1="104" y1="62" x2="630" y2="62" stroke="#a0281c" stroke-width="2"/>
<text x="106" y="80" font-family="Iowan Old Style,Palatino Linotype,Book Antiqua,Palatino,Georgia,serif" font-size="12.5" letter-spacing="3.2" fill="#1d1b18">STAGECRAFT LTD. · TORONTO</text>
<text x="630" y="80" text-anchor="end" font-family="Iowan Old Style,Palatino Linotype,Book Antiqua,Palatino,Georgia,serif" font-size="12.5" font-style="italic" letter-spacing="1" fill="#a0281c">Home Entertainment Division</text>
</svg>`;

export function pageShell(body: string, toc: string): string {
  return `<!DOCTYPE html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE.replace(/&/g, "&amp;")} (HED-0041)</title>
<meta name="description" content="Avenell Cyclorama hardware and programmer's reference manual, document HED-0041.">
<style>${CSS.trim()}
</style>
</head>
<body>
<main>
<header class="masthead">${MASTHEAD}</header>
<div class="runhead"><span>HED-0041 · Cyclorama Hardware &amp; Programmer's Reference</span><span>Licensed developers only</span></div>
${body.replace("<!--TOC-->", toc)}
<div class="colophon"><span>Avenell Stagecraft Ltd. · Home Entertainment Division · Toronto, Ontario, Canada</span><span>HED-0041</span></div>
</main>
</body>
</html>
`;
}
