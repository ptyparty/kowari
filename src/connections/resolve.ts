import os from "node:os";
import path from "node:path";
import { parseRepoConfig, parseUserConfig, type AgentLevel, type Definition, type Grant, type UserConfig } from "./config.ts";
import { parseDotenv } from "./dotenv.ts";
import { interpolate } from "./interpolate.ts";
import { findWorktree, type Worktree } from "./worktree.ts";

export type ConnectionParams = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string | null;
};

export type ResolvedConnection = {
  name: string;
  source: "user" | "repo";
  agent: AgentLevel;
  agentNote: string | null;
  target: { kind: "ready"; params: ConnectionParams } | { kind: "unavailable"; reason: string };
};

export type Resolution = {
  worktree: Worktree;
  connections: ResolvedConnection[];
  problems: string[];
};

export type ResolveOptions = {
  cwd: string;
  userConfigPath?: string;
  processEnv?: Record<string, string | undefined>;
};

export const repoConfigFile = ".kowari.toml";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function defaultUserConfigPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "kowari", "connections.toml");
}

export async function resolveConnections(options: ResolveOptions): Promise<Resolution> {
  const processEnv = options.processEnv ?? process.env;
  const worktree = await findWorktree(options.cwd);
  const problems: string[] = [];

  const userPath = options.userConfigPath ?? defaultUserConfigPath(processEnv);
  const user = await readOptional(userPath, (text) => parseUserConfig(text, userPath), problems);
  const repoPath = path.join(worktree.root, repoConfigFile);
  const repo = await readOptional(repoPath, (text) => parseRepoConfig(text, repoConfigFile), problems);
  const dotenv = parseDotenv((await readText(path.join(worktree.root, ".env"))) ?? "");
  const lookup = (name: string) => dotenv.get(name) ?? processEnv[name];

  const { grants, exact } = grantsFor(user?.repos ?? new Map(), worktree);
  const localHosts = new Set([...loopbackHosts, ...worktree.composeServices, ...(user?.localHosts ?? [])]);
  const connections: ResolvedConnection[] = [];

  for (const [name, entry] of user?.connections ?? []) {
    connections.push({
      name,
      source: "user",
      agent: entry.agent,
      agentNote: null,
      target: resolveTarget(entry.definition, lookup),
    });
  }

  for (const [name, definition] of repo?.connections ?? []) {
    if (user?.connections.has(name)) {
      problems.push(`${repoConfigFile}: connection ${name} is hidden by the one with the same name in your config`);
      continue;
    }
    const target = resolveTarget(definition, lookup);
    const { agent, agentNote } = applyGrant(grants.get(name), target, localHosts);
    connections.push({ name, source: "repo", agent, agentNote, target });
  }

  for (const name of exact ? grants.keys() : []) {
    if (!repo?.connections.has(name)) {
      problems.push(`your config grants Claude access to ${name}, but ${repoConfigFile} defines no connection by that name`);
    }
  }

  return { worktree, connections, problems };
}

export function describeTarget(connection: ResolvedConnection): string {
  if (connection.target.kind === "unavailable") return `unavailable: ${connection.target.reason}`;
  const p = connection.target.params;
  return `${p.user}@${p.host}:${p.port}/${p.database} (password ${p.password === null ? "missing" : "set"})`;
}

function grantsFor(repos: UserConfig["repos"], worktree: Worktree): { grants: Map<string, Grant>; exact: boolean } {
  if (worktree.identity === null) return { grants: new Map(), exact: false };
  const exact = repos.get(worktree.identity);
  if (exact) return { grants: exact, exact: true };
  if (!worktree.identityFromRemote) return { grants: new Map(), exact: false };
  const owner = worktree.identity.slice(0, worktree.identity.lastIndexOf("/"));
  return { grants: repos.get(`${owner}/*`) ?? new Map(), exact: false };
}

function applyGrant(
  grant: Grant | undefined,
  target: ResolvedConnection["target"],
  localHosts: Set<string>,
): { agent: AgentLevel; agentNote: string | null } {
  if (!grant) return { agent: "none", agentNote: null };
  if (grant.agent !== "write" && grant.agent !== "approve-writes") return { agent: grant.agent, agentNote: null };
  if (target.kind !== "ready") return { agent: grant.agent, agentNote: null };

  const host = target.params.host.toLowerCase();
  if (localHosts.has(host) || grant.hosts.includes(host)) {
    return { agent: grant.agent, agentNote: null };
  }
  return {
    agent: "none",
    agentNote: `granted ${grant.agent}, but it points at ${host}, which is not local; list it under the grant's hosts, or [local] hosts in your config, to allow it`,
  };
}

function resolveTarget(definition: Definition, lookup: (name: string) => string | undefined): ResolvedConnection["target"] {
  const missing = new Set<string>();
  const field = (template: string | undefined): string | undefined => {
    if (template === undefined) return undefined;
    const result = interpolate(template, lookup);
    if (result.ok) return result.value;
    for (const name of result.missing) missing.add(name);
    return undefined;
  };

  const host = field(definition.host);
  const port = field(definition.port);
  const database = field(definition.database);
  const user = field(definition.user);
  const password = field(definition.password);

  if (missing.size > 0) {
    return { kind: "unavailable", reason: `${[...missing].sort().join(", ")} not set` };
  }

  const resolvedPort = Number(port ?? 5432);
  if (!Number.isInteger(resolvedPort) || resolvedPort <= 0 || resolvedPort > 65535) {
    return { kind: "unavailable", reason: "port is not a port number" };
  }

  const resolvedUser = user ?? "postgres";
  return {
    kind: "ready",
    params: {
      host: host!,
      port: resolvedPort,
      database: database ?? resolvedUser,
      user: resolvedUser,
      password: password ?? null,
    },
  };
}

async function readOptional<T>(
  file: string,
  parse: (text: string) => { value: T; problems: string[] },
  problems: string[],
): Promise<T | null> {
  const text = await readText(file);
  if (text === null) return null;
  const parsed = parse(text);
  problems.push(...parsed.problems);
  return parsed.value;
}

async function readText(file: string): Promise<string | null> {
  const f = Bun.file(file);
  return (await f.exists()) ? f.text() : null;
}
