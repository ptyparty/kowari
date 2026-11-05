import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { denyRules } from "./deny.ts";
import { setupCommand, setupItems } from "./setup.ts";

let dir: string;
let config: string;
let root: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "kowari-setup-")));
  config = join(dir, "claude");
  root = join(dir, "kowari");
  mkdirSync(join(root, "skills", "kowari"), { recursive: true });
  writeFileSync(join(root, "skills", "kowari", "SKILL.md"), "skill");
  spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("kowari setup", () => {
  test("links the skill and adds the deny rules, and removal keeps the deny rules", async () => {
    expect((await setupItems(config, root)).map((item) => [item.label, item.state])).toEqual([
      ["skill kowari", "missing"],
      ["deny rules", "missing"],
    ]);
    expect(await setupCommand(["--yes"], config, root)).toBe(0);
    expect((await setupItems(config, root)).map((item) => item.state)).toEqual(["installed", "installed"]);
    expect(readFileSync(join(config, "skills", "kowari", "SKILL.md"), "utf8")).toBe("skill");
    expect(await setupCommand(["--remove"], config, root)).toBe(0);
    expect(existsSync(join(config, "skills", "kowari"))).toBe(false);
    expect(JSON.parse(readFileSync(join(config, "settings.json"), "utf8")).permissions.deny).toEqual(denyRules());
  });

  test("some deny rules missing reads as out of date", async () => {
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "settings.json"), JSON.stringify({ permissions: { deny: [denyRules()[0]] } }));
    expect((await setupItems(config, root)).at(-1)?.state).toBe("outdated");
  });
});
