import type { Catalog, CatalogColumn, CatalogTable } from "./catalog.ts";
import { quoteIdent } from "./ident.ts";
import { statementAt } from "./statements.ts";
import { scan, type Token } from "./tokens.ts";

export type CompletionKind = "column" | "table" | "view" | "schema" | "alias" | "function" | "keyword";

export type Completion = { label: string; insert: string; kind: CompletionKind; detail: string };

export type CompletionResult = { from: number; to: number; word: string; items: Completion[] };

const keywords = [
  "select", "from", "where", "and", "or", "not", "in", "is", "null", "like", "ilike", "between", "exists",
  "join", "inner", "left", "right", "full", "outer", "cross", "lateral", "on", "using",
  "group by", "order by", "having", "limit", "offset", "distinct", "as", "asc", "desc", "nulls first", "nulls last",
  "union", "union all", "intersect", "except", "with", "recursive",
  "case", "when", "then", "else", "end", "cast", "true", "false",
  "insert into", "values", "returning", "update", "set", "delete from", "on conflict", "do nothing", "do update set",
  "begin", "commit", "rollback", "explain", "analyze", "interval",
];

const kindOrder: Record<CompletionKind, number> = { alias: 0, column: 1, table: 2, view: 2, schema: 3, function: 4, keyword: 5 };

const maxItems = 50;

export function complete(text: string, cursor: number, catalog: Catalog): CompletionResult | null {
  const full = scan(text);
  const before = tokensBefore(text, cursor, full);
  if (before === null || insideToken(before, cursor)) return null;

  const wordStart = cursor - (/[A-Za-z0-9_$]*$/.exec(text.slice(0, cursor))?.[0].length ?? 0);
  const word = text.slice(wordStart, cursor);
  if (/^[0-9$]/.test(word)) return null;
  const qualifier = text[wordStart - 1] === "." ? qualifierBefore(text, wordStart - 1) : null;
  const nameStart = qualifier === null ? wordStart : wordStart - 1 - qualifier.length;
  const tablePosition = isTablePosition(before, nameStart);

  const span = statementAt(text, cursor, full);
  const statementTokens = full.tokens.filter((t) => !span || (t.start >= span.start && t.end <= Math.max(span.stop, cursor)));
  const scope = tablesInScope(statementTokens, catalog);

  let items: Completion[];
  if (qualifier !== null) {
    items = qualifiedCandidates(qualifier, tablePosition, scope, catalog);
  } else if (tablePosition) {
    items = tableCandidates(catalog);
  } else {
    items = [...scopeCandidates(scope, catalog), ...functionCandidates(catalog), ...keywordCandidates()];
  }

  return { from: wordStart, to: cursor, word, items: rank(items, word) };
}

export function matchesPrefix(item: Completion, word: string): boolean {
  const needle = word.toLowerCase();
  const label = item.label.toLowerCase();
  const bare = label.includes(".") ? label.slice(label.lastIndexOf(".") + 1) : label;
  return bare.startsWith(needle) || label.startsWith(needle);
}

function tokensBefore(text: string, cursor: number, full: ReturnType<typeof scan>): Token[] | null {
  if (full.scannedTo >= cursor) return full.tokens.filter((t) => t.start < cursor);
  const before = text.slice(0, cursor);
  const partial = scan(before);
  return partial.scannedTo < before.trimEnd().length ? null : partial.tokens;
}

type ScopeEntry = { table: CatalogTable; alias: string | null };

function tablesInScope(tokens: Token[], catalog: Catalog): ScopeEntry[] {
  const scope: ScopeEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const keyword = tokens[i]!.kind === "keyword" ? tokens[i]!.text.toLowerCase() : null;
    if (keyword === null || !["from", "join", "update", "into"].includes(keyword)) continue;
    let j = i + 1;
    for (;;) {
      const name = readQualifiedName(tokens, j);
      if (!name) break;
      j = name.next;
      if (tokens[j]?.kind === "keyword" && tokens[j]!.text.toLowerCase() === "as") j += 1;
      let alias: string | null = null;
      if (tokens[j]?.kind === "identifier") {
        alias = unquote(tokens[j]!.text);
        j += 1;
      }
      const table = findTable(catalog, name.schema, name.name);
      if (table) scope.push({ table, alias });
      if (keyword === "from" && tokens[j]?.text === ",") {
        j += 1;
        continue;
      }
      break;
    }
  }
  return scope;
}

