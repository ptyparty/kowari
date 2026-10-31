import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describeTarget, resolveConnections, type Resolution } from "./resolve.ts";
import { normalizeRemote } from "./worktree.ts";

describe("normalizeRemote", () => {
  test.each([
    ["git@github.com:exfresso/argus.git", "github.com/exfresso/argus"],
    ["https://github.com/exfresso/argus", "github.com/exfresso/argus"],
    ["https://GitHub.com/exfresso/argus.git/", "github.com/exfresso/argus"],
    ["ssh://git@github.com/exfresso/argus.git", "github.com/exfresso/argus"],
    ["git@github.com:/exfresso/merlin", "github.com/exfresso/merlin"],
  ])("%s", (remote, expected) => {
    expect(normalizeRemote(remote)).toBe(expected);
  });
});

describe("resolveConnections", () => {
  let scratch: string;
  let userConfigPath: string;

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), "kowari-resolve-"));
    userConfigPath = path.join(scratch, "config", "connections.toml");
    await mkdir(path.dirname(userConfigPath), { recursive: true });
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function repo(name: string, remote: string | null, files: Record<string, string>): Promise<string> {
    const dir = path.join(scratch, name);
    await mkdir(dir, { recursive: true });
    await run(dir, ["git", "init", "-q"]);
    if (remote) await run(dir, ["git", "remote", "add", "origin", remote]);
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), text);
    }
    return dir;
  }

  async function resolve(cwd: string, userConfig: string, processEnv: Record<string, string> = {}): Promise<Resolution> {
    await writeFile(userConfigPath, userConfig);
    return resolveConnections({ cwd, userConfigPath, processEnv });
  }

  function summary(resolution: Resolution): Record<string, string> {
    return Object.fromEntries(
      resolution.connections.map((c) => [
        c.name,
        `${c.source} ${c.agent}${c.agentNote ? ` (${c.agentNote})` : ""} ${describeTarget(c)}`,
      ]),
    );
  }

  const argusRepoFile = `
[connections.local]
host = "localhost"
port = "\${ARGUS_DB_PORT}"
database = "argus"
user = "argus"
password = "argusdev"

[connections.local-ro]
host = "localhost"
port = "\${ARGUS_DB_PORT}"
database = "argus"
user = "agent_ro"
password = "\${ARGUS_RO_PASSWORD}"
`;

  test("fills repo connections from the worktree's .env and applies grants", async () => {
    const dir = await repo("argus", "git@github.com:exfresso/argus.git", {
      ".kowari.toml": argusRepoFile,
      ".env": "ARGUS_DB_PORT=54321\nARGUS_RO_PASSWORD=s3cret\n",
      "nested/dir/.keep": "",
    });
    const resolution = await resolve(
      path.join(dir, "nested", "dir"),
      `
[connections.staging]
host = "staging.internal"
database = "argus"
user = "reader"
password = "\${STAGING_PASSWORD}"
agent = "read-only"

[repos."github.com/exfresso/argus"]
local = "approve-writes"
local-ro = "read-only"
`,
      { STAGING_PASSWORD: "from-the-shell" },
    );

    expect(resolution.worktree.identity).toBe("github.com/exfresso/argus");
    expect(summary(resolution)).toEqual({
      staging: "user read-only reader@staging.internal:5432/argus (password set)",
      local: "repo approve-writes argus@localhost:54321/argus (password set)",
      "local-ro": "repo read-only agent_ro@localhost:54321/argus (password set)",
    });
    expect(resolution.problems).toEqual([]);
  });

  test("never shows a password", async () => {
    const dir = await repo("argus-secret", "git@github.com:exfresso/argus.git", {
      ".kowari.toml": argusRepoFile,
      ".env": "ARGUS_DB_PORT=54321\nARGUS_RO_PASSWORD=s3cret\n",
    });
    const resolution = await resolve(dir, "");
    expect(JSON.stringify(summary(resolution))).not.toContain("s3cret");
  });

  test(".env wins over the process environment", async () => {
    const dir = await repo("argus-env", "git@github.com:exfresso/argus.git", {
      ".kowari.toml": argusRepoFile,
      ".env": "ARGUS_DB_PORT=1111\n",
    });
    const resolution = await resolve(dir, "", { ARGUS_DB_PORT: "2222", ARGUS_RO_PASSWORD: "x" });
    expect(summary(resolution).local).toContain("localhost:1111");
  });

  test("a connection with a missing variable is unavailable, naming it", async () => {
    const dir = await repo("argus-missing", "git@github.com:exfresso/argus.git", { ".kowari.toml": argusRepoFile });
    const resolution = await resolve(dir, "");
    expect(summary(resolution)).toEqual({
      local: "repo none unavailable: ARGUS_DB_PORT not set",
      "local-ro": "repo none unavailable: ARGUS_DB_PORT, ARGUS_RO_PASSWORD not set",
    });
  });

  test("repo connections get no agent access without a grant", async () => {
    const dir = await repo("argus-ungranted", "git@github.com:exfresso/argus.git", {
      ".kowari.toml": argusRepoFile,
      ".env": "ARGUS_DB_PORT=5\n",
    });
    const resolution = await resolve(dir, `[repos."github.com/exfresso/other"]\nlocal = "write"\n`);
    expect(resolution.connections.map((c) => c.agent)).toEqual(["none", "none"]);
  });

  test("environments: yours as declared (production when unsaid), the repo's local only on local hosts", async () => {
    const dir = await repo("envs", "git@github.com:exfresso/envs.git", {
      ".kowari.toml": `[connections.here]\nhost = "localhost"\n[connections.away]\nhost = "db.example.com"\n[connections.claims]\nhost = "db.example.com"\nenvironment = "local"\n`,
    });
    const resolution = await resolve(
      dir,
      `[connections.staging]\nhost = "s"\nenvironment = "testing"\n[connections.unsaid]\nhost = "u"\n[connections.typo]\nhost = "t"\nenvironment = "prod"\n`,
    );
    expect(Object.fromEntries(resolution.connections.map((c) => [c.name, c.environment]))).toEqual({
      staging: "testing",
      unsaid: "production",
      typo: "production",
      here: "local",
      away: "production",
      claims: "production",
    });
    expect(resolution.problems).toEqual([
      expect.stringContaining("connections.typo.environment should be one of local, testing, production"),
      ".kowari.toml: connections.claims.environment is ignored: a repo connection is local when its host is local, and production otherwise",
    ]);
  });

  test("an unavailable repo connection is local only when its host is", async () => {
    const dir = await repo("unavailable-envs", "git@github.com:exfresso/unavailable-envs.git", {
      ".kowari.toml": `[connections.here]\nhost = "localhost"\nport = "\${MISSING}"\n[connections.away]\nhost = "prod-db.example.com"\nport = "\${MISSING}"\n`,
    });
    const resolution = await resolve(dir, "");
    expect(resolution.connections.map((c) => `${c.name}=${c.environment}:${c.target.kind}`)).toEqual([
      "here=local:unavailable",
      "away=production:unavailable",
    ]);
  });

  test("an agent level in the repo file is ignored, with a warning", async () => {
    const dir = await repo("sneaky", "git@github.com:exfresso/sneaky.git", {
      ".kowari.toml": `[connections.local]\nhost = "localhost"\nagent = "write"\n`,
    });
    const resolution = await resolve(dir, "");
    expect(summary(resolution).local).toStartWith("repo none ");
    expect(resolution.problems).toEqual([
      ".kowari.toml: connections.local.agent is ignored: what Claude may do is set in your own config, under [repos]",
    ]);
  });

  test("owner wildcards grant, and an exact entry replaces the wildcard", async () => {
    const files = { ".kowari.toml": argusRepoFile, ".env": "ARGUS_DB_PORT=5\nARGUS_RO_PASSWORD=x\n" };
    const wild = await repo("wild", "https://github.com/exfresso/wild", files);
    const exact = await repo("exact", "https://github.com/exfresso/exact", files);
    const config = `
[repos."github.com/exfresso/*"]
local-ro = "read-only"

[repos."github.com/exfresso/exact"]
local = "write"
`;
    expect((await resolve(wild, config)).connections.map((c) => `${c.name}=${c.agent}`)).toEqual([
      "local=none",
      "local-ro=read-only",
    ]);
    expect((await resolve(exact, config)).connections.map((c) => `${c.name}=${c.agent}`)).toEqual([
      "local=write",
      "local-ro=none",
    ]);
  });

  test("a wildcard grant for a name this repo lacks is not reported", async () => {
    const dir = await repo("no-ro", "https://github.com/exfresso/no-ro", {
      ".kowari.toml": `[connections.local]\nhost = "localhost"\n`,
    });
    const resolution = await resolve(dir, `[repos."github.com/exfresso/*"]\nlocal-ro = "read-only"\n`);
    expect(resolution.problems).toEqual([]);
  });

  test("a bare repo's worktrees are known by the bare repo, not its parent folder", async () => {
    const bare = path.join(scratch, "bares", "app.git");
    await mkdir(bare, { recursive: true });
    await run(bare, ["git", "init", "-q", "--bare"]);
    const seed = await repo("bare-seed", null, { ".kowari.toml": "" });
    await run(seed, ["git", "add", "."]);
    await run(seed, ["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
    await run(seed, ["git", "push", "-q", bare, "HEAD:main"]);
    const linked = path.join(scratch, "bare-linked");
    await run(bare, ["git", "worktree", "add", "-q", linked, "main"]);

    const resolution = await resolve(linked, `[repos."${path.join(scratch, "bares")}"]\nlocal = "write"\n`);
    expect(resolution.worktree.identity).toBe(bare);
    expect(resolution.worktree.identityFromRemote).toBe(false);
  });

  test("write grants only hold for local hosts, compose services, or listed hosts", async () => {
    const dir = await repo("pinned", "git@github.com:exfresso/pinned.git", {
      ".kowari.toml": `
[connections.loopback]
host = "127.0.0.1"
[connections.service]
host = "pinned-db"
[connections.remote]
host = "staging.internal"
[connections.listed]
host = "db.internal"
[connections.remote-ro]
host = "staging.internal"
[connections.dotted]
host = "prod-db.example.com"
[connections.configured]
host = "shared-dev.internal"
`,
      "compose.yaml": "services:\n  pinned-db:\n    image: postgres:18.6\n  prod-db.example.com:\n    image: postgres:18.6\n",
    });
    const resolution = await resolve(
      dir,
      `
[repos."github.com/exfresso/pinned"]
loopback = "write"
service = "approve-writes"
remote = "write"
listed = { agent = "write", hosts = ["db.internal"] }
remote-ro = "read-only"
dotted = "write"
configured = "write"

[local]
hosts = ["Shared-Dev.internal"]
`,
    );
    expect(Object.fromEntries(resolution.connections.map((c) => [c.name, [c.agent, c.agentNote]]))).toEqual({
      loopback: ["write", null],
      service: ["approve-writes", null],
      remote: [
        "none",
        "granted write, but it points at staging.internal, which is not local; list it under the grant's hosts, or [local] hosts in your config, to allow it",
      ],
      listed: ["write", null],
      "remote-ro": ["read-only", null],
      dotted: [
        "none",
        "granted write, but it points at prod-db.example.com, which is not local; list it under the grant's hosts, or [local] hosts in your config, to allow it",
      ],
      configured: ["write", null],
    });
  });

  test("your config wins a name clash, and a grant for an undefined name is reported", async () => {
    const dir = await repo("clash", "git@github.com:exfresso/clash.git", {
      ".kowari.toml": `[connections.local]\nhost = "localhost"\n`,
    });
    const resolution = await resolve(
      dir,
      `
[connections.local]
host = "mine.internal"
agent = "read-only"

[repos."github.com/exfresso/clash"]
renamed = "read-only"
`,
    );
    expect(summary(resolution)).toEqual({
      local: "user read-only postgres@mine.internal:5432/postgres (password missing)",
    });
    expect(resolution.problems).toEqual([
      ".kowari.toml: connection local is hidden by the one with the same name in your config",
      "your config grants Claude access to renamed, but .kowari.toml defines no connection by that name",
    ]);
  });

  test("a repo with no origin is known by its main worktree's path", async () => {
    const dir = await repo("no-remote", null, {});
    const resolution = await resolve(dir, "");
    expect(resolution.worktree.identity).toBe(dir);
  });

  test("a linked worktree shares its main checkout's identity and reads its own .env", async () => {
    const main = await repo("main-checkout", null, { ".kowari.toml": argusRepoFile, ".env": "ARGUS_DB_PORT=1\n" });
    await run(main, ["git", "add", ".kowari.toml"]);
    await run(main, ["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
    const linked = path.join(scratch, "linked-worktree");
    await run(main, ["git", "worktree", "add", "-q", linked]);
    await writeFile(path.join(linked, ".env"), "ARGUS_DB_PORT=2\n");

    const resolution = await resolve(linked, "");
    expect(resolution.worktree.root).toBe(linked);
    expect(resolution.worktree.identity).toBe(main);
    expect(summary(resolution).local).toContain("localhost:2/");
  });

  test("bad config is reported, not thrown", async () => {
    const dir = await repo("bad", "git@github.com:exfresso/bad.git", {
      ".kowari.toml": `[connections.nohost]\nport = "5432"\n[connections.typo]\nhost = "x"\nhots = 1\n[connections.leftover]\nhost = "x"\nurl = "postgres://x"\n`,
    });
    const resolution = await resolve(dir, `[connections.weird]\nhost = "x"\nagent = "admin"\n[surprise]\n`);
    expect(resolution.problems).toEqual([
      expect.stringContaining("connections.weird.agent should be one of none, read-only, approve-writes, write"),
      expect.stringContaining("surprise is not a known section"),
      ".kowari.toml: connections.nohost needs a host",
      ".kowari.toml: connections.typo.hots is not a known field",
      ".kowari.toml: connections.leftover.url is not a known field",
    ]);
    expect(summary(resolution).weird).toStartWith("user none ");
  });
});

async function run(cwd: string, cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")}: ${await new Response(proc.stderr).text()}`);
}
