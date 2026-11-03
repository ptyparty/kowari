import type { Attachment } from "../context.ts";

export type ContextSource =
  | { kind: "sql"; connection: string; sql: string }
  | { kind: "results"; connection: string; sql: string; row: number; column: string; table: string | null }
  | { kind: "table"; connection: string; table: string };

const labelSnippet = 28;

export function kowariContext(source: ContextSource): Attachment {
  const rerun = `kowari attaches no values from results; \`kowari query ${source.connection}\` runs SQL on this connection where Claude's access allows.`;
  switch (source.kind) {
    case "sql":
      return {
        label: `${source.connection} · ${snippet(source.sql)}`,
        text: `SQL in kowari on connection ${source.connection}:\n${fenced(source.sql)}\n${rerun}\n`,
      };
    case "results": {
      const where = `row ${source.row}, column "${source.column}"${source.table ? ` of ${source.table}` : ""}`;
      return {
        label: `${source.connection} · row ${source.row}, ${source.column}`,
        text: `Results in kowari on connection ${source.connection}, ${where}, from:\n${fenced(source.sql)}\n${rerun}\n`,
      };
    }
    case "table":
      return {
        label: `${source.connection} · ${source.table}`,
        text: `Table ${source.table} in kowari on connection ${source.connection}.\n${rerun}\n`,
      };
  }
}

function fenced(sql: string): string {
  const fence = "`".repeat(Math.max(3, ...[...sql.matchAll(/`+/g)].map((run) => run[0].length + 1)));
  return `${fence}sql\n${sql.trim()}\n${fence}`;
}

function snippet(sql: string): string {
  const words = sql.trim().replace(/\s+/g, " ");
  return words.length > labelSnippet ? `"${words.slice(0, labelSnippet - 1).trimEnd()}…"` : `"${words}"`;
}
