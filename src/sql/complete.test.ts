import { beforeAll, describe, expect, test } from "bun:test";
import type { Catalog } from "./catalog.ts";
import { complete } from "./complete.ts";
import { ready } from "./tokens.ts";

beforeAll(() => ready);

const catalog: Catalog = {
  searchPath: ["public"],
  schemas: ["public", "audit"],
  tables: [
    { schema: "public", name: "shipment", kind: "table" },
    { schema: "public", name: "shipment_leg", kind: "table" },
    { schema: "public", name: "carrier", kind: "table" },
    { schema: "public", name: "open_shipments", kind: "view" },
    { schema: "audit", name: "event", kind: "table" },
  ],
  columns: [
    { schema: "public", table: "shipment", name: "id", type: "integer" },
    { schema: "public", table: "shipment", name: "status", type: "text" },
    { schema: "public", table: "shipment", name: "carrier_code", type: "text" },
    { schema: "public", table: "carrier", name: "code", type: "text" },
    { schema: "public", table: "carrier", name: "name", type: "text" },
    { schema: "audit", table: "event", name: "happened_at", type: "timestamp with time zone" },
    { schema: "audit", table: "event", name: "Weird Name", type: "text" },
  ],
  functions: [
    { schema: "pg_catalog", name: "count", args: "\"any\"", result: "bigint" },
    { schema: "pg_catalog", name: "coalesce", args: "", result: "" },
  ],
};

function labels(sql: string, kinds?: string[]): string[] {
  const cursor = sql.indexOf("|");
  const text = sql.replace("|", "");
  const result = complete(text, cursor, catalog);
  return (result?.items ?? []).filter((i) => !kinds || kinds.includes(i.kind)).map((i) => i.label);
}

describe("complete", () => {
  test("tables after from, unqualified on the search path, qualified elsewhere", () => {
    expect(labels("select * from |")).toEqual(["carrier", "shipment", "audit.event", "shipment_leg", "open_shipments", "audit"]);
    expect(labels("select * from ship|")).toEqual(["shipment", "shipment_leg", "open_shipments"]);
  });

  test("tables after a join and after a comma in a from list", () => {
    expect(labels("select * from shipment s join car|")).toEqual(["carrier"]);
    expect(labels("select * from shipment s, car|")).toEqual(["carrier"]);
  });

  test("columns of the table an alias names", () => {
    expect(labels("select s.| from shipment s join carrier c on c.code = s.carrier_code")).toEqual(["id", "status", "carrier_code"]);
    expect(labels("select c.n| from shipment s join carrier c on true")).toEqual(["name"]);
  });

  test("columns of every table in scope, with aliases first", () => {
    expect(labels("select st| from shipment s", ["column", "alias"])).toEqual(["status"]);
    expect(labels("select | from shipment s join carrier c on true", ["alias"])).toEqual(["c", "s"]);
    expect(labels("select * from shipment where carr|", ["column"])).toEqual(["carrier_code"]);
  });

  test("tables of a schema after schema.", () => {
    expect(labels("select * from audit.|")).toEqual(["event"]);
  });

  test("quotes names that need it", () => {
    const text = "select e. from audit.event e";
    const result = complete(text, text.indexOf(".") + 1, catalog)!;
    expect(result.items.find((i) => i.label === "Weird Name")?.insert).toBe('"Weird Name"');
  });

  test("functions and keywords outside a from clause", () => {
    expect(labels("select co|", ["function", "keyword"])).toEqual(["count", "coalesce", "commit"]);
    expect(labels("select * from shipment wh|", ["keyword"])).toEqual(["when", "where"]);
  });

  test("replaces the word under the cursor", () => {
    const result = complete("select * from shipm", 19, catalog)!;
    expect([result.from, result.to, result.word]).toEqual([14, 19, "shipm"]);
  });

  test("nothing for numbers", () => {
    expect(complete("select * from shipment where id = 1", 35, catalog)).toBeNull();
  });

  test("nothing inside strings or comments", () => {
    expect(complete("select 'shi", 11, catalog)).toBeNull();
    expect(complete("select 1 -- shi", 15, catalog)).toBeNull();
  });

  test("quotes reserved words", () => {
    const withUser: Catalog = {
      ...catalog,
      tables: [...catalog.tables, { schema: "public", name: "user", kind: "table" }],
      columns: [...catalog.columns, { schema: "public", table: "user", name: "order", type: "integer" }],
    };
    const from = complete("select * from us", 16, withUser)!;
    expect(from.items.find((i) => i.label === "user")?.insert).toBe('"user"');
    const cols = complete('select u. from "user" u', 9, withUser)!;
    expect(cols.items.map((i) => i.insert)).toEqual(['"order"']);
  });

  test("after from schema., a schema wins over a table of the same name", () => {
    const clash: Catalog = { ...catalog, tables: [...catalog.tables, { schema: "public", name: "audit", kind: "table" }] };
    expect(complete("select * from audit.", 20, clash)!.items.map((i) => i.label)).toEqual(["event"]);
  });

  test("from inside an expression is not a table position", () => {
    expect(labels("select * from shipment where status is distinct from st|", ["column"])).toEqual(["status"]);
    expect(labels("select extract(day from ca|) from shipment", ["table"])).toEqual([]);
    expect(labels("select * from shipment for update |", ["table"])).toEqual([]);
    expect(labels("select * from (select * from car|", ["table"])).toEqual(["carrier"]);
  });

  test("uses the statement under the cursor for scope", () => {
    expect(labels("select * from carrier;\nselect s.| from shipment s", ["column"])).toEqual(["id", "status", "carrier_code"]);
  });
});
