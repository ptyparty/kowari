import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLink, backupPath, linkState, removeLink, type Link } from "./links.ts";

let dir: string;
let link: Link;

function checkout(name: string, owner: string): string {
  mkdirSync(join(dir, name, "rules"), { recursive: true });
  writeFileSync(join(dir, name, "package.json"), JSON.stringify({ name: owner }));
  writeFileSync(join(dir, name, "rules", "jobs.md"), name);
  return join(dir, name, "rules", "jobs.md");
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "kowari-links-")));
  link = { source: checkout("repo", "kowari"), target: join(dir, "claude", "rules", "jobs.md"), tail: "rules/jobs.md", owner: "kowari" };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("links into a checkout", () => {
  test("a missing link is made, folders and all", () => {
    expect(linkState(link)).toBe("missing");
    expect(applyLink(link)).toBeUndefined();
    expect(linkState(link)).toBe("installed");
    expect(readFileSync(link.target, "utf8")).toBe("repo");
  });

  test("a link into another checkout of the tool, or a dangling one, is repointed", () => {
    mkdirSync(join(dir, "claude", "rules"), { recursive: true });
    symlinkSync(checkout("old", "kowari"), link.target);
    expect(linkState(link)).toBe("outdated");
    applyLink(link);
    expect(readlinkSync(link.target)).toBe(link.source);
    rmSync(link.target);
    symlinkSync(join(dir, "gone", "rules", "jobs.md"), link.target);
    expect(linkState(link)).toBe("outdated");
  });

  test("a link into someone else's folder is kept aside like a file", () => {
    mkdirSync(join(dir, "claude", "rules"), { recursive: true });
    symlinkSync(checkout("dotfiles", "mine"), link.target);
    expect(linkState(link)).toBe("different");
    expect(applyLink(link)).toBe(join(dir, "claude", "kowari-backup", "rules", "jobs.md"));
    expect(removeLink(link)).toBe("restored");
    expect(readFileSync(link.target, "utf8")).toBe("dotfiles");
  });

  test("a different file is kept outside the folder Claude reads, and put back on removal", () => {
    mkdirSync(join(dir, "claude", "rules"), { recursive: true });
    writeFileSync(link.target, "theirs");
    expect(linkState(link)).toBe("different");
    applyLink(link);
    expect(readFileSync(backupPath(link), "utf8")).toBe("theirs");
    expect(readFileSync(link.target, "utf8")).toBe("repo");
    expect(removeLink(link)).toBe("restored");
    expect(readFileSync(link.target, "utf8")).toBe("theirs");
    expect(existsSync(backupPath(link))).toBe(false);
  });

  test("an earlier backup is never overwritten", () => {
    mkdirSync(join(dir, "claude", "rules"), { recursive: true });
    writeFileSync(link.target, "theirs");
    mkdirSync(join(dir, "claude", "kowari-backup", "rules"), { recursive: true });
    writeFileSync(backupPath(link), "older");
    expect(() => applyLink(link)).toThrow("already there");
    expect(readFileSync(link.target, "utf8")).toBe("theirs");
  });

  test("removal takes out its own link and leaves anyone else's", () => {
    applyLink(link);
    expect(removeLink(link)).toBe("removed");
    expect(linkState(link)).toBe("missing");
    symlinkSync(checkout("old", "kowari"), link.target);
    expect(removeLink(link)).toBe("skipped");
    expect(readlinkSync(link.target)).toBe(join(dir, "old", "rules", "jobs.md"));
  });
});
