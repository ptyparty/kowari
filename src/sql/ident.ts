import { keywordKind } from "./tokens.ts";

const needsQuotes = new Set(["RESERVED_KEYWORD", "TYPE_FUNC_NAME_KEYWORD"]);

export function quoteIdent(name: string): string {
  if (/^[a-z_][a-z0-9_$]*$/.test(name) && !needsQuotes.has(keywordKind(name))) return name;
  return `"${name.replaceAll('"', '""')}"`;
}
