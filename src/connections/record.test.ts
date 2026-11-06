import { describe, expect, test } from "bun:test";
import { withLevel } from "./record.ts";

const repo = { kind: "repo", identity: "github.com/example/app", name: "local" } as const;

describe("withLevel", () => {
  test("starts a config file with the repo's grant", () => {
    expect(withLevel("", repo, "read-only")).toBe('[repos."github.com/example/app"]\nlocal = "read-only"\n');
  });

  test("adds to the repo's existing grants, keeping comments", () => {
    const text = `# mine\n[repos.'github.com/example/app'] # the app\nother = "write"\n\n[local]\nhosts = ["db"]\n`;
    expect(withLevel(text, repo, "write")).toBe(
      `# mine\n[repos.'github.com/example/app'] # the app\nlocal = "write"\nother = "write"\n\n[local]\nhosts = ["db"]\n`,
    );
  });

  test("appends a table for a repo with no grants yet", () => {
    const text = `[repos."github.com/example/other"]\nlocal = "write"`;
    expect(withLevel(text, repo, "none")).toBe(`${text}\n\n[repos."github.com/example/app"]\nlocal = "none"\n`);
  });

  test("quotes a connection name that is not a bare key", () => {
    expect(withLevel("", { ...repo, name: "local db" }, "read-only")).toBe(
      '[repos."github.com/example/app"]\n"local db" = "read-only"\n',
    );
  });

  test("sets the level on a connection from your config", () => {
    const text = `[connections.shared]\nhost = "localhost"\n`;
    expect(withLevel(text, { kind: "user", name: "shared" }, "read-only")).toBe(
      `[connections.shared]\nagent = "read-only"\nhost = "localhost"\n`,
    );
  });


  test("leaves the file alone when it already says so", () => {
    const text = `[repos."github.com/example/app"]\nlocal = "write"\n`;
    expect(withLevel(text, repo, "write")).toBe(text);
  });

  test("finds a table whose key needs escaping", () => {
    const text = `[connections."a\\"b"]\nhost = "localhost"\n`;
    expect(withLevel(text, { kind: "user", name: 'a"b' }, "read-only")).toBe(
      `[connections."a\\"b"]\nagent = "read-only"\nhost = "localhost"\n`,
    );
  });

  test("gives up rather than writing a config that would not say what was chosen", () => {
    expect(withLevel(`connections = { shared = { host = "localhost" } }\n`, { kind: "user", name: "shared" }, "write")).toBeNull();
    expect(withLevel(`[repos]\n"github.com/example/app" = { other = "write" }\n`, repo, "write")).toBeNull();
  });
});
