export const agentLevels = ["none", "read-only", "approve-writes", "write"] as const;

export type AgentLevel = (typeof agentLevels)[number];

export const environments = ["local", "testing", "production"] as const;

export type Environment = (typeof environments)[number];

export type Definition = {
  host: string;
  port?: string;
  database?: string;
  user?: string;
  password?: string;
};

export type Grant = { agent: AgentLevel; hosts: string[] };

export type UserConfig = {
  connections: Map<string, { definition: Definition; agent: AgentLevel; environment: Environment }>;
  repos: Map<string, Map<string, Grant>>;
  localHosts: string[];
};

export type RepoConfig = { connections: Map<string, Definition> };

export type Parsed<T> = { value: T; problems: string[] };

const definitionFields = ["host", "port", "database", "user", "password"] as const;

export function parseUserConfig(text: string, source: string): Parsed<UserConfig> {
  const problems: string[] = [];
  const doc = parseToml(text, source, problems);
  const connections = new Map<string, { definition: Definition; agent: AgentLevel; environment: Environment }>();
  const repos = new Map<string, Map<string, Grant>>();

  for (const [name, raw] of tableEntries(doc.connections, `${source}: connections`, problems)) {
    const where = `${source}: connections.${name}`;
    const definition = parseDefinition(raw, where, problems, ["agent", "environment"]);
    const agent = raw.agent === undefined ? "none" : parseLevel(raw.agent, `${where}.agent`, problems);
    const environment = raw.environment === undefined ? "production" : parseEnvironment(raw.environment, `${where}.environment`, problems);
    if (definition) connections.set(name, { definition, agent, environment });
  }

  for (const [identity, raw] of tableEntries(doc.repos, `${source}: repos`, problems)) {
    const grants = new Map<string, Grant>();
    for (const [name, value] of Object.entries(raw)) {
      const grant = parseGrant(value, `${source}: repos."${identity}".${name}`, problems);
      if (grant) grants.set(name, grant);
    }
    repos.set(identity, grants);
  }

  const localHosts = parseLocalHosts(doc.local, `${source}: local`, problems);

  reportUnknownKeys(doc, ["connections", "repos", "local"], source, problems);
  return { value: { connections, repos, localHosts }, problems };
}

export function parseRepoConfig(text: string, source: string): Parsed<RepoConfig> {
  const problems: string[] = [];
  const doc = parseToml(text, source, problems);
  const connections = new Map<string, Definition>();

  for (const [name, raw] of tableEntries(doc.connections, `${source}: connections`, problems)) {
    const where = `${source}: connections.${name}`;
    if (raw.agent !== undefined) {
      problems.push(`${where}.agent is ignored: what Claude may do is set in your own config, under [repos]`);
    }
    if (raw.environment !== undefined) {
      problems.push(`${where}.environment is ignored: a repo connection is local when its host is local, and production otherwise`);
    }
    const definition = parseDefinition(raw, where, problems, ["agent", "environment"]);
    if (definition) connections.set(name, definition);
  }

  reportUnknownKeys(doc, ["connections"], source, problems);
  return { value: { connections }, problems };
}

function parseLocalHosts(value: unknown, where: string, problems: string[]): string[] {
  if (value === undefined) return [];
  if (!isTable(value)) {
    problems.push(`${where} should be a table`);
    return [];
  }
  for (const key of Object.keys(value)) {
    if (key !== "hosts") problems.push(`${where}.${key} is not a known field`);
  }
  const hosts = value.hosts ?? [];
  if (!Array.isArray(hosts) || !hosts.every((h) => typeof h === "string")) {
    problems.push(`${where}.hosts should be a list of host names`);
    return [];
  }
  return hosts.map((h) => h.toLowerCase());
}

function parseToml(text: string, source: string, problems: string[]): Record<string, unknown> {
  try {
    return Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (e) {
    problems.push(`${source}: not valid TOML (${e instanceof Error ? e.message : String(e)})`);
    return {};
  }
}

function tableEntries(value: unknown, where: string, problems: string[]): [string, Record<string, unknown>][] {
  if (value === undefined) return [];
  if (!isTable(value)) {
    problems.push(`${where} should be a table`);
    return [];
  }
  const entries: [string, Record<string, unknown>][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (isTable(entry)) entries.push([key, entry]);
    else problems.push(`${where}.${key} should be a table`);
  }
  return entries;
}

function parseDefinition(
  raw: Record<string, unknown>,
  where: string,
  problems: string[],
  otherKeys: string[],
): Definition | null {
  const definition: Partial<Definition> = {};
  for (const field of definitionFields) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value === "string" || typeof value === "number") definition[field] = String(value);
    else problems.push(`${where}.${field} should be a string`);
  }
  for (const key of Object.keys(raw)) {
    if (!(definitionFields as readonly string[]).includes(key) && !otherKeys.includes(key)) {
      problems.push(`${where}.${key} is not a known field`);
    }
  }
  if (definition.host === undefined) {
    problems.push(`${where} needs a host`);
    return null;
  }
  return { ...definition, host: definition.host };
}

function parseGrant(value: unknown, where: string, problems: string[]): Grant | null {
  if (typeof value === "string") {
    const agent = parseLevel(value, where, problems);
    return { agent, hosts: [] };
  }
  if (isTable(value)) {
    const agent = parseLevel(value.agent, `${where}.agent`, problems);
    const hosts = value.hosts ?? [];
    if (!Array.isArray(hosts) || !hosts.every((h) => typeof h === "string")) {
      problems.push(`${where}.hosts should be a list of host names`);
      return { agent, hosts: [] };
    }
    return { agent, hosts: hosts.map((h) => h.toLowerCase()) };
  }
  problems.push(`${where} should be an agent level or { agent = ..., hosts = [...] }`);
  return null;
}

function parseEnvironment(value: unknown, where: string, problems: string[]): Environment {
  if (typeof value === "string" && (environments as readonly string[]).includes(value)) return value as Environment;
  problems.push(`${where} should be one of ${environments.join(", ")}; treating it as production`);
  return "production";
}

function parseLevel(value: unknown, where: string, problems: string[]): AgentLevel {
  if (typeof value === "string" && (agentLevels as readonly string[]).includes(value)) return value as AgentLevel;
  problems.push(`${where} should be one of ${agentLevels.join(", ")}; treating it as none`);
  return "none";
}

function reportUnknownKeys(doc: Record<string, unknown>, known: string[], source: string, problems: string[]): void {
  for (const key of Object.keys(doc)) {
    if (!known.includes(key)) problems.push(`${source}: ${key} is not a known section`);
  }
}

function isTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
