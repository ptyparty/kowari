import { describe, expect, test } from "bun:test";
import { parseDotenv } from "./dotenv.ts";
import { interpolate } from "./interpolate.ts";

describe("parseDotenv", () => {
  test("reads the forms .env files use", () => {
    const vars = parseDotenv(
      [
        "# a comment",
        "",
        "PLAIN=value",
        "SPACED = spaced value  ",
        "export EXPORTED=yes",
        "TRAILING=value # comment",
        "HASH=abc#def",
        "SINGLE='literal $HOME \\n'",
        'DOUBLE="line\\nbreak \\"quoted\\""',
        'MULTI="first',
        'second"',
        "EMPTY=",
        "not a variable",
      ].join("\n"),
    );
    expect(Object.fromEntries(vars)).toEqual({
      PLAIN: "value",
      SPACED: "spaced value",
      EXPORTED: "yes",
      TRAILING: "value",
      HASH: "abc#def",
      SINGLE: "literal $HOME \\n",
      DOUBLE: 'line\nbreak "quoted"',
      MULTI: "first\nsecond",
      EMPTY: "",
    });
  });
});

describe("interpolate", () => {
  const env: Record<string, string> = { PORT: "5433", EMPTY: "" };
  const lookup = (name: string) => env[name];

  test("fills references", () => {
    expect(interpolate("localhost:${PORT}", lookup)).toEqual({ ok: true, value: "localhost:5433" });
  });

  test("uses defaults for missing and empty variables", () => {
    expect(interpolate("${HOST:-localhost} ${EMPTY:-x}", lookup)).toEqual({ ok: true, value: "localhost x" });
  });

  test("an empty value is set, as in the shell", () => {
    expect(interpolate("[${EMPTY}]", lookup)).toEqual({ ok: true, value: "[]" });
  });

  test("names every missing variable", () => {
    expect(interpolate("${A}${PORT}${B}", lookup)).toEqual({ ok: false, missing: ["A", "B"] });
  });

  test("leaves literals alone", () => {
    expect(interpolate("p@$$word", lookup)).toEqual({ ok: true, value: "p@$$word" });
  });
});
