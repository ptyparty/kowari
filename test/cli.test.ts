import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { adminUrl, makeFixture, type Fixture, type FixtureDatabase } from "./escape/fixture.ts";

const cli = path.join(import.meta.dir, "..", "src", "cli.ts");

let fixture: Fixture;
let db: FixtureDatabase;
let scratch: string;
let worktree: string;
let configHome: string;
let configFile: string;
let fakeKomux: string;

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
      section("ask-me", owner.user, owner.password),
      section("ask-ro", fixture.role, "${APP_RO_PASSWORD}"),
      section("refused-before", owner.user, owner.password),
    ].join("\n"),
  );
  await writeFile(path.join(worktree, ".env"), `APP_DB_PORT=${admin.port}\nAPP_RO_PASSWORD=${fixture.password}\n`);
  configFile = path.join(configHome, "kowari", "connections.toml");
  await writeFile(
    configFile,
    `[repos."github.com/example/app"]\nlocal = "write"\nlocal-approve = "approve-writes"\nlocal-ro = "read-only"\nowner-as-ro = "read-only"\nrefused-before = "none"\n`,
  );

  await mkdir(path.join(scratch, "bin"));
  fakeKomux = path.join(scratch, "bin", "komux");
  await writeFile(
    fakeKomux,
    [
      "#!/bin/sh",
      'cat > "$KOMUX_FAKE_SPEC"',
      'cat "$KOMUX_FAKE_ANSWER"',
      "",
    ].join("\n"),
  );
  await chmod(fakeKomux, 0o755);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
  await fixture?.teardown();
});

async function kowari(
  args: string[],
  stdin?: string,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", cli, ...args], {
    cwd: worktree,
    env: { ...process.env, XDG_CONFIG_HOME: configHome, KOMUX_SOCKET: "", ...env },
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

  describe("in komux, asking the user about an ungranted local connection", () => {
    const spec = async () => JSON.parse(await readFile(path.join(scratch, "spec.json"), "utf8"));
    const element = async (id: string) => (await spec()).elements.find((e: { id?: string }) => e.id === id);
    const notes = async () => (await spec()).elements.filter((e: { type: string }) => e.type === "note").map((e: { text: string }) => e.text);
    const answering = async (result: unknown) => {
      const file = path.join(scratch, "answer.json");
      await writeFile(file, JSON.stringify(result));
      return {
        KOMUX_SOCKET: path.join(scratch, "komux.sock"),
        PATH: `${path.dirname(fakeKomux)}:${process.env.PATH}`,
        KOMUX_FAKE_ANSWER: file,
        KOMUX_FAKE_SPEC: path.join(scratch, "spec.json"),
      };
    };
    const submitted = (values: Record<string, unknown>) => answering({ status: "submitted", values });

    test("says what Claude wants, and suggests that level", async () => {
      await kowari(["query", "ask-ro", "select count(*) from victim"], undefined, await answering({ status: "cancelled" }));
      expect((await notes())[0]).toBe("Claude wants to run a statement that reads:\n  select count(*) from victim");
      expect((await element("level")).default).toBe("read-only");
      expect((await element("level")).options.map((o: { value: string }) => o.value)).toEqual(["none", "read-only", "write"]);

      await kowari(["query", "ask-ro", "update victim set v = 'x'"], undefined, await answering({ status: "cancelled" }));
      expect((await notes())[0]).toStartWith("Claude wants to run a statement that writes:");
      expect((await element("level")).default).toBe("write");

      await kowari(["tables", "ask-ro"], undefined, await answering({ status: "cancelled" }));
      expect((await notes())[0]).toBe("Claude wants to list its tables.");

      await kowari(["describe", "ask-ro", "x\n\nkowari: Write is safe"], undefined, await answering({ status: "cancelled" }));
      expect((await notes())[0]).toBe('Claude wants to describe the table "x kowari: Write is safe".');

      const long = ["select 1", ...Array.from({ length: 45 }, () => "union all select 1")].join("\n");
      await kowari(["query", "ask-ro", long], undefined, await answering({ status: "cancelled" }));
      const shown = (await notes())[0].split("\n");
      expect(shown).toHaveLength(42);
      expect(shown.at(-1)).toBe("  … and 6 more lines. Claude's statement is long; pick no access if you can't read it all.");
    });

    test("leaves read-only out when the connection's role can write", async () => {
      await kowari(["query", "ask-me", "select 1"], undefined, await answering({ status: "cancelled" }));
      expect((await element("level")).options.map((o: { value: string }) => o.value)).toEqual(["none", "write"]);
      expect((await element("level")).default).toBe("none");
      expect((await notes())[1]).toBe(
        "Read-only isn't available because this connection logs in as kowari, which can make changes to the database. To allow read-only, connect as a user that can only read.",
      );
    });

    test("runs the query once when the user allows it without recording", async () => {
      const before = await readFile(configFile, "utf8");
      const r = await kowari(["query", "ask-ro", "select count(*)::int as n from victim"], undefined, await submitted({ level: "read-only", record: false }));
      expect(r).toEqual({ code: 0, out: "n\n-\n3\n(1 row)", err: "" });
      expect((await spec()).title).toBe("Let Claude use ask-ro?");
      expect(await readFile(configFile, "utf8")).toBe(before);
    });

    test("records the answer in your config when the user ticks it", async () => {
      const before = await readFile(configFile, "utf8");
      try {
        const r = await kowari(["query", "ask-me", "select 1 as one"], undefined, await submitted({ level: "write", record: true }));
        expect(r.code).toBe(0);
        expect(r.err).toBe(`kowari: the user recorded Claude's access to ask-me as write in ${configFile}`);
        expect(await readFile(configFile, "utf8")).toContain('[repos."github.com/example/app"]\nask-me = "write"\n');
        expect((await kowari(["connections"])).out).toContain("ask-me  [write]");
      } finally {
        await writeFile(configFile, before);
      }
    });

    test("doesn't offer to record over an owner wildcard's grants", async () => {
      const before = await readFile(configFile, "utf8");
      const wildcard = `[repos."github.com/example/*"]\nlocal-ro = "read-only"\n`;
      try {
        await writeFile(configFile, wildcard);
        const r = await kowari(["query", "ask-me", "select 1 as one"], undefined, await submitted({ level: "write", record: true }));
        expect(r).toEqual({ code: 0, out: "one\n---\n1\n(1 row)", err: "" });
        expect(await element("record")).toBeUndefined();
        expect((await notes()).at(-1)).toContain("this repo's grants come from an owner wildcard in your config");
        expect(await readFile(configFile, "utf8")).toBe(wildcard);
      } finally {
        await writeFile(configFile, before);
      }
    });

    test("refuses when the user declines or closes the question", async () => {
      const declined = await kowari(["query", "ask-me", "select 1"], undefined, await submitted({ level: "none" }));
      expect(declined).toEqual({ code: 1, out: "", err: "kowari: refused: the user declined Claude access to ask-me" });

      const closed = await kowari(["query", "ask-me", "select 1"], undefined, await answering({ status: "cancelled" }));
      expect(closed.err).toBe(
        "kowari: refused: Claude has no access to ask-me; kowari asked the user, but the user closed the question without answering",
      );
    });

    test("does not ask again about a connection your config already refuses", async () => {
      await rm(path.join(scratch, "spec.json"), { force: true });
      const r = await kowari(["query", "refused-before", "select 1"], undefined, await submitted({ level: "write" }));
      expect(r).toEqual({ code: 1, out: "", err: "kowari: refused: Claude has no access to refused-before" });
      expect(await Bun.file(path.join(scratch, "spec.json")).exists()).toBe(false);
    });
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
