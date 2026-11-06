import { keyringKey, systemKeyring, type Keyring } from "../connections/keyring.ts";
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

export type SessionOutcome = { kind: "open"; session: AgentSession } | { kind: "refused"; reason: string; writableRole?: true };

export async function openAgentSession(
  connection: ResolvedConnection,
  limits: AgentLimits = defaultAgentLimits,
  keyring: Keyring = systemKeyring,
): Promise<SessionOutcome> {
  if (connection.target.kind === "unavailable") {
    return { kind: "refused", reason: `${connection.name} is unavailable: ${connection.target.reason}` };
  }
  if (connection.agent === "none") {
    const note = connection.agentNote ? ` (${connection.agentNote})` : "";
    return { kind: "refused", reason: `Claude has no access to ${connection.name}${note}` };
  }

  const params = { ...connection.target.params };
  if (params.password === null) {
    const stored = await keyring.get(keyringKey(params));
    if (stored === null) return { kind: "refused", reason: await missingPassword(connection.name, keyring) };
    params.password = stored;
  }
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
      writableRole: true,
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

async function missingPassword(name: string, keyring: Keyring): Promise<string> {
  switch (await keyring.state()) {
    case "locked":
      return `no password for ${name}: the keyring is locked; unlock it (see the kowari notebook's password page) and try again`;
    case "unavailable":
      return `no password for ${name}: no keyring is running, and the connection has no password in its config`;
    case "unlocked":
      return `no password for ${name}: connect once from the kowari TUI to store one in the keyring`;
  }
}
