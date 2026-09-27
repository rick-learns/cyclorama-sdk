// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// SCRIM lexer (docs/scrim-spec.md §1).
// Keywords are case-insensitive (normalised to upper case in `text`); identifiers are
// case-sensitive. `ASM ... END` bodies are captured raw, line by line, as one token.

export type Pos = { file: string; line: number; col: number };

export type Token =
  | { kind: "ident"; text: string; pos: Pos }
  | { kind: "kw"; text: string; pos: Pos }
  | { kind: "int"; text: string; value: number; pos: Pos }        // decimal, $hex, %binary, 'c'
  | { kind: "fixed"; text: string; value: number; pos: Pos }      // raw 8.8 value (may be out of range)
  | { kind: "string"; text: string; bytes: number[]; pos: Pos }
  | { kind: "op"; text: string; pos: Pos }
  | { kind: "asm"; text: string; lines: { text: string; pos: Pos }[]; pos: Pos }
  | { kind: "eof"; text: string; pos: Pos };

export class CompileError extends Error {
  pos: Pos;
  constructor(pos: Pos, message: string) { super(message); this.pos = pos; }
}

export const KEYWORDS = new Set([
  "PROGRAM", "HEADER", "CONST", "VAR", "PORT", "DATA", "TYPE", "AT", "INCBIN", "INCLUDE",
  "PROC", "FUNC", "INTERRUPT", "FAR", "BANK", "VECTOR", "BEGIN", "END",
  "IF", "THEN", "ELSIF", "ELSE", "WHILE", "DO", "REPEAT", "UNTIL", "FOR", "TO", "DOWNTO", "STEP",
  "CASE", "OF", "EXIT", "RETURN", "WAIT", "ASM",
  "RECORD", "ARRAY", "POINTER", "AND", "OR", "XOR", "NOT", "MOD", "SHL", "SHR",
  "TRUE", "FALSE", "NIL", "BYTE", "WORD", "INT", "FIXED", "BOOL",
  "EXTERN", "LINK", "ASSET",
]);

const OPS = [":=", "..", "<>", "<=", ">=", ":", ";", ",", ".", "(", ")", "[", "]", "^", "@", "+", "-", "*", "/", "=", "<", ">"];
const ESC: Record<string, number> = { n: 10, "0": 0, "\\": 92, '"': 34, "'": 39 };

