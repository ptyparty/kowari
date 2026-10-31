import { describe, expect, test } from "bun:test";
import { gateStatement } from "./gate.ts";

describe("gateStatement", () => {
  const allowed = [
    "select 1",
    "select * from victim where id = 1",
    "with x as (select 1) select * from x",
    "table victim",
    "values (1), (2)",
    "explain select * from victim",
    "explain analyze select * from victim",
    "show statement_timeout",
    "select jsonb_pretty('{}'::jsonb)",
  ];

  for (const text of allowed) {
    test(`allows ${text}`, async () => {
      expect(await gateStatement(text)).toEqual({ ok: true });
    });
  }

  const refused: [string, string][] = [
    ["select 1; select 2", "exactly one statement"],
    ["", "empty"],
    ["selec 1", "does not parse"],
    ["insert into t values (1)", "INSERT"],
    ["with d as (delete from t returning *) select * from d", "DELETE"],
    ["explain analyze update t set a = 1", "UPDATE"],
    ["explain analyze create table t2 as select 1", "EXPLAIN of CREATE TABLE AS"],
    ["select query_to_xml('select pg_advisory_lock(1)', true, false, '')", "query_to_xml()"],
    ["select cursor_to_xml('c', 1, true, false, '')", "cursor_to_xml()"],
    ["select * into t2 from t", "SELECT INTO"],
    ["select * from t for update", "row locking"],
    ["select dblink_exec('x', 'y')", "dblink_exec()"],
    ["select public.DBLINK('x', 'y')", "dblink()"],
    ["select pg_advisory_lock(1)", "pg_advisory_lock()"],
    ["select nextval('s')", "nextval()"],
    ["select set_config('a', 'b', false)", "set_config()"],
    ["set transaction read write", "VARIABLE SET"],
    ["begin", "TRANSACTION"],
    ["do $$ begin end $$", "DO"],
    ["copy t to stdout", "COPY"],
  ];

  for (const [text, reason] of refused) {
    test(`refuses ${text || "empty input"}`, async () => {
      const verdict = await gateStatement(text);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain(reason);
    });
  }
});
