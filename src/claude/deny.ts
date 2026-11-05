import { chmod, mkdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultUserConfigPath, repoConfigFile } from "../connections/resolve.ts";

export const keyringDenyRules = [
  "Bash(secret-tool *)",
  "Bash(busctl --user call org.freedesktop.secrets *)",
  "Bash(gdbus call --session --dest org.freedesktop.secrets *)",
  "Bash(dbus-send --session --dest=org.freedesktop.secrets *)",
];

export function configDenyRules(env: Record<string, string | undefined> = process.env): string[] {
  const home = env.HOME || os.homedir();
  const dir = path.dirname(defaultUserConfigPath({ ...env, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME || path.join(home, ".config") }));
  const inside = path.relative(home, dir);
  const user = inside && !inside.startsWith("..") && !path.isAbsolute(inside) ? `~/${inside}` : `/${dir}`;
  return [`Read(${user}/**)`, `Edit(${user}/**)`, `Read(**/${repoConfigFile})`, `Edit(**/${repoConfigFile})`];
}

export function denyRules(env: Record<string, string | undefined> = process.env): string[] {
  return [...keyringDenyRules, ...configDenyRules(env)];
}

export type DenyCheck = { settingsPath: string; missing: string[]; problem: string | null };

export function claudeSettingsPath(env: Record<string, string | undefined> = process.env): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
}

export async function checkDenies(settingsPath = claudeSettingsPath(), rules = denyRules()): Promise<DenyCheck> {
  const read = await readSettings(settingsPath);
  if ("problem" in read) return { settingsPath, missing: rules, problem: read.problem };
  const deny = denyList(read.settings);
  return { settingsPath, missing: rules.filter((rule) => !deny.includes(rule)), problem: null };
}

export async function addDenies(settingsPath = claudeSettingsPath(), rules = denyRules()): Promise<string[]> {
  const read = await readSettings(settingsPath);
  if ("problem" in read) throw new Error(read.problem);
  const settings = read.settings;
  const permissions = isObject(settings.permissions) ? settings.permissions : {};
  const deny = Array.isArray(permissions.deny) ? [...permissions.deny] : [];
  const added = rules.filter((rule) => !deny.includes(rule));
  if (added.length === 0) return [];
  const updated = { ...settings, permissions: { ...permissions, deny: [...deny, ...added] } };
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const target = await realpath(settingsPath).catch(() => settingsPath);
  const mode = await stat(target).then((st) => st.mode & 0o777, () => 0o600);
  const temp = `${target}.kowari-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(updated, null, 2)}\n`, { mode });
  await chmod(temp, mode);
  await rename(temp, target);
  return added;
}

async function readSettings(settingsPath: string): Promise<{ settings: Record<string, unknown> } | { problem: string }> {
  const file = Bun.file(settingsPath);
  if (!(await file.exists())) return { settings: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (e) {
    return { problem: `${settingsPath} is not valid JSON (${e instanceof Error ? e.message : String(e)}); fix it by hand` };
  }
  return isObject(parsed) ? { settings: parsed } : { problem: `${settingsPath} is not a JSON object; fix it by hand` };
}

function denyList(settings: Record<string, unknown>): string[] {
  const permissions = settings.permissions;
  if (!isObject(permissions) || !Array.isArray(permissions.deny)) return [];
  return permissions.deny.filter((rule): rule is string => typeof rule === "string");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
