import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openReadOnly, type AgentLimits, type ReadOnlyConnection } from "../../src/agent/read-only.ts";
import { adminUrl, makeFixture, type Fixture, type FixtureDatabase } from "./fixture.ts";
import { vectors } from "./vectors.ts";

const limits: AgentLimits = { statementTimeoutMs: 2_000, lockTimeoutMs: 500, maxRows: 50, maxBytes: 64 * 1024 };
const adminPassword = new URL(adminUrl).password;
const hardened = { revokeDblink: true, revokeRemoteDefiner: true };

let fixture: Fixture;

beforeAll(async () => {
  fixture = await makeFixture();
});

afterAll(async () => {
  await fixture?.teardown();
});

describe("role check", () => {
  test("refuses the database owner", async () => {
    const db = await fixture.freshDatabase();
    const outcome = await openReadOnly(db.adminUrl, limits);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.problems.map((p) => p.kind)).toContain("role attribute");
  });

  test("refuses the agent role while PUBLIC can execute dblink", async () => {
    const db = await fixture.freshDatabase();
    const outcome = await openReadOnly(db.agentUrl, limits);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.problems.map((p) => p.detail)).toEqual([
        expect.stringContaining("dblink functions"),
        expect.stringMatching(/definer_bump\(\), owned by kowari_app_\w+, which can open remote connections/),
        expect.stringContaining("definer_dblink(text), owned by kowari, a superuser"),
      ]);
    }
  });

  test("refuses the agent role while it can reach dblink through a superuser's security definer function", async () => {
    const db = await fixture.freshDatabase({ revokeDblink: true });
    const outcome = await openReadOnly(db.agentUrl, limits);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.problems).toHaveLength(1);
      expect(outcome.problems[0]!.detail).toContain("definer_dblink(text)");
    }
  });

  test("refuses the agent role when it can MAINTAIN a table", async () => {
    const db = await fixture.freshDatabase(hardened);
    await db.admin.unsafe(`grant maintain on victim to ${fixture.role}`);
    const outcome = await openReadOnly(db.agentUrl, limits);
    expect(outcome.kind === "refused" && outcome.problems).toEqual([
      { kind: "table privilege", detail: "MAINTAIN on public.victim" },
    ]);
  });

  test("accepts the agent role once dblink and the definer function are revoked", async () => {
    const db = await fixture.freshDatabase(hardened);
    const outcome = await openReadOnly(db.agentUrl, limits);
    if (outcome.kind === "refused") throw new Error(JSON.stringify(outcome.problems));
    await outcome.connection.close();
  });
});

describe("agent read-only connection", () => {
  let db: FixtureDatabase;
  let conn: ReadOnlyConnection;
  let before: string;

  beforeAll(async () => {
    db = await fixture.freshDatabase(hardened);
    const outcome = await openReadOnly(db.agentUrl, limits);
    if (outcome.kind === "refused") throw new Error(JSON.stringify(outcome.problems));
    conn = outcome.connection;
    before = await db.snapshot();
  });

  afterAll(async () => {
    await conn?.close();
  });

  test("reads", async () => {
    const result = await conn.query("select id, v from victim order by id");
    expect(result).toEqual({
      kind: "rows",
      columns: [{ name: "id", type: 23 }, { name: "v", type: 25 }],
      rows: [[1, "one"], [2, "two"], [3, "three"]],
      truncated: false,
      command: "SELECT",
      count: 3,
    });
  });

  test("returns every row of show and explain", async () => {
    const show = await conn.query("show statement_timeout");
    expect(show.kind === "rows" && show.rows).toEqual([["2s"]]);
    const explain = await conn.query("-- plan\nexplain select * from victim");
    expect(explain.kind === "rows" && explain.rows.length).toBeGreaterThan(0);
  });

  test("caps rows", async () => {
    const result = await conn.query("select g from generate_series(1, 10000) g");
    expect(result.kind).toBe("rows");
    if (result.kind === "rows") {
      expect(result.rows.length).toBe(limits.maxRows);
      expect(result.truncated).toBe(true);
    }
  });

  for (const vector of vectors) {
    test(`blocks ${vector.name}`, async () => {
      const text = vector.sql({ database: db.name, canaryPid: db.canaryPid, adminPassword });
      const result = await conn.query(text);
      expect(result.kind).not.toBe("rows");
      expect(await db.snapshot()).toBe(before);
    }, 10_000);
  }

  test("still reads after every vector", async () => {
    const result = await conn.query("select count(*)::int from victim");
    expect(result.kind === "rows" && result.rows).toEqual([[3]]);
  });
});