function readQualifiedName(tokens: Token[], start: number): { schema: string | null; name: string; next: number } | null {
  const first = tokens[start];
  if (!first || !isName(first)) return null;
  if (tokens[start + 1]?.text === "." && tokens[start + 2] && isName(tokens[start + 2]!)) {
    return { schema: unquote(first.text), name: unquote(tokens[start + 2]!.text), next: start + 3 };
  }
  return { schema: null, name: unquote(first.text), next: start + 1 };
}

function isName(token: Token): boolean {
  if (token.kind === "identifier") return true;
  return token.kind === "keyword" && token.keyword !== "RESERVED_KEYWORD" && /^[a-z_][a-z0-9_]*$/i.test(token.text);
}

function findTable(catalog: Catalog, schema: string | null, name: string): CatalogTable | null {
  const matches = catalog.tables.filter((t) => sameName(t.name, name) && (schema === null || sameName(t.schema, schema)));
  if (schema !== null) return matches[0] ?? null;
  for (const s of catalog.searchPath) {
    const found = matches.find((t) => t.schema === s);
    if (found) return found;
  }
  return null;
}

function qualifiedCandidates(qualifier: string, tablePosition: boolean, scope: ScopeEntry[], catalog: Catalog): Completion[] {
  const schema = catalog.schemas.find((s) => sameName(s, qualifier));
  if (tablePosition) return schema ? schemaContents(schema, catalog) : [];

  const entry =
    scope.find((e) => e.alias !== null && sameName(e.alias, qualifier)) ??
    scope.find((e) => sameName(e.table.name, qualifier)) ??
    tableEntry(findTable(catalog, null, qualifier));
  if (entry) return columnsOf(entry.table, catalog);
  return schema ? schemaContents(schema, catalog) : [];
}

function tableEntry(table: CatalogTable | null): ScopeEntry | null {
  return table ? { table, alias: null } : null;
}

function schemaContents(schema: string, catalog: Catalog): Completion[] {
  return [
    ...catalog.tables.filter((t) => t.schema === schema).map((t) => tableCompletion(t, false)),
    ...catalog.functions.filter((f) => f.schema === schema).map((f) => ({ label: f.name, insert: `${quoteIdent(f.name)}(`, kind: "function" as const, detail: `(${f.args}) → ${f.result}` })),
  ];
}

function tableCandidates(catalog: Catalog): Completion[] {
  const visible = new Set(catalog.searchPath);
  return [
    ...catalog.tables.map((t) => tableCompletion(t, !visible.has(t.schema))),
    ...catalog.schemas.filter((s) => !visible.has(s) && s !== "pg_catalog").map((s) => ({ label: s, insert: `${quoteIdent(s)}.`, kind: "schema" as const, detail: "schema" })),
  ];
}

function scopeCandidates(scope: ScopeEntry[], catalog: Catalog): Completion[] {
  const items: Completion[] = [];
  for (const entry of scope) {
    if (entry.alias) items.push({ label: entry.alias, insert: quoteIdent(entry.alias), kind: "alias", detail: `${entry.table.schema}.${entry.table.name}` });
    items.push(...columnsOf(entry.table, catalog).map((c) => (scope.length > 1 ? { ...c, detail: `${c.detail} · ${entry.alias ?? entry.table.name}` } : c)));
  }
  return items;
}

const columnIndexes = new WeakMap<Catalog, Map<string, CatalogColumn[]>>();

