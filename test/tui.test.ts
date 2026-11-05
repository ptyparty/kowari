import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { denyRules } from "../src/claude/deny.ts";
import { keyringKey, memoryKeyring } from "../src/connections/keyring.ts";
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
let scratch: string;
let keyring = memoryKeyring();
let copies: string[] = [];

beforeAll(async () => {
  await ready;
  scratch = await mkdtemp(path.join(os.tmpdir(), "kowari-tui-"));
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
  await rm(scratch, { recursive: true, force: true });
  await fixture?.teardown();
});

afterEach(async () => {
  await app?.stop();
  await setup?.dispose();
  app = undefined;
  setup = undefined;
});

function connection(name: string, environment: ResolvedConnection["environment"], ready = true, password: string | null = new URL(adminUrl).password): ResolvedConnection {
  const u = new URL(adminUrl);
  return {
    name,
    source: environment === "local" ? "repo" : "user",
    environment,
    agent: "read-only",
    agentNote: null,
    target: ready
      ? { kind: "ready", params: { host: u.hostname, port: Number(u.port), database: db.name, user: u.username, password, sslmode: "prefer", sslrootcert: null } }
      : { kind: "unavailable", reason: "APP_DB_PORT not set" },
  };
}

async function open(connections: ResolvedConnection[], claudeSettings = path.join(scratch, "settings-ok.json")): Promise<TestRendererSetup> {
  setup = await createTestRenderer({ width: 110, height: 24, kittyKeyboard: true });
  const resolution: Resolution = {
    worktree: { root: "/work/app", identity: "github.com/example/app", identityFromRemote: true, composeServices: new Set() },
    connections,
    problems: [],
  };
  copies = [];
  app = new App(setup.renderer, { resolve: async () => resolution, onQuit: () => (quits += 1), keyring, claudeSettings, copy: (text) => (copies.push(text), true) });
  await app.start();
  await until(setup, (f) => f.includes("CONNECTIONS"));
  return setup;
}

async function settled(s: TestRendererSetup): Promise<string> {
  await Bun.sleep(150);
  await s.renderOnce();
  return s.captureCharFrame();
}

async function connectFirst(s: TestRendererSetup): Promise<string> {
  s.mockInput.pressEnter();
  await until(s, (f) => f.includes("● LOCAL") && !f.includes("reading the catalog"));
  s.mockInput.pressKey("i");
  return until(s, (f) => f.includes(" INS "));
}

