import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { addKeyringDenies, checkKeyringDenies, keyringDenyRules } from "./deny.ts";
import { applyLink, backupPath, linkState, removeLink, type Link, type LinkState } from "./links.ts";

type State = LinkState;
type Item = { label: string; state: State; detail: string; apply(): Promise<string>; remove(): Promise<string | undefined> };

const repoRoot = path.join(import.meta.dir, "..", "..");
const marks: Record<State, string> = { installed: "✓", missing: "✗", outdated: "↻", different: "!" };

export const setupUsage = `Usage: kowari setup [--yes|--remove]
  Lists what kowari adds to Claude Code's config: its skill, and the deny rules
  that keep keyring tools away from Claude. --yes sets up what is missing, and
  --remove takes the skill out again.`;

export async function setupItems(configDir = claudeConfigDir(), root = repoRoot): Promise<Item[]> {
  const skills = readdirSync(path.join(root, "skills"))
    .sort()
    .map((name): Item => {
      const link = { source: path.join(root, "skills", name), target: path.join(configDir, "skills", name), tail: path.join("skills", name), owner: "kowari" };
      const state = linkState(link);
      return {
        label: `skill ${name}`,
        state,
        detail: describeLink(state, link),
        apply: async () => {
          const backup = applyLink(link);
          return backup ? `linked, keeping the old one as ${backup}` : "linked";
        },
        remove: async () => {
          const outcome = removeLink(link);
          return outcome === "skipped" ? undefined : outcome === "restored" ? "removed, and put back what it replaced" : "removed";
        },
      };
    });
  return [...skills, await denyItem(path.join(configDir, "settings.json"))];
}

async function denyItem(settingsPath: string): Promise<Item> {
  const check = await checkKeyringDenies(settingsPath);
  const state: State = check.problem ? "different" : check.missing.length === 0 ? "installed" : check.missing.length < keyringDenyRules.length ? "outdated" : "missing";
  return {
    label: "keyring deny rules",
    state,
    detail: check.problem ?? (state === "installed" ? "in settings.json" : `${check.missing.length} missing from settings.json`),
    apply: async () => {
      if (check.problem) throw new Error(check.problem);
      const added = await addKeyringDenies(settingsPath);
      return `added ${added.length} to settings.json`;
    },
    remove: async () => (state === "installed" || state === "outdated" ? "kept; they keep keyring tools away from Claude, so remove them by hand" : undefined),
  };
}

export async function setupCommand(args: string[], configDir = claudeConfigDir(), root = repoRoot): Promise<number> {
  const [flag, ...extra] = args;
  if (extra.length > 0 || (flag !== undefined && flag !== "--yes" && flag !== "--remove")) {
    console.error(setupUsage);
    return 2;
  }
  const items = await setupItems(configDir, root);
  const width = Math.max(...items.map((item) => item.label.length));
  if (flag === "--remove") {
    for (const item of items) {
      const outcome = await item.remove();
      if (outcome) console.log(`  ${item.label.padEnd(width)}  ${outcome}`);
    }
    return 0;
  }
  const needed = items.filter((item) => item.state !== "installed");
  if (flag === "--yes") {
    if (needed.length === 0) console.log("Nothing to set up.");
    let failed = false;
    for (const item of needed) {
      const outcome = await item.apply().then(
        (done) => `${marks.installed} ${item.label.padEnd(width)}  ${done}`,
        (error: Error) => ((failed = true), `${marks.missing} ${item.label.padEnd(width)}  ${error.message}`),
      );
      console.log(`  ${outcome}`);
    }
    return failed ? 1 : 0;
  }
  console.log(`Claude Code setup for kowari, in ${configDir}:\n`);
  for (const item of items) console.log(`  ${marks[item.state]} ${item.label.padEnd(width)}  ${item.detail}`);
  if (needed.length > 0) console.log(`\nRun \`kowari setup --yes\` to set up the ${needed.length} not marked ✓.`);
  return 0;
}

function describeLink(state: State, link: Link): string {
  if (state === "installed") return "linked";
  if (state === "missing") return "missing";
  if (state === "outdated") return "links to another kowari checkout";
  return `something else is there; it would be kept as ${backupPath(link)}`;
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}
