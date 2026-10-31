import { loadModule, scanSync } from "libpg-query";

export type TokenKind = "keyword" | "identifier" | "string" | "number" | "comment" | "operator" | "parameter" | "semicolon" | "other";

export type Token = { start: number; end: number; kind: TokenKind; text: string; keyword: string };

export type Scan = { tokens: Token[]; scannedTo: number };

export const ready: Promise<void> = loadModule();

let last: { text: string; scan: Scan } | null = null;

export function scan(text: string): Scan {
  if (last?.text === text) return last.scan;
  const result = scanUncached(text);
  last = { text, scan: result };
  return result;
}

const keywordKinds = new Map<string, string>();

export function keywordKind(word: string): string {
  const cached = keywordKinds.get(word);
  if (cached !== undefined) return cached;
  const tokens = tryScan(word);
  const kind = tokens?.length === 1 ? tokens[0]!.keyword : "NO_KEYWORD";
  keywordKinds.set(word, kind);
  return kind;
}

function scanUncached(text: string): Scan {
  const whole = tryScan(text);
  if (whole) return { tokens: whole, scannedTo: text.length };

  const lineEnds = [...text.matchAll(/\n/g)].map((m) => m.index!);
  for (let i = lineEnds.length - 1; i >= 0; i--) {
    const end = lineEnds[i]!;
    const tokens = tryScan(text.slice(0, end));
    if (tokens) return { tokens, scannedTo: end };
  }
  return { tokens: [], scannedTo: 0 };
}

function tryScan(text: string): Token[] | null {
  let raw;
  try {
    raw = scanSync(text).tokens;
  } catch {
    return null;
  }
  const charAt = byteToCharOffsets(text);
  return raw.map((t) => ({
    start: charAt[t.start] ?? text.length,
    end: charAt[t.end] ?? text.length,
    kind: kindOf(t.tokenName, t.keywordName),
    text: t.text,
    keyword: t.keywordName,
  }));
}

function kindOf(tokenName: string, keywordName: string): TokenKind {
  if (tokenName === "ASCII_59") return "semicolon";
  if (keywordName !== "NO_KEYWORD") return "keyword";
  switch (tokenName) {
    case "IDENT":
      return "identifier";
    case "SCONST":
    case "USCONST":
    case "BCONST":
    case "XCONST":
      return "string";
    case "ICONST":
    case "FCONST":
      return "number";
    case "SQL_COMMENT":
    case "C_COMMENT":
      return "comment";
    case "PARAM":
      return "parameter";
    default:
      return tokenName.startsWith("ASCII_") || ["Op", "TYPECAST", "DOT_DOT", "COLON_EQUALS", "EQUALS_GREATER", "LESS_EQUALS", "GREATER_EQUALS", "NOT_EQUALS"].includes(tokenName)
        ? "operator"
        : "other";
  }
}

function byteToCharOffsets(text: string): number[] {
  const offsets: number[] = [];
  let byte = 0;
  let char = 0;
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, "utf8");
    for (let i = 0; i < size; i++) offsets[byte + i] = char;
    byte += size;
    char += codePoint.length;
  }
  offsets[byte] = char;
  return offsets;
}