export function lex(src: string, file: string): Token[] {
  const out: Token[] = [];
  let i = 0, line = 1, lineStart = 0;
  const pos = (at = i): Pos => ({ file, line, col: at - lineStart + 1 });
  const fail = (p: Pos, msg: string): never => { throw new CompileError(p, msg); };
  const newline = (at: number) => { line++; lineStart = at + 1; };

  /** Decode one (possibly escaped) character inside a literal starting at j; returns [value, next]. */
  const charAt = (j: number, start: Pos): [number, number] => {
    const c = src[j];
    if (c === "\\") {
      const e = src[j + 1];
      if (e === "x" && /^[0-9A-Fa-f]{2}$/.test(src.slice(j + 2, j + 4))) return [parseInt(src.slice(j + 2, j + 4), 16), j + 4];
      if (e !== undefined && e in ESC) return [ESC[e], j + 2];
      fail(pos(j), `unknown escape sequence '\\${e ?? ""}'`);
    }
    const code = src.charCodeAt(j);
    if (code < 0x20 || code > 0x7e) fail(start, "unterminated string or character literal (strings are printable ASCII on one line)");
    return [code, j + 1];
  };

  while (i < src.length) {
    const c = src[i];
    if (c === "\n") { newline(i); i++; continue; }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") { i++; continue; }
    if (c === "-" && src[i + 1] === "-") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "(" && src[i + 1] === "*") {
      const start = pos();
      let depth = 0;
      while (i < src.length) {
        if (src[i] === "(" && src[i + 1] === "*") { depth++; i += 2; continue; }
        if (src[i] === "*" && src[i + 1] === ")") { depth--; i += 2; if (depth === 0) break; continue; }
        if (src[i] === "\n") newline(i);
        i++;
      }
      if (depth !== 0) fail(start, "unterminated comment '(*'");
      continue;
    }
    const p = pos();
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const up = word.toUpperCase();
      i = j;
      if (up === "ASM" ) { out.push(asmBody(p)); continue; }
      out.push(KEYWORDS.has(up) ? { kind: "kw", text: up, pos: p } : { kind: "ident", text: word, pos: p });
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (/[0-9]/.test(src[j] ?? "")) j++;
      if (src[j] === "." && /[0-9]/.test(src[j + 1] ?? "")) {
        const intPart = src.slice(i, j);
        let k = j + 1;
        while (/[0-9]/.test(src[k] ?? "")) k++;
        const frac = src.slice(j + 1, k);
        if (/[A-Za-z_]/.test(src[k] ?? "")) fail(p, "malformed number");
        // round(value * 256), half away from zero, computed exactly
        const num = BigInt(intPart + frac) * 256n, den = 10n ** BigInt(frac.length);
        const raw = Number((2n * num + den) / (2n * den));
        out.push({ kind: "fixed", text: src.slice(i, k), value: raw, pos: p });
        i = k;
        continue;
      }
      if (/[A-Za-z_]/.test(src[j] ?? "")) fail(p, "malformed number");
      out.push(intTok(src.slice(i, j), parseInt(src.slice(i, j), 10), p));
      i = j;
      continue;
    }
    if (c === "$" || c === "%") {
      const re = c === "$" ? /[0-9A-Fa-f]/ : /[01]/;
      let j = i + 1;
      while (j < src.length && re.test(src[j])) j++;
      if (j === i + 1 || /[A-Za-z0-9_]/.test(src[j] ?? "")) fail(p, `malformed ${c === "$" ? "hexadecimal" : "binary"} number`);
      out.push(intTok(src.slice(i, j), parseInt(src.slice(i + 1, j), c === "$" ? 16 : 2), p));
      i = j;
      continue;
    }
    if (c === "'") {
      const [v, j] = charAt(i + 1, p);
      if (src[j] !== "'") fail(p, "character literal must hold exactly one character");
      out.push({ kind: "int", text: src.slice(i, j + 1), value: v, pos: p });
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const bytes: number[] = [];
      let j = i + 1;
      for (;;) {
        if (j >= src.length || src[j] === "\n" || src[j] === "\r") fail(p, "unterminated string");
        if (src[j] === '"') break;
        const [v, n] = charAt(j, p);
        bytes.push(v);
        j = n;
      }
      out.push({ kind: "string", text: src.slice(i, j + 1), bytes, pos: p });
      i = j + 1;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) fail(p, `unexpected character '${c}'`);
    out.push({ kind: "op", text: op!, pos: p });
    i += op!.length;
  }
  out.push({ kind: "eof", text: "end of file", pos: pos() });
  return out;

  function intTok(text: string, value: number, p: Pos): Token {
    if (value > 0xffffffff) fail(p, `number ${text} does not fit in 32 bits`);
    return { kind: "int", text, value, pos: p };
  }

  /** Raw CYASM text from after ASM up to the matching END (outside comments, strings, char literals). */
  function asmBody(p: Pos): Token {
    const lines: { text: string; pos: Pos }[] = [];
    let cur = "", curPos = pos();
    let j = i;
    const flush = () => { lines.push({ text: cur, pos: curPos }); cur = ""; };
    while (j < src.length) {
      const ch = src[j];
      if (ch === "\n") { flush(); newline(j); j++; curPos = { file, line, col: 1 }; continue; }
      if (ch === ";") { while (j < src.length && src[j] !== "\n") cur += src[j++]; continue; }
      if (ch === '"' || ch === "'") {
        let k = j + 1;
        while (k < src.length && src[k] !== ch && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
        cur += src.slice(j, Math.min(k + 1, src.length));
        j = k + 1;
        continue;
      }
      if (/[A-Za-z_.]/.test(ch)) {
        let k = j + 1;
        while (k < src.length && /[\w.]/.test(src[k])) k++;
        const word = src.slice(j, k);
        if (word.toUpperCase() === "END") {
          if (cur.trim() !== "" || lines.length === 0) flush();
          i = k;
          const body = lines.filter((l) => l.text.trim() !== "");
          return { kind: "asm", text: body.map((l) => l.text).join("\n"), lines: body, pos: p };
        }
        cur += word;
        j = k;
        continue;
      }
      cur += ch;
      j++;
    }
    return fail(p, "ASM block without END");
  }
}
