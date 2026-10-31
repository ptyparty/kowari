import postgres, { type ReservedSql, type Sql } from "postgres";
import type { ConnectionParams } from "../connections/resolve.ts";
import { gateStatement } from "./gate.ts";
import { checkAgentRole, type RoleProblem } from "./role-check.ts";

export type AgentLimits = {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  maxRows: number;
  maxBytes: number;
};

export const defaultAgentLimits: AgentLimits = {
  statementTimeoutMs: 30_000,
  lockTimeoutMs: 2_000,
  maxRows: 500,
  maxBytes: 256 * 1024,
};

export type AgentColumn = { name: string; type: number };

export type AgentResult =
  | {
      kind: "rows";
      columns: AgentColumn[];
      rows: unknown[][];
      truncated: boolean;
      command: string | null;
      count: number | null;
    }
  | { kind: "refused"; reason: string }
  | { kind: "error"; message: string };

export type ReadOnlyConnection = {
  query: (text: string) => Promise<AgentResult>;
  close: () => Promise<void>;
};

export type OpenOutcome =
  | { kind: "open"; connection: ReadOnlyConnection }
  | { kind: "refused"; problems: RoleProblem[] };

export type Layers = { gate: boolean; transaction: boolean; roleCheck: boolean };

const allLayers: Layers = { gate: true, transaction: true, roleCheck: true };

export const noLayers: Layers = { gate: false, transaction: false, roleCheck: false };

export async function openReadOnly(
  target: string | ConnectionParams,
  limits: AgentLimits = defaultAgentLimits,
  layers: Layers = allLayers,
): Promise<OpenOutcome> {
  const options = {
    max: 1,
    onnotice: () => {},
    connect_timeout: 5,
    connection: {
      application_name: "kowari-agent",
      statement_timeout: limits.statementTimeoutMs,
      lock_timeout: limits.lockTimeoutMs,
      idle_in_transaction_session_timeout: limits.statementTimeoutMs * 2,
    },
  };
  const sql =
    typeof target === "string"
      ? postgres(target, options)
      : postgres({ ...options, ...target, password: target.password ?? undefined });

  if (layers.roleCheck) {
    const problems = await checkAgentRole(sql).catch(async (e: unknown) => {
      await sql.end({ timeout: 1 });
      throw e;
    });
    if (problems.length > 0) {
      await sql.end({ timeout: 1 });
      return { kind: "refused", problems };
    }
  }

  return {
    kind: "open",
    connection: {
      query: (text) => runQuery(sql, text, limits, layers),
      close: () => sql.end({ timeout: 1 }),
    },
  };
}

async function runQuery(sql: Sql, text: string, limits: AgentLimits, layers: Layers): Promise<AgentResult> {
  if (layers.gate) {
    const verdict = await gateStatement(text);
    if (!verdict.ok) return { kind: "refused", reason: verdict.reason };
  }

  const conn = await sql.reserve();
  try {
    if (layers.transaction) {
      await conn.unsafe("begin transaction isolation level repeatable read read only", [], { simple: false });
      await conn.unsafe("select 1", [], { simple: false });
    }
    return await collectRows(sql, conn, text, limits);
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  } finally {
    if (layers.transaction) await conn.unsafe("rollback", [], { simple: false }).catch(() => {});
    conn.release();
  }
}

export type Cancellable = { cancel: () => unknown };

function asText(value: unknown): unknown {
  return value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : value;
}

export async function collectRows(
  sql: Sql,
  conn: ReservedSql,
  text: string,
  limits: Pick<AgentLimits, "maxRows" | "maxBytes">,
  onStart: (query: Cancellable) => void = () => {},
  values: "typed" | "text" = "typed",
): Promise<AgentResult> {
  const rows: unknown[][] = [];
  let columns: AgentColumn[] = [];
  let bytes = 0;
  let truncated = false;

  const pending = conn.unsafe(text, [], { simple: false });
  const query = values === "text" ? pending.raw() : pending.values();
  onStart(query);
  const result = await query.cursor(100, (page) => {
    const pageColumns = (page as unknown as { columns?: AgentColumn[] }).columns;
    if (pageColumns) columns = pageColumns.map((c) => ({ name: c.name, type: c.type }));
    for (const raw of page as unknown as unknown[][]) {
      const row = values === "text" ? raw.map(asText) : raw;
      if (Number.isFinite(limits.maxBytes)) bytes += JSON.stringify(row).length;
      if (rows.length >= limits.maxRows || bytes > limits.maxBytes) {
        truncated = true;
        return sql.CLOSE;
      }
      rows.push(row);
    }
  });

  if (columns.length === 0 && !truncated) {
    const described = await conn.unsafe(text, [], { simple: false }).describe();
    columns = (described.columns ?? []).map((c) => ({ name: c.name, type: c.type }));
  }

  const executed = result as unknown as { command?: string | null; count?: number | null } | undefined;
  return {
    kind: "rows",
    columns,
    rows,
    truncated,
    command: truncated ? null : (executed?.command ?? null),
    count: truncated ? null : (executed?.count ?? null),
  };
}
