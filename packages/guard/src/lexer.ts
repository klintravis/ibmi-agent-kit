// The lexer and splitter (design D2). It understands exactly what decides where a statement ends
// and what is code: string literals, "delimited" names, comments, semicolons, BEGIN ... END bodies
// and `CL:` lines. Everything else is left to the recognisers in sql.ts and cl.ts.
import type { Statement } from "./types.js";

export type TokenType = "word" | "delim" | "string" | "number" | "op" | "semi";

export interface Token {
  type: TokenType;
  value: string; // a string's or delimited name's content, unescaped; otherwise the text
  upper: string; // value upper cased (words and delimited names; others as value)
  start: number;
  end: number;
  space: boolean; // whitespace or a comment came right before it
}

export interface SqlStatement extends Statement {
  kind: "sql";
  tokens: Token[];
}

export interface ClStatement extends Statement {
  kind: "cl";
}

export type SplitStatement = SqlStatement | ClStatement;

const WORD = /[\p{L}_#$@][\p{L}\p{N}_#$@]*/uy;
const NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const CL_LINE = /[ \t]*CL:/iy;
const OPS2 = ["||", "=>", "<=", ">=", "<>", "!=", "¬=", "^="];
// END followed by one of these closes a statement that was never counted as an opener.
const END_NOT_CLOSING = new Set(["IF", "WHILE", "LOOP", "FOR", "REPEAT"]);

interface Lexed {
  items: (Token | { type: "cl"; value: string; start: number; end: number })[];
  comments: [number, number, "line" | "block"][];
  error?: { at: number; message: string };
}

// Fold a `CL:` line and its `+` continuations into one command, as CL does: the `+` goes, and the
// next line's leading blanks are skipped. Returns the command and where its last line ends.
function readClLines(text: string, from: number): { command: string; end: number } {
  let command = "";
  let p = from;
  for (;;) {
    let eol = text.indexOf("\n", p);
    if (eol < 0) eol = text.length;
    const line = text.slice(p, eol).replace(/\r$/, "").replace(/[ \t]+$/, "");
    if (line.endsWith("+") && eol < text.length) {
      command += line.slice(0, -1);
      p = eol + 1;
      while (text[p] === " " || text[p] === "\t") p++;
      continue;
    }
    command += line;
    return { command: command.trim().replace(/\s*;$/, ""), end: eol };
  }
}

function lex(text: string): Lexed {
  const out: Lexed = { items: [], comments: [] };
  let i = 0;
  let space = true;
  const push = (type: TokenType, value: string, start: number, end: number) => {
    const upper = type === "word" || type === "delim" ? value.toUpperCase() : value;
    out.items.push({ type, value, upper, start, end, space });
    space = false;
  };
  while (i < text.length) {
    if (i === 0 || text[i - 1] === "\n") {
      CL_LINE.lastIndex = i;
      const m = CL_LINE.exec(text);
      if (m) {
        const { command, end } = readClLines(text, i + m[0].length);
        out.items.push({ type: "cl", value: command, start: i, end });
        i = end;
        space = true;
        continue;
      }
    }
    const c = text[i];
    if (/\s/.test(c)) { i++; space = true; continue; }
    if (c === "-" && text[i + 1] === "-") {
      let eol = text.indexOf("\n", i);
      if (eol < 0) eol = text.length;
      out.comments.push([i, eol, "line"]);
      i = eol;
      space = true;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) { out.error = { at: i, message: "a /* comment is never closed" }; return out; }
      // Whether Db2 for i nests comments decides where a later quote falls, so refuse to guess.
      if (text.slice(i + 2, close).includes("/*")) {
        out.error = { at: i, message: "a /* comment contains another /*; remove the nested comment" };
        return out;
      }
      out.comments.push([i, close + 2, "block"]);
      i = close + 2;
      space = true;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let value = "";
      for (;;) {
        const k = text.indexOf(c, j);
        if (k < 0) {
          out.error = { at: i, message: c === "'" ? "a string literal is never closed" : "a delimited name is never closed" };
          return out;
        }
        value += text.slice(j, k);
        if (text[k + 1] === c) { value += c; j = k + 2; continue; }
        j = k + 1;
        break;
      }
      push(c === "'" ? "string" : "delim", value, i, j);
      i = j;
      continue;
    }
    WORD.lastIndex = i;
    const w = WORD.exec(text);
    if (w) { push("word", w[0], i, i + w[0].length); i += w[0].length; continue; }
    NUMBER.lastIndex = i;
    const n = NUMBER.exec(text);
    if (n) { push("number", n[0], i, i + n[0].length); i += n[0].length; continue; }
    if (c === ";") { push("semi", ";", i, i + 1); i++; continue; }
    const two = text.slice(i, i + 2);
    if (OPS2.includes(two)) { push("op", two, i, i + 2); i += 2; continue; }
    push("op", c, i, i + 1);
    i++;
  }
  return out;
}