function columnsOf(table: CatalogTable, catalog: Catalog): Completion[] {
  let index = columnIndexes.get(catalog);
  if (!index) {
    index = new Map();
    for (const c of catalog.columns) {
      const key = `${c.schema}.${c.table}`;
      const list = index.get(key);
      if (list) list.push(c);
      else index.set(key, [c]);
    }
    columnIndexes.set(catalog, index);
  }
  return (index.get(`${table.schema}.${table.name}`) ?? []).map((c) => ({ label: c.name, insert: quoteIdent(c.name), kind: "column" as const, detail: c.type }));
}

function functionCandidates(catalog: Catalog): Completion[] {
  return catalog.functions.map((f) => ({ label: f.name, insert: `${quoteIdent(f.name)}(`, kind: "function" as const, detail: `(${f.args}) → ${f.result}` }));
}

function keywordCandidates(): Completion[] {
  return keywords.map((k) => ({ label: k, insert: k, kind: "keyword" as const, detail: "" }));
}

function tableCompletion(t: CatalogTable, qualify: boolean): Completion {
  const name = quoteIdent(t.name);
  return { label: qualify ? `${t.schema}.${t.name}` : t.name, insert: qualify ? `${quoteIdent(t.schema)}.${name}` : name, kind: t.kind === "table" ? "table" : "view", detail: t.kind };
}

function rank(items: Completion[], word: string): Completion[] {
  const needle = word.toLowerCase();
  const seen = new Set<string>();
  const scored: { item: Completion; score: number }[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const score = needle === "" || matchesPrefix(item, word) ? 0 : item.kind !== "keyword" && item.label.toLowerCase().includes(needle) ? 1 : -1;
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      kindOrder[a.item.kind] - kindOrder[b.item.kind] ||
      a.item.label.length - b.item.label.length ||
      a.item.label.localeCompare(b.item.label),
  );
  return scored.slice(0, maxItems).map((s) => s.item);
}

function insideToken(tokens: Token[], cursor: number): boolean {
  return tokens.some((t) => (t.kind === "string" || t.kind === "comment") && t.start < cursor && (cursor < t.end || (t.kind === "comment" && t.text.startsWith("--") && cursor === t.end)));
}

function isTablePosition(tokens: Token[], before: number): boolean {
  const earlier = tokens.filter((t) => t.end <= before && t.kind !== "comment");
  const last = earlier.length - 1;
  const previous = earlier[last];
  if (!previous) return false;
  if (previous.text === ",") {
    const clause = findLastIndex(earlier, (t) => t.kind === "keyword" && ["select", "from", "where", "by", "set", "values", "on", "having", "returning"].includes(t.text.toLowerCase()));
    return clause >= 0 && earlier[clause]!.text.toLowerCase() === "from" && opensFromClause(earlier, clause);
  }
  if (previous.kind !== "keyword") return false;
  switch (previous.text.toLowerCase()) {
    case "from":
      return opensFromClause(earlier, last);
    case "join":
    case "into":
    case "table":
      return true;
    case "update":
      return !["for", "key"].includes(earlier[last - 1]?.text.toLowerCase() ?? "");
    default:
      return false;
  }
}

function opensFromClause(tokens: Token[], from: number): boolean {
  if (tokens[from - 1]?.text.toLowerCase() === "distinct") return false;
  let depth = 0;
  for (let i = from - 1; i >= 0; i--) {
    const text = tokens[i]!.text;
    if (text === ")") depth += 1;
    else if (text === "(") {
      if (depth === 0) return ["select", "with", "delete"].includes(tokens[i + 1]?.text.toLowerCase() ?? "");
      depth -= 1;
    }
  }
  return true;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i]!)) return i;
  return -1;
}

function qualifierBefore(text: string, dot: number): string {
  const quoted = /"((?:[^"]|"")*)"$/.exec(text.slice(0, dot));
  if (quoted) return quoted[1]!.replaceAll('""', '"');
  return /[A-Za-z0-9_$]*$/.exec(text.slice(0, dot))?.[0] ?? "";
}

function unquote(name: string): string {
  return name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name.toLowerCase();
}

function sameName(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase();
}
