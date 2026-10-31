import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { adminUrl, makeFixture, type Fixture, type FixtureDatabase } from "./escape/fixture.ts";

const cli = path.join(import.meta.dir, "..", "src", "cli.ts");

let fixture: Fixture;
let db: FixtureDatabase;
let scratch: string;
let worktree: string;
let configHome: string;

beforeAll(async () => {
  fixture = await makeFixture();
  db = await fixture.freshDatabase({ revokeDblink: true, revokeRemoteDefiner: true });
  scratch = await mkdtemp(path.join(os.tmpdir(), "kowari-cli-"));
  worktree = path.join(scratch, "app");
  configHome = path.join(scratch, "config");
  await mkdir(worktree, { recursive: true });
  await mkdir(path.join(configHome, "kowari"), { recursive: true });
  await run(["git", "init", "-q"], worktree);
  await run(["git", "remote", "add", "origin", "git@github.com:example/app.git"], worktree);

  const admin = new URL(adminUrl);
  const owner = { user: admin.username, password: admin.password };
  const section = (name: string, user: string, password: string) =>
    `[connections.${name}]\nhost = "127.0.0.1"\nport = "\${APP_DB_PORT}"\ndatabase = "${db.name}"\nuser = "${user}"\npassword = "${password}"\n`;

  await writeFile(
    path.join(worktree, ".kowari.toml"),
    [
      section("local", owner.user, owner.password),
      section("local-approve", owner.user, owner.password),
      section("local-ro", fixture.role, "${APP_RO_PASSWORD}"),
      section("owner-as-ro", owner.user, owner.password),
      section("ungranted", owner.user, owner.password),
    ].join("\n"),
  );
  await writeFile(path.join(worktree, ".env"), `APP_DB_PORT=${admin.port}\nAPP_RO_PASSWORD=${fixture.password}\n`);
  await writeFile(
    path.join(configHome, "kowari", "connections.toml"),
    `[repos."github.com/example/app"]\nlocal = "write"\nlocal-approve = "approve-writes"\nlocal-ro = "read-only"\nowner-as-ro = "read-only"\n`,
  );
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
  await fixture?.teardown();
});

async function kowari(args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", cli, ...args], {
    cwd: worktree,
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out.trimEnd(), err: err.trimEnd() };
}

describe("kowari CLI", () => {
  test("lists connections with their agent levels and no passwords", async () => {
    const r = await kowari(["connections"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("local-ro  [read-only]");
    expect(r.out).toContain("ungranted  [none]");
    expect(r.out).not.toContain(fixture.password);
  });

  test("queries a read-only connection, as text and as JSON", async () => {
    const text = await kowari(["query", "local-ro", "select id, v from victim order by id"]);
    expect(text).toEqual({
      code: 0,
      out: "id | v\n---+------\n1  | one\n2  | two\n3  | three\n(3 rows)",
      err: "",
    });

    const json = await kowari(["query", "local-ro", "--json", "-"], "select id from victim where id = 2");
    expect(JSON.parse(json.out)).toEqual({
      command: "SELECT",
      count: 1,
      columns: [{ name: "id", type: 23 }],
      rows: [[2]],
      truncated: false,
    });
  });

  test("shows column names for an empty result", async () => {
    const r = await kowari(["query", "local-ro", "select id, v from victim where false"]);
    expect(r.out).toBe("id | v\n---+--\n(0 rows)");
  });

  test("caps rows", async () => {
    const r = await kowari(["query", "local-ro", "--max-rows", "2", "select g from generate_series(1, 10) g"]);
    expect(r.out).toEndWith("(first 2 rows; more were not fetched, so add a LIMIT or narrow the query)");
  });

  test("refuses a write on a read-only connection", async () => {
    const r = await kowari(["query", "local-ro", "delete from victim"]);
    expect(r).toEqual({ code: 1, out: "", err: "kowari: refused: DELETE is not allowed on a read-only connection" });
  });

  test("refuses a connection Claude was not granted", async () => {
    const r = await kowari(["query", "ungranted", "select 1"]);
    expect(r).toEqual({ code: 1, out: "", err: "kowari: refused: Claude has no access to ungranted" });
  });

  test("refuses a read-only grant on a role that can write", async () => {
    const r = await kowari(["query", "owner-as-ro", "select 1"]);
    expect(r.code).toBe(1);
    expect(r.err).toStartWith("kowari: refused: owner-as-ro is marked read-only, but its role");
    expect(r.err).toContain("role attribute: superuser");
  });

  test("approve-writes runs reads and holds writes", async () => {
    expect((await kowari(["query", "local-approve", "select count(*)::int as n from victim"])).out).toBe(
      "n\n-\n3\n(1 row)",
    );
    const r = await kowari(["query", "local-approve", "update victim set v = 'x'"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("need approval in the kowari TUI");
    const viaFunction = await kowari(["query", "local-approve", "select bump()"]);
    expect(viaFunction.err).toBe(
      "kowari: refused: cannot execute UPDATE in a read-only transaction. Writes on this connection need approval in the kowari TUI, which does not exist yet",
    );
    expect((await kowari(["query", "local-ro", "select v from victim where id = 1"])).out).toContain("one");
  });

  test("writes on a write connection", async () => {
    const r = await kowari(["query", "local", "insert into victim values (4, 'four')"]);
    expect(r).toEqual({ code: 0, out: "INSERT 1", err: "" });
    await db.admin`delete from victim where id = 4`;
  });

  test("reports SQL errors", async () => {
    const r = await kowari(["query", "local-ro", "select nope from victim"]);
    expect(r).toEqual({ code: 1, out: "", err: 'kowari: error: column "nope" does not exist' });
  });

  test("lists tables", async () => {
    const r = await kowari(["tables", "local-ro"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^public +\| victim +\| table/m);
  });

  test("describes a table", async () => {
    const r = await kowari(["describe", "local-ro", "victim"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("# victim");
    expect(r.out).toMatch(/^id +\| integer +\| not null/m);
    expect(r.out).toContain("PRIMARY KEY (id)");
    expect(r.out).toContain("CREATE UNIQUE INDEX victim_pkey");
  });

  test("describes a missing table", async () => {
    const r = await kowari(["describe", "local-ro", "nope'; drop table victim; --"]);
    expect(r).toEqual({ code: 1, out: "", err: "kowari: no table or view named nope'; drop table victim; --" });
  });

  test("bare kowari without a terminal prints usage instead of opening the TUI", async () => {
    const r = await kowari([]);
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("Usage:");
  });

  test("explains usage mistakes", async () => {
    const r = await kowari(["query"]);
    expect(r.code).toBe(2);
    expect(r.err).toStartWith("which connection?");
  });
});

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")}: ${await new Response(proc.stderr).text()}`);
}
