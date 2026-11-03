import { describe, expect, test } from "bun:test";
import { kowariContext } from "./context.ts";

const rerun = "kowari attaches no values from results; `kowari query dev` runs SQL on this connection where Claude's access allows.";

describe("kowariContext", () => {
  test("quotes the SQL and names the connection", () => {
    expect(kowariContext({ kind: "sql", connection: "dev", sql: "select *\n  from shipment\n" })).toEqual({
      label: 'dev · "select * from shipment"',
      text: `SQL in kowari on connection dev:\n\`\`\`sql\nselect *\n  from shipment\n\`\`\`\n${rerun}\n`,
    });
  });

  test("names where a result is without its value", () => {
    expect(kowariContext({ kind: "results", connection: "dev", sql: "select status from shipment", row: 3, column: "status", table: "public.shipment" })).toEqual({
      label: "dev · row 3, status",
      text: `Results in kowari on connection dev, row 3, column "status" of public.shipment, from:\n\`\`\`sql\nselect status from shipment\n\`\`\`\n${rerun}\n`,
    });
    expect(kowariContext({ kind: "results", connection: "dev", sql: "select 1 as one", row: 1, column: "one", table: null }).text).toStartWith('Results in kowari on connection dev, row 1, column "one", from:');
  });

  test("names a table from the list", () => {
    expect(kowariContext({ kind: "table", connection: "dev", table: "audit.event" })).toEqual({
      label: "dev · audit.event",
      text: `Table audit.event in kowari on connection dev.\n${rerun}\n`,
    });
  });

  test("cuts long SQL short in the label and fences SQL that holds backticks", () => {
    const context = kowariContext({ kind: "sql", connection: "dev", sql: "select 'a ``` b' from a_very_long_table_name" });
    expect(context.label).toBe('dev · "select \'a ``` b\' from a_ver…"');
    expect(context.text).toContain("````sql\n");
  });
});
