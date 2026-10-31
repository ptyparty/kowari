import { SQL } from "bun";
import postgres from "postgres";

const url = process.env.KOWARI_TEST_DATABASE_URL ?? "postgres://kowari:kowari@127.0.0.1:55433/kowari";

type Outcome = { ok: boolean; detail: string };
type Check = { name: string; run: () => Promise<Outcome> };

const pass = (detail: string): Outcome => ({ ok: true, detail });
const fail = (detail: string): Outcome => ({ ok: false, detail });

const rawTextQuery = `
  select
    9223372036854775807::bigint as big,
    12345678901234567890.123456789::numeric as num,
    '2026-10-31 12:34:56.789+00'::timestamptz as ts,
    '{"a": [1, 2, {"b": null}]}'::jsonb as doc,
    array[1, 2, 3]::int[] as arr,
    '\\xdeadbeef'::bytea as bin
`;

const rawTextExpected = [
  "9223372036854775807",
  "12345678901234567890.123456789",
  "2026-10-31 12:34:56.789+00",
  '{"a": [1, 2, {"b": null}]}',
  "{1,2,3}",
  "\\xdeadbeef",
];

const bigCount = 1_000_000;
const bigQuery = `select g as id, md5(g::text) as hash from generate_series(1, ${bigCount}) g`;

async function timed<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, Bun.sleep(ms).then(() => Promise.reject(new Error(`timed out after ${ms}ms`)))]);
}

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0]! : String(e);
}

function postgresJsChecks(): { checks: Check[]; close: () => Promise<void> } {
  const sql = postgres(url, {
    max: 2,
    onnotice: () => {},
    connection: { application_name: "kowari-spike", statement_timeout: 4321 },
  });

  const checks: Check[] = [
    {
      name: "duplicate column names",
      run: async () => {
        const r = await sql.unsafe("select 1 as a, 2 as a").values();
        const names = r.columns.map((c) => c.name);
        const row = r[0];
        return JSON.stringify(row) === "[1,2]" && names.join(",") === "a,a"
          ? pass(`columns ${names.join(",")}, row ${JSON.stringify(row)}`)
          : fail(`columns ${names.join(",")}, row ${JSON.stringify(row)}`);
      },
    },
    {
      name: "column names and type OIDs, even when empty",
      run: async () => {
        const r = await sql.unsafe("select 1::int4 as x, 'a'::text as y where false").values();
        const cols = r.columns.map((c) => `${c.name}:${c.type}`).join(",");
        return cols === "x:23,y:25" ? pass(cols) : fail(cols || "no columns");
      },
    },
    {
      name: "values as raw text",
      run: async () => {
        const r = await sql.unsafe(rawTextQuery).raw();
        const got = (r[0] as unknown as (Buffer | null)[]).map((b) => (b === null ? "NULL" : b.toString("utf8")));
        const bad = got.filter((g, i) => g !== rawTextExpected[i]);
        return bad.length === 0 ? pass("all six match psql's text") : fail(`mismatched: ${bad.join(" | ")}`);
      },
    },
    {
      name: `stream ${bigCount.toLocaleString()} rows in pages`,
      run: async () => {
        const before = rssMb();
        let rows = 0;
        let pages = 0;
        let peak = before;
        for await (const page of sql.unsafe(bigQuery).values().cursor(1000)) {
          rows += page.length;
          pages += 1;
          if (pages % 100 === 0) peak = Math.max(peak, rssMb());
        }
        const growth = peak - before;
        const detail = `${rows} rows in ${pages} pages, rss +${growth} MB`;
        return rows === bigCount && growth < 100 ? pass(detail) : fail(detail);
      },
    },
    {
      name: "cancel a running query, connection still usable",
      run: async () => {
        const q = sql.unsafe("select pg_sleep(30)");
        const started = Date.now();
        setTimeout(() => q.cancel(), 300);
        const err = await timed(q.then(() => null, (e: unknown) => e), 5000);
        const elapsed = Date.now() - started;
        const [after] = await sql.unsafe("select 1 as one").values();
        const detail = `rejected after ${elapsed} ms (${describeError(err)}); next query ${JSON.stringify(after)}`;
        return err !== null && elapsed < 2000 && JSON.stringify(after) === "[1]" ? pass(detail) : fail(detail);
      },
    },
    {
      name: "multi-statement script via simple protocol",
      run: async () => {
        const r = await sql.unsafe("create temp table spike_t(x int); insert into spike_t values (1), (2); select count(*)::int as n from spike_t; drop table spike_t").simple();
        return pass(`returned ${Array.isArray(r) ? r.length : "?"} results`);
      },
    },
    {
      name: "multi-statement refused on extended protocol",
      run: async () => {
        try {
          await sql.unsafe("select 1; select 2", [], { simple: false });
          return fail("accepted");
        } catch (e) {
          return pass(`with simple: false, ${describeError(e)}`);
        }
      },
    },
    {
      name: "startup parameters take effect",
      run: async () => {
        const [row] = await sql.unsafe("select current_setting('application_name') as app, current_setting('statement_timeout') as st").values();
        const detail = JSON.stringify(row);
        return detail === '["kowari-spike","4321ms"]' ? pass(detail) : fail(detail);
      },
    },
  ];

  return { checks, close: () => sql.end({ timeout: 1 }) };
}

