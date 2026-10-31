import { beforeAll, describe, expect, test } from "bun:test";
import { statementAt, statementSpans, statementText } from "./statements.ts";
import { ready, scan } from "./tokens.ts";

beforeAll(() => ready);

function texts(sql: string): string[] {
  return statementSpans(sql).map((s) => statementText(sql, s));
}

describe("statementSpans", () => {
  test("splits on semicolons the scanner sees", () => {
    expect(texts("select 1; select 'a;b' -- c;\n; select $$x;y$$;")).toEqual(["select 1", "select 'a;b'", "select $$x;y$$"]);
  });

  test("keeps a final statement without a semicolon", () => {
    expect(texts("select 1;\n\nselect 2\n")).toEqual(["select 1", "select 2"]);
  });

  test("treats an unterminated tail as one statement", () => {
    expect(texts("select 1;\nselect 'abc\nfrom t;\n")).toEqual(["select 1", "select 'abc\nfrom t;"]);
  });

  test("finds the longest prefix that scans when a multi-line string comes before an unfinished one", () => {
    expect(texts("select 1;\nselect 'a\nb';\nselect 2;\nselect 'x")).toEqual(["select 1", "select 'a\nb'", "select 2", "select 'x"]);
  });

  test("counts characters, not bytes", () => {
    expect(texts("select 'é'; select 2")).toEqual(["select 'é'", "select 2"]);
  });
});

describe("statementAt", () => {
  const sql = "select 1;\n\nselect 2;\nselect 3";

  test("finds the statement under the cursor", () => {
    expect(statementText(sql, statementAt(sql, sql.indexOf("2"))!)).toBe("select 2");
  });

  test("on a blank line, takes the statement before", () => {
    expect(statementText(sql, statementAt(sql, sql.indexOf("\n\n") + 1)!)).toBe("select 1");
  });

  test("with nothing to run, returns null", () => {
    expect(statementAt("  -- just a comment\n", 3)).toBeNull();
  });
});

describe("scan", () => {
  test("classifies tokens", () => {
    const kinds = scan("select a, 'x', 1 -- c\n").tokens.map((t) => `${t.text}:${t.kind}`);
    expect(kinds).toEqual(["select:keyword", "a:identifier", ",:operator", "'x':string", ",:operator", "1:number", "-- c:comment"]);
  });
});
