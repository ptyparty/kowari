import { scan } from "./tokens.ts";

export type Span = { start: number; end: number; stop: number };

export function statementSpans(text: string): Span[] {
  const { tokens, scannedTo } = scan(text);
  const spans: Span[] = [];
  let start: number | null = null;
  let end = 0;

  for (const token of tokens) {
    if (token.kind === "comment") continue;
    if (token.kind === "semicolon") {
      if (start !== null) spans.push({ start, end, stop: token.end });
      start = null;
      continue;
    }
    if (start === null) start = token.start;
    end = token.end;
  }

  const rest = text.slice(scannedTo);
  if (rest.trim() !== "") {
    const restStart = scannedTo + (rest.length - rest.trimStart().length);
    const restEnd = text.trimEnd().length;
    spans.push({ start: start ?? restStart, end: restEnd, stop: restEnd });
  } else if (start !== null) {
    spans.push({ start, end, stop: end });
  }

  return spans;
}

export function statementAt(text: string, offset: number): Span | null {
  const spans = statementSpans(text);
  if (spans.length === 0) return null;
  const containing = spans.find((s) => offset >= s.start && offset <= s.stop);
  if (containing) return containing;
  const before = spans.filter((s) => s.stop <= offset);
  return before[before.length - 1] ?? spans[0]!;
}

export function statementText(text: string, span: Span): string {
  return text.slice(span.start, span.end);
}