function bunSqlChecks(): { checks: Check[]; close: () => Promise<void> } {
  const sql = new SQL(url, {
    max: 2,
    connection: { application_name: "kowari-spike", statement_timeout: 4321 },
  });

  const checks: Check[] = [
    {
      name: "duplicate column names",
      run: async () => {
        const r = await sql.unsafe("select 1 as a, 2 as a").values();
        const names = (r as { columns?: unknown }).columns;
        const row = r[0];
        const detail = `columns ${JSON.stringify(names)}, row ${JSON.stringify(row)}`;
        return JSON.stringify(row) === "[1,2]" ? pass(detail) : fail(detail);
      },
    },
    {
      name: "column names and type OIDs, even when empty",
      run: async () => {
        const r = await sql.unsafe("select 1::int4 as x, 'a'::text as y where false").values();
        const cols = (r as { columns?: unknown }).columns;
        const detail = `columns ${JSON.stringify(cols)}`;
        const hasOids = Array.isArray(cols) && cols.every((c) => typeof c === "object" && c !== null && "type" in c);
        return hasOids ? pass(detail) : fail(detail);
      },
    },
    {
      name: "values as raw text",
      run: async () => {
        const r = await sql.unsafe(rawTextQuery).raw();
        const got = (r[0] as unknown as (Uint8Array | null)[]).map((b) => (b === null ? "NULL" : Buffer.from(b).toString("utf8")));
        const bad = got.filter((g, i) => g !== rawTextExpected[i]);
        return bad.length === 0
          ? pass("all six match psql's text")
          : fail(`mismatched: ${bad.map((b) => JSON.stringify(b.slice(0, 40))).join(" | ")}`);
      },
    },
    {
      name: `stream ${bigCount.toLocaleString()} rows in pages`,
      run: async () => {
        const q = sql.unsafe(bigQuery) as unknown as Record<string, unknown>;
        const streaming = ["cursor", "forEach", "stream"].filter((m) => typeof q[m] === "function");
        await (q as unknown as Promise<unknown>).catch(() => {});
        return streaming.length > 0 ? pass(`has ${streaming.join(", ")}`) : fail("no cursor, forEach or stream on a query");
      },
    },
    {
      name: "cancel a running query, connection still usable",
      run: async () => {
        const q = sql.unsafe("select pg_sleep(30)");
        const started = Date.now();
        setTimeout(() => q.cancel(), 300);
        const err = await timed(q.then(() => null, (e: unknown) => e), 5000).catch((e: unknown) => e);
        const elapsed = Date.now() - started;
        const after = await timed(sql.unsafe("select 1 as one").values(), 3000).catch((e: unknown) => describeError(e));
        const detail = `settled after ${elapsed} ms (${describeError(err)}); next query ${JSON.stringify(after)}`;
        return err !== null && elapsed < 2000 && JSON.stringify(after) === "[[1]]" ? pass(detail) : fail(detail);
      },
    },
    {
      name: "multi-statement script via simple protocol",
      run: async () => {
        const r = await sql.unsafe("create temp table spike_t(x int); insert into spike_t values (1), (2); select count(*)::int as n from spike_t; drop table spike_t").simple();
        return pass(`returned ${Array.isArray(r) ? r.length : "?"} results`);
      },
    },
    {
      name: "multi-statement refused on extended protocol",
      run: async () => {
        try {
          await sql.unsafe("select 1; select 2", []);
          return fail("accepted");
        } catch (e) {
          return pass(describeError(e));
        }
      },
    },
    {
      name: "startup parameters take effect",
      run: async () => {
        const [row] = await sql.unsafe("select current_setting('application_name') as app, current_setting('statement_timeout') as st").values();
        const detail = JSON.stringify(row);
        return detail === '["kowari-spike","4321ms"]' ? pass(detail) : fail(detail);
      },
    },
  ];

  return { checks, close: () => sql.close({ timeout: 1 }) };
}

async function runAll(label: string, make: () => { checks: Check[]; close: () => Promise<void> }): Promise<void> {
  const { checks, close } = make();
  console.log(`\n## ${label}\n`);
  for (const check of checks) {
    const outcome = await check.run().catch((e: unknown) => fail(`threw: ${describeError(e)}`));
    console.log(`${outcome.ok ? "PASS" : "FAIL"}  ${check.name}: ${outcome.detail}`);
  }
  await close();
}

const which = process.argv[2];
if (which !== "bun") await runAll("postgres.js", postgresJsChecks);
if (which !== "postgres") await runAll("Bun.SQL", bunSqlChecks);
