import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres, { type Sql } from "postgres";
import { collectRows } from "../src/agent/read-only.ts";
import { adminUrl } from "./escape/fixture.ts";

const unlimited = { maxRows: 100_000, maxBytes: Number.POSITIVE_INFINITY };

let sql: Sql;

beforeAll(() => {
  sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

const statements = [
  "show all",
  `explain ${Array.from({ length: 150 }, (_, i) => `select ${i}`).join(" union all ")}`,
  "select g from generate_series(1, 250) g",
];

for (const transaction of [false, true]) {
  describe(transaction ? "inside a transaction" : "outside a transaction", () => {
    for (const statement of statements) {
      test(`returns every row of ${statement.split(" ").slice(0, 2).join(" ")}, past the first page`, async () => {
        const conn = await sql.reserve();
        try {
          if (transaction) await conn.unsafe("begin read only", [], { simple: false });
          const expected = await conn.unsafe(statement, [], { simple: false }).values();
          const result = await collectRows(sql, conn, statement, unlimited);
          expect(expected.length).toBeGreaterThan(100);
          expect(result.kind === "rows" && result.rows.length).toBe(expected.length);
          expect(result.kind === "rows" && result.count).toBe(expected.length);
        } finally {
          if (transaction) await conn.unsafe("rollback", [], { simple: false }).catch(() => {});
          conn.release();
        }
      });
    }
  });
}
