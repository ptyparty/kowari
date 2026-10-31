import { openReadOnly, type AgentLimits, type AgentResult, type Layers } from "../src/agent/read-only.ts";
import { adminUrl, makeFixture, type FixtureDatabase } from "../test/escape/fixture.ts";
import { vectors, type Vector } from "../test/escape/vectors.ts";

const limits: AgentLimits = { statementTimeoutMs: 2_000, lockTimeoutMs: 500, maxRows: 50, maxBytes: 64 * 1024 };
const adminPassword = new URL(adminUrl).password;

type Column = { label: string; layers: Layers; asAgent: boolean; hardened: boolean };

const columns: Column[] = [
  { label: "nothing (owner)", layers: { gate: false, transaction: false, roleCheck: false }, asAgent: false, hardened: false },
  { label: "1 parse gate", layers: { gate: true, transaction: false, roleCheck: false }, asAgent: false, hardened: false },
  { label: "2 read-only txn", layers: { gate: false, transaction: true, roleCheck: false }, asAgent: false, hardened: false },
  { label: "4 agent role", layers: { gate: false, transaction: false, roleCheck: false }, asAgent: true, hardened: false },
  { label: "all, remote access revoked", layers: { gate: true, transaction: true, roleCheck: true }, asAgent: true, hardened: true },
];

const fixture = await makeFixture();

try {
  console.log(`| Vector | ${columns.map((c) => c.label).join(" | ")} |`);
  console.log(`|---|${columns.map(() => "---").join("|")}|`);
  for (const vector of vectors) {
    const cells: string[] = [];
    for (const column of columns) cells.push(await runCell(vector, column));
    console.log(`| ${vector.name} | ${cells.join(" | ")} |`);
  }
} finally {
  await fixture.teardown();
}

async function runCell(vector: Vector, column: Column): Promise<string> {
  const db = await fixture.freshDatabase(column.hardened ? { revokeDblink: true, revokeRemoteDefiner: true } : {});
  try {
    const before = await db.snapshot();
    const outcome = await openReadOnly(column.asAgent ? db.agentUrl : db.adminUrl, limits, column.layers);
    if (outcome.kind === "refused") return "refused at connect";
    const result = await withSimpleFallback(outcome.connection.query, vector, db, column);
    await outcome.connection.close();
    const after = await db.snapshot();
    return after === before ? blocked(result) : `**CHANGED** ${diff(before, after)}`;
  } finally {
    await db.drop();
  }
}

async function withSimpleFallback(
  query: (text: string) => Promise<AgentResult>,
  vector: Vector,
  db: FixtureDatabase,
  column: Column,
): Promise<AgentResult> {
  const text = vector.sql({ database: db.name, canaryPid: db.canaryPid, adminPassword });
  if (column.layers.gate || column.layers.transaction) return query(text);
  const postgres = (await import("postgres")).default;
  const raw = postgres(column.asAgent ? db.agentUrl : db.adminUrl, {
    max: 1,
    onnotice: () => {},
    connection: { statement_timeout: limits.statementTimeoutMs },
  });
  try {
    await raw.unsafe(text).simple();
    return { kind: "rows", columns: [], rows: [], truncated: false, command: null, count: null };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  } finally {
    await raw.end({ timeout: 1 });
  }
}

function blocked(result: AgentResult): string {
  if (result.kind === "refused") return `refused: ${short(result.reason)}`;
  if (result.kind === "error") return `error: ${short(result.message)}`;
  return "ran, no change";
}

function short(text: string): string {
  const line = text.split("\n")[0]!.replaceAll("|", "/");
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

function diff(before: string, after: string): string {
  const a = JSON.parse(before) as Record<string, unknown>;
  const b = JSON.parse(after) as Record<string, unknown>;
  return Object.keys(b)
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .join(", ");
}