describe("kowari TUI", () => {
  beforeAll(async () => {
    await Bun.write(path.join(scratch, "settings-ok.json"), JSON.stringify({ permissions: { deny: denyRules() } }));
  });

  test("asks for a missing password, connects, and stores it in the keyring", async () => {
    keyring = memoryKeyring();
    const c = connection("staging", "testing", true, null);
    const s = await open([c]);
    await until(s, (f) => f.includes("asks on connect"));
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("Password for staging"));
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("nothing typed yet"));
    await s.mockInput.typeText("wrong");
    await until(s, (f) => f.includes("•••••") && f.includes("5 characters"));
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("that password was rejected"));
    await s.mockInput.typeText(new URL(adminUrl).password);
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("● TESTING"));
    if (c.target.kind !== "ready") throw new Error("unreachable");
    expect(keyring.entries.get(keyringKey(c.target.params))).toBe(new URL(adminUrl).password);
  });

  test("uses a stored password, asks again when it is rejected, and f forgets it", async () => {
    const c = connection("staging", "testing", true, null);
    if (c.target.kind !== "ready") throw new Error("unreachable");
    keyring = memoryKeyring({ [keyringKey(c.target.params)]: "stale" });
    const s = await open([c]);
    await until(s, (f) => f.includes("stored in your keyring"));
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("the stored password was rejected"));
    s.mockInput.pressEscape();
    s.mockInput.pressKey("f");
    await until(s, (f) => f.includes("Forget the stored password for staging?"));
    s.mockInput.pressKey("y");
    await until(s, (f) => f.includes("asks on connect"));
    expect(keyring.entries.size).toBe(0);
  });

  test("a password can be pasted into the prompt", async () => {
    keyring = memoryKeyring();
    const s = await open([connection("staging", "testing", true, null)]);
    await until(s, (f) => f.includes("asks on connect"));
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("Password for staging"));
    await s.mockInput.pasteBracketedText(new URL(adminUrl).password);
    await until(s, (f) => f.includes("•".repeat(new URL(adminUrl).password.length)));
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("● TESTING"));
  });

  test("with the keyring locked, it still asks, says the password will not be stored, and does not store it", async () => {
    keyring = memoryKeyring({}, "locked");
    const s = await open([connection("staging", "testing", true, null)]);
    await until(s, (f) => f.includes("keyring is locked"));
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("the keyring is locked or not running, so this password will"));
    await s.mockInput.typeText(new URL(adminUrl).password);
    s.mockInput.pressEnter();
    const frame = await until(s, (f) => f.includes("● TESTING"));
    expect(frame).toContain("the password was not stored");
    expect(keyring.entries.size).toBe(0);
  });

  test("offers to add the keyring and config deny rules to Claude Code's settings", async () => {
    keyring = memoryKeyring();
    const settings = path.join(scratch, "settings-missing.json");
    await Bun.write(settings, JSON.stringify({ model: "opus", permissions: { deny: ["Bash(rm -rf *)"] } }));
    const s = await open([connection("local", "local")], settings);
    await until(s, (f) => f.includes("8 deny rules are missing"));
    s.mockInput.pressKey("D", { shift: true });
    await until(s, (f) => f.includes("y adds them"));
    s.mockInput.pressKey("y");
    await until(s, (f) => !f.includes("deny rules are missing") && !f.includes("y adds them"));
    const after = JSON.parse(await readFile(settings, "utf8"));
    expect(after.model).toBe("opus");
    expect(after.permissions.deny).toEqual(["Bash(rm -rf *)", ...denyRules()]);
  });

  test("starts on the connection screen and inspects the selected connection", async () => {
    const s = await open([connection("local", "local"), connection("staging", "testing", false)]);
    let frame = await until(s, (f) => f.includes("DETAILS"));
    expect(frame).toMatch(/name\s+environment\s+claude/);
    expect(frame).toContain("sslmode      prefer");
    expect(frame).toMatch(/▸\s+local\s+local\s+read-only/);
    expect(frame).toContain("password     set");

    s.mockInput.pressArrow("down");
    frame = await until(s, (f) => f.includes("APP_DB_PORT not set"));
    expect(frame).toContain("testing");
  });

  test("the connection list keeps its environment and Claude columns in a narrow terminal", async () => {
    const s = await open([connection("a-rather-long-connection-name-for-staging", "testing"), connection("local", "local")]);
    await until(s, (f) => f.includes("DETAILS"));
    s.resize(80, 24);
    const frame = await until(s, (f) => /▸\s+a-rather.*…\s+testing\s+read-only/.test(f));
    expect(frame).toMatch(/local\s+local\s+read-only/);
  });

  test("connects, runs the statement under the cursor with Ctrl-Enter, and shows the grid", async () => {
    const s = await open([connection("local", "local")]);
    let frame = await connectFirst(s);
    expect(frame).toContain("shipment");

    await s.mockInput.typeText("select 1 as one;\nselect id, status from shipment order by id");
    s.mockInput.pressEnter({ ctrl: true });
    frame = await until(s, (f) => f.includes("2 rows"));
    expect(frame).toMatch(/id\s+status/);
    expect(frame).toMatch(/1\s+booked/);
    expect(frame).toMatch(/2\s+NULL/);
  });

  test("hands komux the SQL, or where the result cursor is, but no values", async () => {
    const s = await open([connection("local", "local")]);
    expect(app!.context()).toBe("kowari is not connected to a database");
    await connectFirst(s);
    expect(app!.context()).toBe("No SQL to attach in kowari");
    await s.mockInput.typeText("select 1 as one;\nselect id, status from shipment order by id");
    expect(app!.context()).toMatchObject({ label: 'local · "select id, status from ship…"' });
    s.mockInput.pressEnter({ ctrl: true });
    await until(s, (f) => f.includes("2 rows"));
    s.mockInput.pressEscape();
    s.mockInput.pressTab();
    s.mockInput.pressArrow("right");
    s.mockInput.pressArrow("down");
    await settled(s);
    const context = app!.context();
    expect(context).toMatchObject({ label: "local · row 2, status" });
    expect(typeof context === "string" ? context : context.text).toStartWith('Results in kowari on connection local, row 2, column "status" of public.shipment, from:');
    expect(JSON.stringify(context)).not.toContain("booked");
  });

  test("Ctrl-Enter runs the statement the cursor is on, even after wide characters", async () => {
    const s = await open([connection("local", "local")]);
    await connectFirst(s);
    await s.mockInput.typeText("select '日本' as wide;\nselect id from shipment where id = 2 or id = 1");
    s.mockInput.pressArrow("up");
    s.mockInput.pressEnter({ ctrl: true });
    const frame = await until(s, (f) => f.includes("1 row"));
    expect(frame).toMatch(/wide/);
    expect(frame).toContain("日本");
  });

  test("Enter on a table adds a select after what is in the editor and runs it", async () => {
    const s = await open([connection("local", "local")]);
    await connectFirst(s);
    await s.mockInput.typeText("select 42 as kept;");
    s.mockInput.pressTab();
    s.mockInput.pressTab();
    s.mockInput.pressEnter();
    const frame = await until(s, (f) => f.includes("2 rows"));
    expect(frame).toContain("select 42 as kept;");
    expect(frame).toContain("select * from public.shipment limit 100;");
  });

  test("completes columns of an aliased table and accepts with Tab", async () => {
    const s = await open([connection("local", "local")]);
    await connectFirst(s);
    await s.mockInput.typeText("select  from shipment s");
    for (let i = 0; i < " from shipment s".length; i++) s.mockInput.pressArrow("left");
    await s.mockInput.typeText("s.sta");
    await until(s, (f) => /col\s+status/.test(f));
    s.mockInput.pressTab();
    const frame = await until(s, (f) => f.includes("select s.status from shipment s"));
    expect(frame).not.toMatch(/col\s+status/);
  });

  test("Tab completes as far as the matches agree, then a unique match; Shift-Tab takes the highlighted one", async () => {
    await db.admin.unsafe(`create table if not exists shipment_leg (id int)`);
    try {
      const s = await open([connection("local", "local")]);
      await connectFirst(s);

      await s.mockInput.typeText("select * from sh");
      await until(s, (f) => /tbl\s+shipment_leg/.test(f));
      s.mockInput.pressTab();
      let frame = await until(s, (f) => /from shipment\s/.test(f));
      expect(frame).toMatch(/tbl\s+shipment_leg/);

      await s.mockInput.typeText("_");
      s.mockInput.pressTab();
      await until(s, (f) => f.includes("select * from shipment_leg"));
      frame = await settled(s);
      expect(frame).not.toMatch(/tbl\s+shipment_leg/);

      for (let i = 0; i < "shipment_leg".length; i++) s.mockInput.pressBackspace();
      await s.mockInput.typeText("sh");
      await until(s, (f) => /tbl\s+shipment/.test(f));
      s.mockInput.pressTab({ shift: true });
      await until(s, (f) => !/tbl\s+shipment/.test(f));
      frame = await settled(s);
      expect(frame).not.toMatch(/tbl\s+shipment/);
      expect(frame).toContain("select * from shipment ");
    } finally {
      await db.admin.unsafe(`drop table if exists shipment_leg`);
    }
  });

  test("the popup closes when the connection screen opens", async () => {
    const s = await open([connection("local", "local")]);
    await connectFirst(s);
    await s.mockInput.typeText("select * from sh");
    await until(s, (f) => /tbl\s+shipment/.test(f));
    s.mockInput.pressKey("o", { ctrl: true });
    const frame = await until(s, (f) => f.includes("DETAILS"));
    expect(frame).not.toMatch(/tbl\s+shipment/);
  });

  test("tables created in the session are offered afterwards", async () => {
    try {
      const s = await open([connection("local", "local")]);
      await connectFirst(s);
      await s.mockInput.typeText("create table invoice_line (id int)");
      s.mockInput.pressEnter({ ctrl: true });
      await until(s, (f) => f.includes("CREATE TABLE") && f.includes("invoice_line "));
      await Bun.sleep(100);
      for (let i = 0; i < "create table invoice_line (id int)".length; i++) s.mockInput.pressBackspace();
      await s.mockInput.typeText("select * from invoice_l");
      await until(s, (f) => /tbl\s+invoice_line/.test(f));
    } finally {
      await db.admin.unsafe(`drop table if exists invoice_line`);
    }
  });

  test("completes tables after from", async () => {
    const s = await open([connection("local", "local")]);
    await connectFirst(s);
    await s.mockInput.typeText("select * from shi");
    const frame = await until(s, (f) => /tbl\s+shipment/.test(f));
    expect(frame).not.toMatch(/tbl\s+victim/);
  });

  test("helix: normal mode edits by selection, insert mode types", async () => {
    const s = await open([connection("local", "local")]);
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes(" NOR "));
    await s.mockInput.typeText("xyz");
    expect(app!.text).toBe("");

    s.mockInput.pressKey("i");
    await s.mockInput.typeText("select '日本' as wide;\nselect 2;");
    await Bun.sleep(50);
    s.mockInput.pressEscape();
    await until(s, (f) => f.includes(" NOR "));
    s.mockInput.pressKey("x");
    s.mockInput.pressKey("d");
    await until(s, () => app!.text === "select '日本' as wide;\n");

    s.mockInput.pressKey("k");
    s.mockInput.pressKey("g");
    s.mockInput.pressKey("h");
    for (const k of ["w", "w", "w", "w", "w"]) s.mockInput.pressKey(k);
    s.mockInput.pressKey("e");
    s.mockInput.pressKey("c");
    await until(s, (f) => f.includes(" INS "));
    await s.mockInput.typeText("narrow");
    await Bun.sleep(50);
    s.mockInput.pressEscape();
    await until(s, () => app!.text === "select '日本' as narrow;\n");

    s.mockInput.pressKey("u");
    await until(s, () => app!.text.includes("wide"));
  });

  test("helix: one Esc closes the completion popup and leaves insert mode", async () => {
    const s = await open([connection("local", "local")]);
    await connectFirst(s);
    await s.mockInput.typeText("select * from sh");
    await until(s, (f) => /tbl\s+shipment/.test(f));
    s.mockInput.pressEscape();
    const frame = await until(s, (f) => f.includes(" NOR "));
    expect(frame).not.toMatch(/tbl\s+shipment/);
  });

  test("helix: a paste in normal mode goes in at the cursor and can be undone", async () => {
    const s = await open([connection("local", "local")]);
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes(" NOR "));
    await s.mockInput.pasteBracketedText("select 1;");
    await until(s, () => app!.text === "select 1;");
    s.mockInput.pressKey("u");
    await until(s, () => app!.text === "");
  });

  test("shows when there are more columns off either edge", async () => {
    const s = await open([connection("local", "local")]);
    await connectFirst(s);
    const cols = Array.from({ length: 12 }, (_, i) => `'value ${i + 1} padded wide' as column_${i + 1}`).join(", ");
    await s.mockInput.typeText(`select ${cols}`);
    s.mockInput.pressEnter({ ctrl: true });
    let frame = await until(s, (f) => /columns 1–\d+ of 12/.test(f));
    expect(frame).toMatch(/\+\d+ ›/);
    expect(frame).not.toContain("‹ +");
    s.mockInput.pressTab();
    for (let i = 0; i < 11; i++) s.mockInput.pressArrow("right");
    frame = await until(s, (f) => /columns \d+–12 of 12/.test(f));
    expect(frame).toMatch(/‹ \+\d+/);
    expect(frame).not.toMatch(/\+\d+ ›/);
  });

  test("opens a JSON cell pretty-printed", async () => {
    const s = await open([connection("local", "local")]);
    await connectFirst(s);
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
    await connectFirst(s);
    await s.mockInput.typeText("select nope from shipment");
    s.mockInput.pressEnter({ ctrl: true });
    const frame = await until(s, (f) => f.includes("RESULTS  ·  error"));
    expect(frame).toContain('column "nope" does not exist');
  });

  test("a production connection says so in the banner", async () => {
    const s = await open([connection("prod", "production")]);
    s.mockInput.pressEnter();
    const frame = await until(s, (f) => f.includes("● PRODUCTION"));
    expect(frame).toContain("Claude read-only");
  });

  test("space opens the menu in normal mode, and ␣ ? lists the editor's keys", async () => {
    const s = await open([connection("local", "local")]);
    await connectFirst(s);
    s.mockInput.pressEscape();
    await until(s, (f) => f.includes(" NOR "));
    s.mockInput.pressKey(" ");
    let frame = await until(s, (f) => f.includes("Menu") && f.includes("find table"));
    expect(frame).toContain("connections");
    expect(app!.keys()[0]!.commands.map((c) => c.send)).toEqual(["f", "r", "c", "?", "q", "\u001b"]);
    s.mockInput.pressKey("?");
    frame = await until(s, (f) => f.includes("Keys") && f.includes("SQL editor"));
    expect(frame).toContain("Workspace");
    expect(frame).toContain("Select");
    s.mockInput.pressArrow("down");
    s.mockInput.pressKey("\u001b[6~");
    frame = await until(s, (f) => f.includes("Completion"));
    expect(frame).toContain("Insert");
    s.mockInput.pressEscape();
    await until(s, (f) => !f.includes("Completion"));
    expect(app!.text).toBe("");
  });

  test("space in insert mode is text", async () => {
    const s = await open([connection("local", "local")]);
    await connectFirst(s);
    await s.mockInput.typeText("select 1");
    await until(s, () => app!.text === "select 1");
    expect(s.captureCharFrame()).not.toContain("find table");
  });

  test("␣ f finds a table and selects from it", async () => {
    const s = await open([connection("local", "local")]);
    await connectFirst(s);
    s.mockInput.pressEscape();
    await until(s, (f) => f.includes(" NOR "));
    s.mockInput.pressKey(" ");
    s.mockInput.pressKey("f");
    await until(s, (f) => f.includes("Find table"));
    await s.mockInput.typeText("shpm");
    await until(s, (f) => f.includes("1 of 2"));
    s.mockInput.pressEnter();
    const frame = await until(s, (f) => f.includes("2 rows"));
    expect(frame).toContain("select * from public.shipment limit 100;");
    expect(frame).not.toContain("Find table");
  });

  test(":q quits from normal mode, and an unknown command says so", async () => {
    const s = await open([connection("local", "local")]);
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes(" NOR "));
    await s.mockInput.typeText(":nope");
    await until(s, (f) => f.includes(":nope"));
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("not a command: :nope"));
    const before = quits;
    await s.mockInput.typeText(":q");
    s.mockInput.pressEnter();
    await s.waitFor(() => quits > before);
    expect(app!.text).toBe("");
  });

  test("/ in normal mode selects the next match in the SQL, and n goes on", async () => {
    const s = await open([connection("local", "local")]);
    await connectFirst(s);
    await s.mockInput.typeText("select id from shipment where id in (select id from shipment)");
    await Bun.sleep(50);
    s.mockInput.pressEscape();
    s.mockInput.pressKey("g");
    s.mockInput.pressKey("g");
    await s.mockInput.typeText("/from");
    await until(s, (f) => f.includes("/from"));
    s.mockInput.pressEnter();
    await settled(s);
    expect(app!.context()).toMatchObject({ label: 'local · "from"' });
    s.mockInput.pressKey("n");
    await settled(s);
    expect(app!.context()).toMatchObject({ label: 'local · "from"' });
    s.mockInput.pressKey("d");
    await until(s, () => app!.text === "select id from shipment where id in (select id  shipment)");
  });

  test("/ in the grid finds cells, n and N step through them, and Esc clears", async () => {
    const s = await open([connection("local", "local")]);
    await connectFirst(s);
    await s.mockInput.typeText("select id, status, status as again from shipment order by id");
    s.mockInput.pressEnter({ ctrl: true });
    await until(s, (f) => f.includes("2 rows"));
    s.mockInput.pressTab();
    await s.mockInput.typeText("/BOOK");
    await until(s, (f) => f.includes("no match"));
    s.mockInput.pressBackspace();
    s.mockInput.pressBackspace();
    s.mockInput.pressBackspace();
    s.mockInput.pressBackspace();
    await s.mockInput.typeText("book");
    let frame = await until(s, (f) => f.includes("/book") && f.includes("2 cells"));
    s.mockInput.pressEnter();
    frame = await until(s, (f) => f.includes("2 cells match /book"));
    expect(app!.context()).toMatchObject({ label: "local · row 1, status" });
    s.mockInput.pressKey("n");
    frame = await until(s, (f) => f.includes("2 of 2"));
    s.mockInput.pressKey("N", { shift: true });
    frame = await until(s, (f) => f.includes("1 of 2"));
    s.mockInput.pressEscape();
    frame = await until(s, (f) => f.includes("row 1 · status") && !f.includes("of 2"));
    expect(frame).toMatch(/1\s+booked\s+booked/);
  });

  test("y copies the cell and Y the row", async () => {
    const s = await open([connection("local", "local")]);
    await connectFirst(s);
    await s.mockInput.typeText("select id, status from shipment order by id");
    s.mockInput.pressEnter({ ctrl: true });
    await until(s, (f) => f.includes("2 rows"));
    s.mockInput.pressTab();
    s.mockInput.pressArrow("right");
    s.mockInput.pressKey("y");
    await until(s, (f) => f.includes("copied status from row 1"));
    s.mockInput.pressArrow("down");
    s.mockInput.pressKey(" ");
    s.mockInput.pressKey("Y", { shift: true });
    await until(s, (f) => f.includes("copied row 2"));
    expect(copies).toEqual(["booked", "2\t"]);
  });

  test("tells komux the keys for where it is", async () => {
    const s = await open([connection("local", "local")]);
    const names = () => app!.keys().map((g) => g.name);
    expect(names()).toEqual(["Menu", "Workspace", "Connections"]);
    await connectFirst(s);
    expect(names()).toEqual(["Workspace", "Insert"]);
    s.mockInput.pressEscape();
    await until(s, (f) => f.includes(" NOR "));
    expect(names()).toEqual(["Menu", "Workspace", "Move", "Select", "Edit"]);
    const commands = app!.keys().flatMap((g) => g.commands);
    expect(commands).toContainEqual({ label: "run statement under the cursor", keys: "F5  ^⏎", send: "\u001b[15~" });
    expect(commands).toContainEqual({ label: "find table", keys: "␣ f", send: " f" });
    expect(commands).toContainEqual({ label: "to or till a character", keys: "f t F T" });
    s.mockInput.pressTab();
    s.mockInput.pressTab();
    await settled(s);
    expect(names()).toEqual(["Menu", "Workspace", "Tables"]);
  });

  test("space on the connection screen opens its menu, and q there quits", async () => {
    const s = await open([connection("local", "local")]);
    s.mockInput.pressKey(" ");
    await until(s, (f) => f.includes("Menu") && f.includes("help"));
    expect(s.captureCharFrame()).not.toContain("find table");
    const before = quits;
    s.mockInput.pressKey("q");
    await s.waitFor(() => quits > before);
  });

  test("Ctrl-Q quits", async () => {
    const s = await open([connection("local", "local")]);
    const before = quits;
    s.mockInput.pressKey("q", { ctrl: true });
    await s.waitFor(() => quits > before);
  });
});
