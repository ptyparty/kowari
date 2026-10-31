import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import type { Resolution, ResolvedConnection } from "../src/connections/resolve.ts";
import { ready } from "../src/sql/tokens.ts";
import { App } from "../src/tui/app.ts";
import { until } from "./support/frames.ts";
import { adminUrl, makeFixture, type Fixture, type FixtureDatabase } from "./escape/fixture.ts";

let fixture: Fixture;
let db: FixtureDatabase;
let setup: TestRendererSetup | undefined;
let app: App | undefined;
let quits = 0;

beforeAll(async () => {
  await ready;
  fixture = await makeFixture();
  db = await fixture.freshDatabase();
  await db.admin.unsafe(`
    create table shipment (id int primary key, status text, details jsonb);
    insert into shipment values
      (1, 'booked', '{"carrier": "maersk", "legs": [{"from": "NLRTM", "to": "USNYC"}]}'),
      (2, null, null);
  `).simple();
});

afterAll(async () => {
  await fixture?.teardown();
});

afterEach(async () => {
  await app?.stop();
  await setup?.dispose();
  app = undefined;
  setup = undefined;
});

function connection(name: string, environment: ResolvedConnection["environment"], ready = true): ResolvedConnection {
  const u = new URL(adminUrl);
  return {
    name,
    source: environment === "local" ? "repo" : "user",
    environment,
    agent: "read-only",
    agentNote: null,
    target: ready
      ? { kind: "ready", params: { host: u.hostname, port: Number(u.port), database: db.name, user: u.username, password: u.password } }
      : { kind: "unavailable", reason: "APP_DB_PORT not set" },
  };
}

async function open(connections: ResolvedConnection[]): Promise<TestRendererSetup> {
  setup = await createTestRenderer({ width: 110, height: 24, kittyKeyboard: true });
  const resolution: Resolution = {
    worktree: { root: "/work/app", identity: "github.com/example/app", identityFromRemote: true, composeServices: new Set() },
    connections,
    problems: [],
  };
  app = new App(setup.renderer, { resolve: async () => resolution, onQuit: () => (quits += 1) });
  await app.start();
  await until(setup, (f) => f.includes("Connections"));
  return setup;
}

describe("kowari TUI", () => {
  test("starts on the connection screen and inspects the selected connection", async () => {
    const s = await open([connection("local", "local"), connection("staging", "testing", false)]);
    let frame = await until(s, (f) => f.includes("Details"));
    expect(frame).toMatch(/Name\s+Environment\s+Claude/);
    expect(frame).toMatch(/▸\s+local\s+local\s+read-only/);
    expect(frame).toContain("password     set");

    s.mockInput.pressArrow("down");
    frame = await until(s, (f) => f.includes("APP_DB_PORT not set"));
    expect(frame).toContain("testing");
  });

  test("connects, runs the statement under the cursor with Ctrl-Enter, and shows the grid", async () => {
    const s = await open([connection("local", "local")]);
    s.mockInput.pressEnter();
    let frame = await until(s, (f) => f.includes("LOCAL · local"));
    expect(frame).toContain("shipment");

    await s.mockInput.typeText("select 1 as one;\nselect id, status from shipment order by id");
    s.mockInput.pressEnter({ ctrl: true });
    frame = await until(s, (f) => f.includes("2 rows"));
    expect(frame).toMatch(/id\s+│ status/);
    expect(frame).toMatch(/1\s+│ booked/);
    expect(frame).toMatch(/2\s+│ NULL/);
  });

  test("Ctrl-Enter runs the statement the cursor is on, even after wide characters", async () => {
    const s = await open([connection("local", "local")]);
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("LOCAL · local"));
    await s.mockInput.typeText("select '日本' as wide;\nselect id from shipment where id = 2 or id = 1");
    s.mockInput.pressArrow("up");
    s.mockInput.pressEnter({ ctrl: true });
    const frame = await until(s, (f) => f.includes("1 row"));
    expect(frame).toMatch(/wide/);
    expect(frame).toContain("日本");
  });

  test("Enter on a table adds a select after what is in the editor and runs it", async () => {
    const s = await open([connection("local", "local")]);
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("LOCAL · local"));
    await s.mockInput.typeText("select 42 as kept;");
    s.mockInput.pressTab();
    s.mockInput.pressTab();
    s.mockInput.pressEnter();
    const frame = await until(s, (f) => f.includes("2 rows"));
    expect(frame).toContain("select 42 as kept;");
    expect(frame).toContain("select * from public.shipment limit 100;");
  });

  test("opens a JSON cell pretty-printed", async () => {
    const s = await open([connection("local", "local")]);
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("LOCAL · local"));
    await s.mockInput.typeText("select details from shipment where id = 1");
    s.mockInput.pressEnter({ ctrl: true });
    await until(s, (f) => f.includes("1 row"));

    s.mockInput.pressTab();
    s.mockInput.pressEnter();
    const frame = await until(s, (f) => f.includes("Esc closes"));
    expect(frame).toContain('"carrier": "maersk"');
    expect(frame).toContain('"from": "NLRTM"');
  });

  test("shows SQL errors in the results pane", async () => {
    const s = await open([connection("local", "local")]);
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("LOCAL · local"));
    await s.mockInput.typeText("select nope from shipment");
    s.mockInput.pressEnter({ ctrl: true });
    const frame = await until(s, (f) => f.includes("Error ·"));
    expect(frame).toContain('column "nope" does not exist');
  });

  test("a production connection says so in the banner", async () => {
    const s = await open([connection("prod", "production")]);
    s.mockInput.pressEnter();
    const frame = await until(s, (f) => f.includes("PRODUCTION · prod"));
    expect(frame).toContain("Claude: read-only");
  });

  test("Ctrl-Q quits", async () => {
    const s = await open([connection("local", "local")]);
    const before = quits;
    s.mockInput.pressKey("q", { ctrl: true });
    await s.waitFor(() => quits > before);
  });
});
