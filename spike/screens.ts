import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import path from "node:path";
import type { Resolution, ResolvedConnection } from "../src/connections/resolve.ts";
import { memoryKeyring } from "../src/connections/keyring.ts";
import { ready } from "../src/sql/tokens.ts";
import { App } from "../src/tui/app.ts";
import { adminUrl, makeFixture } from "../test/escape/fixture.ts";
import { until } from "../test/support/frames.ts";
import { screenshot } from "../test/support/screenshot.ts";

const outDir = process.argv[2] ?? "";
if (outDir === "") throw new Error("usage: bun spike/screens.ts <output dir>");

await ready;
const fixture = await makeFixture();
const db = await fixture.freshDatabase();
await db.admin.unsafe(`
  create table shipment (
    id int primary key,
    status text,
    carrier text not null,
    details jsonb,
    created_at timestamptz not null default '2026-10-31 09:15:00+00'
  );
  insert into shipment
  select g,
    (array['booked', 'quoted', null, 'delivered'])[1 + g % 4],
    (array['maersk', 'cma', 'hapag', 'one'])[1 + g % 4],
    jsonb_build_object('legs', jsonb_build_array(jsonb_build_object('from', 'NLRTM', 'to', 'USNYC', 'mode', 'ocean'), jsonb_build_object('from', 'USNYC', 'to', 'USCHI', 'mode', 'rail')), 'weight_kg', 1200 + g * 37, 'hazmat', g % 5 = 0),
    '2026-10-31 09:15:00+00'::timestamptz - make_interval(hours => g)
  from generate_series(1, 240) g;
  create table carrier (code text primary key, name text not null);
  insert into carrier values ('maersk', 'Maersk'), ('cma', 'CMA CGM'), ('hapag', 'Hapag-Lloyd'), ('one', 'Ocean Network Express');
  analyze;
`).simple();

const u = new URL(adminUrl);
const params = { host: u.hostname, port: Number(u.port), database: db.name, user: u.username, password: u.password, sslmode: "prefer" as const, sslrootcert: null };
const connection = (name: string, environment: ResolvedConnection["environment"], agent: ResolvedConnection["agent"], source: ResolvedConnection["source"]): ResolvedConnection => ({
  name,
  source,
  environment,
  agent,
  agentNote: null,
  target: { kind: "ready", params },
});
const resolution: Resolution = {
  worktree: { root: "/home/qxjit/work/stories/sc-1234/argus", identity: "github.com/exfresso/argus", identityFromRemote: true, composeServices: new Set() },
  connections: [
    connection("local", "local", "write", "repo"),
    connection("local-ro", "local", "read-only", "repo"),
    connection("staging", "testing", "read-only", "user"),
    connection("prod-replica", "production", "none", "user"),
    { ...connection("staging-rds", "testing", "read-only", "user"), target: { kind: "ready", params: { ...params, password: null } } },
  ],
  problems: [],
};

async function shoot(s: TestRendererSetup, name: string): Promise<void> {
  await s.renderOnce();
  const file = path.join(outDir, `${name}.png`);
  await screenshot(s.captureSpans(), file);
  console.log(file);
}

async function session(pick: number, run: (s: TestRendererSetup) => Promise<void>): Promise<void> {
  const s = await createTestRenderer({ width: 120, height: 32, kittyKeyboard: true });
  const app = new App(s.renderer, { resolve: async () => resolution, onQuit: () => {}, keyring: memoryKeyring(), claudeSettings: "/nonexistent/kowari-screens/settings.json" });
  await app.start();
  await until(s, (f) => f.includes("DETAILS"));
  for (let i = 0; i < pick; i++) s.mockInput.pressArrow("down");
  await run(s);
  await app.stop();
  await s.dispose();
}

