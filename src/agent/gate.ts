import { parse } from "libpg-query";

export type GateVerdict = { ok: true } | { ok: false; reason: string };

const allowedTopLevel = new Set(["SelectStmt", "ExplainStmt", "VariableShowStmt"]);

const writingNodes = new Set(["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"]);

const deniedFunctionPrefixes = [
  "dblink",
  "lo_",
  "pg_advisory",
  "pg_try_advisory",
  "pg_read_",
  "pg_ls_",
  "pg_stat_file",
  "pg_file_",
  "pg_logical_",
  "pg_replication_",
  "pg_create_",
  "pg_drop_",
  "pg_sleep",
];

const deniedFunctions = new Set([
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_switch_wal",
  "pg_promote",
  "pg_notify",
  "set_config",
  "nextval",
  "setval",
  "loread",
  "lowrite",
  "query_to_xml",
  "query_to_xmlschema",
  "query_to_xml_and_xmlschema",
  "cursor_to_xml",
  "cursor_to_xmlschema",
]);

export async function gateStatement(text: string): Promise<GateVerdict> {
  let stmts: unknown[];
  try {
    stmts = (await parse(text)).stmts ?? [];
  } catch (e) {
    return refuse(`does not parse: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (stmts.length !== 1) {
    return refuse(`expected exactly one statement, got ${stmts.length}`);
  }

  const stmt = (stmts[0] as { stmt?: Record<string, unknown> }).stmt ?? {};
  const kind = Object.keys(stmt)[0] ?? "empty";
  if (!allowedTopLevel.has(kind)) {
    return refuse(`${describeKind(kind)} is not allowed on a read-only connection`);
  }

  if (kind === "ExplainStmt") {
    const explained = Object.keys(((stmt.ExplainStmt as Record<string, unknown>).query as object) ?? {})[0] ?? "empty";
    if (explained !== "SelectStmt") {
      return refuse(`EXPLAIN of ${describeKind(explained)} is not allowed on a read-only connection`);
    }
  }

  return findProblem(stmt) ?? { ok: true };
}

function findProblem(node: unknown): GateVerdict | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const problem = findProblem(child);
      if (problem) return problem;
    }
    return null;
  }

  if (node === null || typeof node !== "object") return null;

  for (const [key, value] of Object.entries(node)) {
    if (writingNodes.has(key)) {
      return refuse(`${describeKind(key)} is not allowed on a read-only connection`);
    }
    if (key === "SelectStmt" && isRecord(value) && value.intoClause) {
      return refuse("SELECT INTO creates a table and is not allowed on a read-only connection");
    }
    if (key === "SelectStmt" && isRecord(value) && value.lockingClause) {
      return refuse("row locking (FOR UPDATE / FOR SHARE) is not allowed on a read-only connection");
    }
    if (key === "FuncCall" && isRecord(value)) {
      const name = functionName(value);
      if (name && isDeniedFunction(name)) {
        return refuse(`${name}() is not allowed on a read-only connection`);
      }
    }
    const problem = findProblem(value);
    if (problem) return problem;
  }

  return null;
}

function functionName(funcCall: Record<string, unknown>): string | null {
  const parts = funcCall.funcname;
  if (!Array.isArray(parts)) return null;
  const last = parts[parts.length - 1] as { String?: { sval?: string } } | undefined;
  return last?.String?.sval?.toLowerCase() ?? null;
}

function isDeniedFunction(name: string): boolean {
  return deniedFunctions.has(name) || deniedFunctionPrefixes.some((prefix) => name.startsWith(prefix));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeKind(kind: string): string {
  return kind.replace(/Stmt$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();
}

function refuse(reason: string): GateVerdict {
  return { ok: false, reason };
}
