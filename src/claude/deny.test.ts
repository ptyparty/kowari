import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addDenies, checkDenies, configDenyRules, denyRules } from "./deny.ts";

const rules = denyRules();

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "kowari-deny-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("deny rules", () => {
  test("keep Claude from reading or editing kowari's config, written relative to home when it lives there", () => {
    const repo = ["Read(**/.kowari.toml)", "Edit(**/.kowari.toml)"];
    expect(configDenyRules({ HOME: "/home/u" })).toEqual(["Read(~/.config/kowari/**)", "Edit(~/.config/kowari/**)", ...repo]);
    expect(configDenyRules({ HOME: "/home/u", XDG_CONFIG_HOME: "/home/u/cfg" })).toEqual(["Read(~/cfg/kowari/**)", "Edit(~/cfg/kowari/**)", ...repo]);
    expect(configDenyRules({ HOME: "/home/u", XDG_CONFIG_HOME: "/etc/xdg" })).toEqual(["Read(//etc/xdg/kowari/**)", "Edit(//etc/xdg/kowari/**)", ...repo]);
  });

  test("a missing settings file lacks every rule, and adding creates it", async () => {
    const file = path.join(dir, "fresh", "settings.json");
    expect((await checkDenies(file)).missing).toEqual(rules);
    expect(await addDenies(file)).toEqual(rules);
    expect((await checkDenies(file)).missing).toEqual([]);
  });

  test("adds only what is missing and keeps everything else", async () => {
    const file = path.join(dir, "existing.json");
    const before = {
      model: "opus",
      permissions: { allow: ["Bash(git *)"], deny: ["Bash(rm -rf *)", "Bash(secret-tool *)"] },
      hooks: { Stop: [] },
    };
    await writeFile(file, JSON.stringify(before));
    const added = await addDenies(file);
    expect(added).toEqual(rules.slice(1));
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.model).toBe("opus");
    expect(after.hooks).toEqual({ Stop: [] });
    expect(after.permissions.allow).toEqual(["Bash(git *)"]);
    expect(after.permissions.deny).toEqual(["Bash(rm -rf *)", ...rules]);
    expect(await addDenies(file)).toEqual([]);
  });

  test("writes through a symlink and keeps the file's mode", async () => {
    const real = path.join(dir, "dotfiles-settings.json");
    const link = path.join(dir, "linked-settings.json");
    await writeFile(real, "{}");
    await chmod(real, 0o600);
    await symlink(real, link);
    await addDenies(link);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect((await stat(real)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(real, "utf8")).permissions.deny).toEqual(rules);
  });

  test("refuses to touch a settings file it cannot parse", async () => {
    const file = path.join(dir, "broken.json");
    await writeFile(file, "{ not json");
    const check = await checkDenies(file);
    expect(check.problem).toContain("is not valid JSON");
    await expect(addDenies(file)).rejects.toThrow("is not valid JSON");
    expect(await readFile(file, "utf8")).toBe("{ not json");
  });
});
