import type { AgentResult } from "./agent/read-only.ts";

type Rows = Extract<AgentResult, { kind: "rows" }>;

const maxCellWidth = 200;

export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString("hex")}`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function jsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString("hex")}`;
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function formatRows(result: Rows): string {
  const lines: string[] = [];
  if (result.columns.length > 0) {
    const header = result.columns.map((c) => c.name);
    const cells = result.rows.map((row) => row.map((v) => cell(displayValue(v))));
    const widths = header.map((h, i) => Math.max(h.length, ...cells.map((r) => r[i]?.length ?? 0)));
    lines.push(header.map((h, i) => h.padEnd(widths[i]!)).join(" | ").trimEnd());
    lines.push(widths.map((w) => "-".repeat(w)).join("-+-"));
    for (const row of cells) lines.push(row.map((v, i) => v.padEnd(widths[i]!)).join(" | ").trimEnd());
  }
  lines.push(footer(result));
  return lines.join("\n");
}

export function rowsAsJson(result: Rows): object {
  return {
    command: result.command,
    count: result.count,
    columns: result.columns.map(({ name, type }) => ({ name, type })),
    rows: result.rows.map((row) => row.map(jsonValue)),
    truncated: result.truncated,
  };
}

function footer(result: Rows): string {
  if (result.truncated) {
    return `(first ${result.rows.length} rows; more were not fetched, so add a LIMIT or narrow the query)`;
  }
  if (result.columns.length > 0) return `(${result.rows.length} ${result.rows.length === 1 ? "row" : "rows"})`;
  return result.command ? `${result.command}${result.count !== null ? ` ${result.count}` : ""}` : "(done)";
}

function cell(text: string): string {
  const flat = text.replaceAll("\n", "\\n").replaceAll("\t", "\\t");
  return flat.length > maxCellWidth ? `${flat.slice(0, maxCellWidth - 1)}…` : flat;
}
