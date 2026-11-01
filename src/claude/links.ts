import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export type Link = { source: string; target: string; tail: string; owner: string };
export type LinkState = "installed" | "missing" | "outdated" | "different";

export function linkState(link: Link): LinkState {
  if (!present(link.target)) return "missing";
  if (!lstatSync(link.target).isSymbolicLink()) return "different";
  const pointed = resolve(dirname(link.target), readlinkSync(link.target));
  if (samePath(pointed, link.source)) return "installed";
  if (!pointed.endsWith(sep + link.tail)) return "different";
  return !existsSync(pointed) || checkoutOf(pointed.slice(0, -link.tail.length - 1)) === link.owner ? "outdated" : "different";
}

export function backupPath(link: Link): string {
  const folder = dirname(link.target);
  return join(dirname(folder), `${link.owner}-backup`, basename(folder), basename(link.target));
}

export function applyLink(link: Link): string | undefined {
  const state = linkState(link);
  if (state === "installed") return undefined;
  mkdirSync(dirname(link.target), { recursive: true });
  let backup: string | undefined;
  if (state === "outdated") unlinkSync(link.target);
  if (state === "different") {
    backup = backupPath(link);
    if (present(backup)) throw new Error(`${backup} is already there from an earlier setup; move it before setting up ${link.target}`);
    mkdirSync(dirname(backup), { recursive: true });
    renameSync(link.target, backup);
  }
  symlinkSync(link.source, link.target);
  return backup;
}

export type Removal = "removed" | "restored" | "skipped";

export function removeLink(link: Link): Removal {
  if (linkState(link) !== "installed") return "skipped";
  unlinkSync(link.target);
  const backup = backupPath(link);
  if (!present(backup)) return "removed";
  renameSync(backup, link.target);
  return "restored";
}

function checkoutOf(root: string): string | undefined {
  try {
    const name: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  if (!existsSync(a) || !existsSync(b)) return resolve(a) === resolve(b);
  return realpathSync(a) === realpathSync(b);
}
