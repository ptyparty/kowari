import type { AgentLevel } from "../connections/config.ts";
import { recordingFor, recordLevel, type RecordOutcome, type Recording } from "../connections/record.ts";
import { describeTarget, type ResolvedConnection } from "../connections/resolve.ts";
import type { Worktree } from "../connections/worktree.ts";
import { openAgentSession } from "./session.ts";

export type AccessAnswer =
  | { kind: "answered"; level: AgentLevel; recorded: RecordOutcome | null }
  | { kind: "unanswered"; reason: string };

export type Wants = { level: "read-only" | "write"; action: string; sql?: string };

export type AskOptions = { worktree: Worktree; wants: Wants; userConfigPath: string; env?: Record<string, string | undefined> };

const answerTimeoutSeconds = 100;
const maxSqlLines = 40;

export function shouldAskForAccess(connection: ResolvedConnection, env: Record<string, string | undefined> = process.env): boolean {
  return (
    connection.agent === "none" &&
    !connection.agentSet &&
    connection.environment === "local" &&
    connection.target.kind === "ready" &&
    komuxCommand(env) !== null
  );
}

export async function askForAccess(connection: ResolvedConnection, options: AskOptions): Promise<AccessAnswer> {
  const env = options.env ?? process.env;
  const komux = komuxCommand(env);
  if (komux === null) return { kind: "unanswered", reason: "komux is not available" };

  const [role, recording] = await Promise.all([checkRole(connection), recordingFor(connection, options.worktree, options.userConfigPath)]);
  const result = await runAsk(komux, formSpec(connection, options, role, recording), env);
  if (result.kind !== "answered") return result;

  const level = result.values.level as AgentLevel;
  const recorded = recording.kind === "possible" && result.values.record === true ? await recordLevel(options.userConfigPath, recording.target, level) : null;
  return { kind: "answered", level, recorded };
}

function komuxCommand(env: Record<string, string | undefined>): string | null {
  if (!env.KOMUX_SOCKET) return null;
  return Bun.which("komux", { PATH: env.PATH ?? "" });
}

type RoleCheck = { kind: "reads only" } | { kind: "can write"; user: string } | { kind: "unchecked"; reason: string };

async function checkRole(connection: ResolvedConnection): Promise<RoleCheck> {
  if (connection.target.kind !== "ready") return { kind: "unchecked", reason: connection.target.reason };
  const user = connection.target.params.user;
  try {
    const outcome = await openAgentSession({ ...connection, agent: "read-only" });
    if (outcome.kind === "open") {
      await outcome.session.close();
      return { kind: "reads only" };
    }
    return outcome.writableRole ? { kind: "can write", user } : { kind: "unchecked", reason: outcome.reason };
  } catch (e) {
    return { kind: "unchecked", reason: e instanceof Error ? e.message : String(e) };
  }
}

function formSpec(connection: ResolvedConnection, options: AskOptions, role: RoleCheck, recording: Recording): unknown {
  const { worktree, wants } = options;
  const levels = [
    { value: "none", label: "No access" },
    ...(role.kind === "can write" ? [] : [{ value: "read-only", label: "Read-only", description: "one read per call, in a transaction that always rolls back" }]),
    { value: "write", label: "Write", description: "statements run as sent" },
  ];
  const suggested = levels.some((l) => l.value === wants.level) ? wants.level : "none";
  return {
    title: `Let Claude use ${connection.name}?`,
    description: `${describeTarget(connection)} in ${worktree.identity ?? worktree.root}. Your kowari config doesn't say what Claude may do with it.`,
    elements: [
      { type: "note", text: [`Claude wants to ${wants.action}${wants.sql ? ":" : "."}`, ...(wants.sql ? quoteSql(wants.sql) : [])].join("\n") },
      ...roleNotes(role),
      { type: "choice", id: "level", label: "What may Claude do?", options: levels, default: suggested },
      ...(recording.kind === "possible"
        ? [{ type: "confirm", id: "record", label: "Record it in your kowari config, so kowari stops asking?", default: false }]
        : [{ type: "note", text: `This answer holds for this request only: ${recording.why}.` }]),
    ],
  };
}

function roleNotes(role: RoleCheck): unknown[] {
  if (role.kind === "can write") {
    return [{ type: "note", text: `Read-only isn't available because this connection logs in as ${role.user}, which can make changes to the database. To allow read-only, connect as a user that can only read.` }];
  }
  if (role.kind === "unchecked") {
    return [{ type: "note", text: `kowari couldn't check whether this connection's user can write (${oneLine(role.reason)}), so Claude's command may still fail.` }];
  }
  return [];
}

function quoteSql(sql: string): string[] {
  const lines = sql.trim().split("\n").map((line) => `  ${line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "�")}`);
  return lines.length > maxSqlLines ? [...lines.slice(0, maxSqlLines), `  … and ${lines.length - maxSqlLines} more lines. Claude's statement is long; pick no access if you can't read it all.`] : lines;
}

export function oneLine(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
}

async function runAsk(
  komux: string,
  spec: unknown,
  env: Record<string, string | undefined>,
): Promise<{ kind: "answered"; values: Record<string, unknown> } | { kind: "unanswered"; reason: string }> {
  const proc = Bun.spawn([komux, "ask", "-", "--wait", "--timeout", String(answerTimeoutSeconds)], {
    env,
    stdin: new Blob([JSON.stringify(spec)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) return { kind: "unanswered", reason: `komux could not ask the user: ${err.trim() || "no reason given"}` };

  let result: { status?: string; values?: Record<string, unknown> };
  try {
    result = JSON.parse(out);
  } catch {
    return { kind: "unanswered", reason: "komux gave an answer kowari could not read" };
  }
  if (result.status === "cancelled") return { kind: "unanswered", reason: "the user closed the question without answering" };
  if (result.status === "pending") return { kind: "unanswered", reason: `the user did not answer within ${answerTimeoutSeconds} seconds` };
  const level = result.values?.level;
  if (result.status !== "submitted" || !["none", "read-only", "write"].includes(level as string)) {
    return { kind: "unanswered", reason: "komux gave an answer kowari could not read" };
  }
  return { kind: "answered", values: result.values! };
}
