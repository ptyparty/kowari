export type Range = { anchor: number; head: number };

export type Measure = (text: string) => number;

type CharClass = "word" | "punct" | "space" | "eol";

function classAt(text: string, i: number): CharClass {
  const c = text.codePointAt(i);
  if (c === undefined || c === 10) return "eol";
  if (c === 32 || c === 9) return "space";
  return /[\p{L}\p{N}_]/u.test(String.fromCodePoint(c)) ? "word" : "punct";
}

function boundary(text: string, i: number, j: number): boolean {
  return classAt(text, i) !== classAt(text, j);
}

export function charStart(text: string, i: number): number {
  const code = text.charCodeAt(i);
  return i > 0 && code >= 0xdc00 && code <= 0xdfff ? i - 1 : i;
}

export function nextChar(text: string, i: number): number {
  const code = text.charCodeAt(i);
  return i + (code >= 0xd800 && code <= 0xdbff ? 2 : 1);
}

export function prevChar(text: string, i: number): number {
  return i <= 0 ? 0 : charStart(text, i - 1);
}

export function nextWordStart(text: string, i: number): Range {
  if (nextChar(text, i) >= text.length) return { anchor: i, head: i };
  const after = nextChar(text, i);
  const start = boundary(text, i, after) ? after : i;
  let j = start;
  const cls = classAt(text, j);
  if (cls === "eol") {
    while (j < text.length && (classAt(text, j) === "eol" || classAt(text, j) === "space")) j = nextChar(text, j);
    return { anchor: start, head: Math.max(start, prevChar(text, j)) };
  }
  while (j < text.length && classAt(text, j) === cls) j = nextChar(text, j);
  while (j < text.length && classAt(text, j) === "space") j = nextChar(text, j);
  return { anchor: start, head: Math.max(start, prevChar(text, j)) };
}

export function nextWordEnd(text: string, i: number): Range {
  if (nextChar(text, i) >= text.length) return { anchor: i, head: i };
  const after = nextChar(text, i);
  const start = boundary(text, i, after) ? after : i;
  let j = start;
  while (j < text.length && (classAt(text, j) === "space" || classAt(text, j) === "eol")) j = nextChar(text, j);
  const cls = classAt(text, j);
  while (j < text.length && classAt(text, j) === cls) j = nextChar(text, j);
  return { anchor: start, head: Math.max(start, prevChar(text, j)) };
}

export function prevWordStart(text: string, i: number): Range {
  if (i <= 0) return { anchor: 0, head: 0 };
  const before = prevChar(text, i);
  const start = boundary(text, i, before) ? before : i;
  let j = start;
  while (j > 0 && (classAt(text, j) === "space" || classAt(text, j) === "eol")) j = prevChar(text, j);
  const cls = classAt(text, j);
  while (j > 0 && classAt(text, prevChar(text, j)) === cls) j = prevChar(text, j);
  return { anchor: start, head: j };
}

export function findChar(text: string, i: number, char: string, forward: boolean, till: boolean): Range | null {
  const at = forward ? text.indexOf(char, nextChar(text, i)) : i <= 0 ? -1 : text.lastIndexOf(char, i - 1);
  if (at < 0) return null;
  return { anchor: i, head: till ? (forward ? prevChar(text, at) : nextChar(text, at)) : at };
}

export function lineStart(text: string, i: number): number {
  return i <= 0 ? 0 : text.lastIndexOf("\n", i - 1) + 1;
}

export function lineEnd(text: string, i: number): number {
  const nl = text.indexOf("\n", i);
  return nl < 0 ? text.length : nl;
}

export function lastCharOfLine(text: string, i: number): number {
  const start = lineStart(text, i);
  const end = lineEnd(text, i);
  return end > start ? prevChar(text, end) : start;
}

export function firstNonBlank(text: string, i: number): number {
  const start = lineStart(text, i);
  const end = lineEnd(text, i);
  let j = start;
  while (j < end && (text[j] === " " || text[j] === "\t")) j += 1;
  return j < end ? j : start;
}

export function column(text: string, i: number, measure: Measure = (s) => s.length): number {
  return measure(text.slice(lineStart(text, i), i));
}

export function verticalMove(text: string, i: number, lines: number, goal: number, measure: Measure = (s) => s.length): number {
  let start = lineStart(text, i);
  for (let n = 0; n < Math.abs(lines); n++) {
    if (lines > 0) {
      const end = lineEnd(text, start);
      if (end >= text.length) break;
      start = end + 1;
    } else {
      if (start === 0) break;
      start = lineStart(text, start - 1);
    }
  }
  const last = lastCharOfLine(text, start);
  let j = start;
  while (j < last && measure(text.slice(start, nextChar(text, j))) <= goal) j = nextChar(text, j);
  return j;
}

export function selectLines(text: string, range: Range, extend: boolean): Range {
  const from = Math.min(range.anchor, range.head);
  const to = Math.max(range.anchor, range.head);
  const start = lineStart(text, from);
  if (extend) {
    const end = lineEnd(text, to);
    if (end >= text.length - 1) return { anchor: start, head: Math.max(start, text.length - 1) };
    return { anchor: start, head: Math.min(lineEnd(text, end + 1), text.length - 1) };
  }
  return { anchor: start, head: Math.min(lineEnd(text, to), Math.max(0, text.length - 1)) };
}
