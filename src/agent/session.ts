import type { ResolvedConnection } from "../connections/resolve.ts";
import {
  defaultAgentLimits,
  noLayers,
  openReadOnly,
  type AgentLimits,
  type AgentResult,
  type ReadOnlyConnection,
} from "./read-only.ts";

export type AgentSession = { connection: ResolvedConnection; query: (text: string) => Promise<AgentResult>; close: () => Promise<void> };

export type SessionOutcome = { kind: "open"; session: AgentSession } | { kind: "refused"; reason: string };

export async function openAgentSession(
  connection: ResolvedConnection,
  limits: AgentLimits = defaultAgentLimits,
): Promise<SessionOutcome> {
  if (connection.target.kind === "unavailable") {
    return { kind: "refused", reason: `${connection.name} is unavailable: ${connection.target.reason}` };
  }
  if (connection.agent === "none") {
    const note = connection.agentNote ? ` (${connection.agentNote})` : "";
    return { kind: "refused", reason: `Claude has no access to ${connection.name}${note}` };
  }

  const params = connection.target.params;
  const layers =
    connection.agent === "read-only"
      ? undefined
      : connection.agent === "approve-writes"
        ? { gate: true, transaction: true, roleCheck: false }
        : noLayers;
  const outcome = await openReadOnly(params, limits, layers);

  if (outcome.kind === "refused") {
    const problems = outcome.problems.map((p) => `  - ${p.kind}: ${p.detail}`).join("\n");
    return {
      kind: "refused",
      reason: `${connection.name} is marked read-only, but its role ${params.user} could change the database:\n${problems}`,
    };
  }

  return {
    kind: "open",
    session: {
      connection,
      query: connection.agent === "approve-writes" ? awaitingApproval(outcome.connection) : outcome.connection.query,
      close: outcome.connection.close,
    },
  };
}

function awaitingApproval(connection: ReadOnlyConnection): (text: string) => Promise<AgentResult> {
  return async (text) => {
    const result = await connection.query(text);
    const blocked =
      result.kind === "refused"
        ? result.reason
        : result.kind === "error" && /in a read-only transaction/.test(result.message)
          ? result.message
          : null;
    if (blocked === null) return result;
    return {
      kind: "refused",
      reason: `${blocked}. Writes on this connection need approval in the kowari TUI, which does not exist yet`,
    };
  };
}
