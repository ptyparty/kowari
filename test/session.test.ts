import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openAgentSession } from "../src/agent/session.ts";
import { keyringKey, memoryKeyring } from "../src/connections/keyring.ts";
import type { ResolvedConnection } from "../src/connections/resolve.ts";
import { adminUrl, makeFixture, type Fixture, type FixtureDatabase } from "./escape/fixture.ts";

let fixture: Fixture;
let db: FixtureDatabase;

beforeAll(async () => {
  fixture = await makeFixture();
  db = await fixture.freshDatabase();
});

afterAll(async () => {
  await fixture?.teardown();
});

function passwordless(): ResolvedConnection {
  const u = new URL(adminUrl);
  return {
    name: "staging",
    source: "user",
    environment: "testing",
    agent: "write",
    agentNote: null,
    agentSet: true,
    initSql: null,
    target: { kind: "ready", params: { host: u.hostname, port: Number(u.port), database: db.name, user: u.username, password: null, sslmode: "prefer", sslrootcert: null } },
  };
}

describe("Claude's session and the keyring", () => {
  test("refuses with nothing stored, and says how to store one", async () => {
    const outcome = await openAgentSession(passwordless(), undefined, memoryKeyring());
    expect(outcome).toEqual({ kind: "refused", reason: "no password for staging: connect once from the kowari TUI to store one in the keyring" });
  });

  test("says when the keyring is locked", async () => {
    const outcome = await openAgentSession(passwordless(), undefined, memoryKeyring({}, "locked"));
    expect(outcome.kind === "refused" && outcome.reason).toContain("the keyring is locked");
  });

  test("connects with a stored password, without changing the connection", async () => {
    const c = passwordless();
    if (c.target.kind !== "ready") throw new Error("unreachable");
    const outcome = await openAgentSession(c, undefined, memoryKeyring({ [keyringKey(c.target.params)]: new URL(adminUrl).password }));
    if (outcome.kind !== "open") throw new Error(outcome.reason);
    expect((await outcome.session.query("select 1 as one")).kind).toBe("rows");
    await outcome.session.close();
    expect(c.target.params.password).toBeNull();
  });

  test("never runs the connection's init_sql", async () => {
    const c = { ...passwordless(), initSql: "set application_name to 'from-init'" };
    if (c.target.kind !== "ready") throw new Error("unreachable");
    const outcome = await openAgentSession(c, undefined, memoryKeyring({ [keyringKey(c.target.params)]: new URL(adminUrl).password }));
    if (outcome.kind !== "open") throw new Error(outcome.reason);
    const result = await outcome.session.query("select current_setting('application_name') as app");
    await outcome.session.close();
    if (result.kind !== "rows") throw new Error(result.kind);
    expect(result.rows[0]?.[0]).not.toBe("from-init");
  });
});