try {
  await session(0, async (s) => {
    await shoot(s, "tui-connections");
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("LOCAL") && !f.includes("reading the catalog"));
    s.mockInput.pressKey("i");
    await s.mockInput.typeText(
      "select s.id, s.status, c.name as carrier, s.details, s.created_at\nfrom shipment s\njoin carrier c on c.code = s.carrier\nwhere s.status is distinct from 'delivered' -- open ones\norder by s.created_at desc;",
    );
    s.mockInput.pressEnter({ ctrl: true });
    await until(s, (f) => f.includes("180 rows"));
    s.mockInput.pressTab();
    s.mockInput.pressArrow("down");
    s.mockInput.pressArrow("down");
    s.mockInput.pressArrow("right");
    await shoot(s, "tui-local-results");
    s.mockInput.pressArrow("right");
    s.mockInput.pressArrow("right");
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("Esc closes"));
    await shoot(s, "tui-json-detail");
  });

  await session(0, async (s) => {
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("LOCAL") && !f.includes("reading the catalog"));
    s.mockInput.pressKey("i");
    const tail = " from shipment s\njoin carrier c on c.code = s.carrier\nwhere s.";
    await s.mockInput.typeText(`select${tail}`);
    await until(s, (f) => /col\s+status/.test(f));
    await shoot(s, "tui-complete-where");
    s.mockInput.pressEscape();
    s.mockInput.pressKey("a");
    for (let i = 0; i < tail.length; i++) s.mockInput.pressBackspace();
    const rest = " from shipment s\njoin carrier c on c.code = s.carrier";
    await s.mockInput.typeText(rest);
    for (let i = 0; i < rest.length; i++) s.mockInput.pressArrow("left");
    await s.mockInput.typeText(" c.");
    await until(s, (f) => /col\s+name/.test(f));
    await shoot(s, "tui-complete-alias");
  });

  await session(0, async (s) => {
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("LOCAL") && !f.includes("reading the catalog"));
    s.mockInput.pressKey("i");
    await s.mockInput.typeText("select s.id, s.status\nfrom shipment s\nwhere s.carrier = 'maersk'\n  and s.status is not null;");
    await Bun.sleep(50);
    s.mockInput.pressEscape();
    s.mockInput.pressKey("k");
    s.mockInput.pressKey("g");
    s.mockInput.pressKey("h");
    s.mockInput.pressKey("w");
    s.mockInput.pressKey("v");
    s.mockInput.pressKey("f");
    s.mockInput.pressKey("'");
    s.mockInput.pressKey("f");
    s.mockInput.pressKey("'");
    await until(s, (f) => f.includes(" EXT "));
    await shoot(s, "tui-helix-select");
  });

  await session(0, async (s) => {
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("LOCAL") && !f.includes("reading the catalog"));
    s.mockInput.pressKey("i");
    await s.mockInput.typeText("select id, status, carrier, created_at\nfrom shipment\norder by id;");
    s.mockInput.pressEnter({ ctrl: true });
    await until(s, (f) => f.includes("240 rows"));
    s.mockInput.pressEscape();
    s.mockInput.pressKey(" ");
    await until(s, (f) => f.includes("find table"));
    await shoot(s, "tui-menu");
    s.mockInput.pressKey("?");
    await until(s, (f) => f.includes("Keys"));
    await shoot(s, "tui-help");
    s.mockInput.pressEscape();
    s.mockInput.pressKey(" ");
    s.mockInput.pressKey("f");
    await s.mockInput.typeText("car");
    await until(s, (f) => f.includes("Find table"));
    await shoot(s, "tui-find-table");
    s.mockInput.pressEscape();
    s.mockInput.pressTab();
    await s.mockInput.typeText("/mae");
    await until(s, (f) => f.includes("/mae"));
    await shoot(s, "tui-grid-search");
    s.mockInput.pressEnter();
    s.mockInput.pressKey("n");
    s.mockInput.pressKey("n");
    await until(s, (f) => f.includes("3 of 60"));
    await shoot(s, "tui-grid-search-next");
  });

  await session(4, async (s) => {
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("Password for staging-rds"));
    await s.mockInput.typeText("hunter2!");
    await until(s, (f) => f.includes("8 characters"));
    await shoot(s, "tui-password");
  });

  await session(2, async (s) => {
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("TESTING"));
    s.mockInput.pressKey("i");
    await s.mockInput.typeText("select carrier, count(*) from shipment group by 1 order by 2 desc");
    s.mockInput.pressEnter({ ctrl: true });
    await until(s, (f) => f.includes("4 rows"));
    await shoot(s, "tui-testing");
  });

  await session(3, async (s) => {
    s.mockInput.pressEnter();
    await until(s, (f) => f.includes("PRODUCTION"));
    s.mockInput.pressKey("i");
    await s.mockInput.typeText("select nope from shipment");
    s.mockInput.pressEnter({ ctrl: true });
    await until(s, (f) => f.includes("RESULTS  ·  error"));
    await shoot(s, "tui-production-error");
  });
} finally {
  await fixture.teardown();
}