// Where a text's '...' literals (with their unescaped content), "delimited" names and comments
// stand, as lex() reads them; nothing is marked after a lexing error. For redaction.
export function spansOf(text: string): { strings: { start: number; end: number; value: string }[]; names: [number, number][]; skips: Map<number, number>; comments: [number, number][] } {
  const lexed = lex(text);
  const strings: { start: number; end: number; value: string }[] = [];
  const names: [number, number][] = [];
  const skips = new Map<number, number>();
  const comments: [number, number][] = lexed.comments.map(([s, e]) => [s, e]);
  for (const t of lexed.items) {
    if (t.type === "cl") {
      // A CL: line is one item to the splitter; its literals and comments are read from its text.
      CL_LINE.lastIndex = t.start;
      const from = t.start + CL_LINE.exec(text)![0].length;
      const inner = spansOf(text.slice(from, t.end));
      for (const s of inner.strings) strings.push({ ...s, start: s.start + from, end: s.end + from });
      for (const [s, e] of inner.names) names.push([s + from, e + from]);
      for (const [s, e] of inner.skips) skips.set(s + from, e + from);
      for (const [s, e] of inner.comments) comments.push([s + from, e + from]);
    }
    if (t.type === "string") strings.push({ start: t.start, end: t.end, value: t.value });
    if (t.type === "delim") names.push([t.start, t.end]);
    if (t.type === "string" || t.type === "delim") skips.set(t.start, t.end);
  }
  for (const [s, e] of lexed.comments) skips.set(s, e);
  return { strings, names, skips, comments };
}

// Comments out, blank lines dropped: what a confirmation shows.
function displayOf(text: string, from: number, to: number, comments: Lexed["comments"]): string {
  let s = "";
  let p = from;
  for (const [a, b, kind] of comments) {
    if (b <= from || a >= to) continue;
    s += text.slice(p, Math.max(a, p));
    s += kind === "block" ? " " : "";
    p = Math.min(b, to);
  }
  s += text.slice(p, to);
  return s.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim()).join("\n").trim();
}

// CL comments are /* */ only; quotes are honoured. Blanks outside quotes collapse to one; a quoted
// value is kept exactly, newlines included, since it may be SQL whose -- comment ends at one.
export function stripClComments(command: string): { text: string; error?: string } {
  let s = "";
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (/\s/.test(c)) {
      if (!s.endsWith(" ")) s += " ";
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        const k = command.indexOf("'", j);
        if (k < 0) return { text: s + command.slice(i), error: "a quoted value is never closed" };
        if (command[k + 1] === "'") { j = k + 2; continue; }
        j = k + 1;
        break;
      }
      s += command.slice(i, j);
      i = j;
      continue;
    }
    // LIB/*ALL is a qualified special value, not a comment
    if (c === "/" && command[i + 1] === "*" && !(/[\w#$@]/.test(command[i - 1] ?? "") && /[A-Za-z]/.test(command[i + 2] ?? ""))) {
      const close = command.indexOf("*/", i + 2);
      if (close < 0) return { text: s, error: "a /* comment is never closed" };
      if (command.slice(i + 2, close).includes("/*")) return { text: s, error: "a /* comment contains another /*" };
      if (!s.endsWith(" ")) s += " ";
      i = close + 2;
      continue;
    }
    s += c;
    i++;
  }
  return { text: s.trim() };
}

// Split a script into SQL statements and CL commands. A lexing error ends the script: the
// statement it falls in carries the error, and nothing after it is trusted.
export function splitScript(text: string): SplitStatement[] {
  const lexed = lex(text);
  const out: SplitStatement[] = [];
  let cur: Token[] = [];
  let depth = 0;
  const flush = () => {
    if (!cur.length) return;
    const from = cur[0].start;
    const to = cur[cur.length - 1].end;
    const error = depth > 0 ? "BEGIN or CASE without its END" : undefined;
    const stmt: SqlStatement = {
      kind: "sql",
      text: text.slice(from, to).trim(),
      display: displayOf(text, from, to, lexed.comments),
      tokens: cur,
    };
    if (error) stmt.error = error;
    out.push(stmt);
    cur = [];
    depth = 0;
  };
  const items = lexed.items;
  for (let k = 0; k < items.length; k++) {
    const t = items[k];
    if (t.type === "cl") {
      flush();
      const display = stripClComments(t.value);
      const cl: ClStatement = { kind: "cl", text: t.value, display: display.text };
      if (display.error) cl.error = display.error;
      out.push(cl);
      continue;
    }
    if (t.type === "semi" && depth === 0) { flush(); continue; }
    if (t.type === "word") {
      if (t.upper === "BEGIN" || t.upper === "CASE") depth++;
      else if (t.upper === "END") {
        const next = items[k + 1];
        const nextWord = next && next.type === "word" ? next.upper : "";
        if (!END_NOT_CLOSING.has(nextWord) && depth > 0) depth--;
        // END CASE, END IF ...: the word after END closes, it does not open
        if (nextWord && (nextWord === "CASE" || END_NOT_CLOSING.has(nextWord))) { cur.push(t, next as Token); k++; continue; }
      }
    }
    cur.push(t);
  }
  if (lexed.error) {
    // the statement the error falls in runs from its first token (or the error) to the end
    const from = cur.length ? cur[0].start : lexed.error.at;
    const stmt: SqlStatement = {
      kind: "sql",
      text: text.slice(from).trim(),
      display: text.slice(from).trim(),
      tokens: cur,
      error: lexed.error.message,
    };
    out.push(stmt);
    return out;
  }
  flush();
  return out;
}
