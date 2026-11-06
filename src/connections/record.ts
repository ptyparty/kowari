import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { replaceFile } from "../replace-file.ts";
import { parseUserConfig, type AgentLevel } from "./config.ts";
import { grantsFor } from "./resolve.ts";
import type { Worktree } from "./worktree.ts";

const staleLockMs = 10_000;

export type LevelTarget = { kind: "repo"; identity: string; name: string } | { kind: "user"; name: string };

export type RecordOutcome = { kind: "recorded" } | { kind: "failed"; reason: string };

export async function recordLevel(configPath: string, target: LevelTarget, level: AgentLevel): Promise<RecordOutcome> {
  const lock = await lockFile(`${configPath}.lock`);
  if (lock === null) return { kind: "failed", reason: `another kowari is changing ${configPath}; try again` };
  try {
    return await recordLevelLocked(configPath, target, level);
  } finally {
    await lock.release();
  }
}

async function recordLevelLocked(configPath: string, target: LevelTarget, level: AgentLevel): Promise<RecordOutcome> {
  const file = Bun.file(configPath);
  const text = (await file.exists()) ? await file.text() : "";
  const already = recordedLevel(text, target);
  if (already !== undefined && already !== level) {
    return { kind: "failed", reason: `your config already gives it ${already}; change that in ${configPath} by hand` };
  }
  const updated = withLevel(text, target, level);
  if (updated === null) {
    return { kind: "failed", reason: `could not find where to add it in ${configPath}; add ${describeLevel(target, level)} by hand` };
  }

  if (updated === text) return { kind: "recorded" };
  try {
    await replaceFile(configPath, updated);
  } catch (e) {
    return { kind: "failed", reason: `could not write ${configPath} (${e instanceof Error ? e.message : String(e)})` };
  }
  return { kind: "recorded" };
}

async function lockFile(file: string): Promise<{ release: () => Promise<void> } | null> {
  await mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await writeFile(file, String(process.pid), { flag: "wx" });
      return { release: () => rm(file, { force: true }) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const age = await stat(file).then((st) => Date.now() - st.mtimeMs, () => 0);
      if (age > staleLockMs) await rm(file, { force: true });
      else await Bun.sleep(100);
    }
  }
  return null;
}

export function describeLevel(target: LevelTarget, level: string): string {
  const section = target.kind === "repo" ? `[repos.${JSON.stringify(target.identity)}]` : `[connections.${tomlKey(target.name)}]`;
  return `${target.kind === "repo" ? tomlKey(target.name) : "agent"} = "${level}" under ${section}`;
}

export function withLevel(text: string, target: LevelTarget, level: AgentLevel): string | null {
  if (recordedLevel(text, target) === level) return text;
  const updated = target.kind === "repo" ? withRepoGrant(text, target.identity, target.name, level) : withConnectionLevel(text, target.name, level);
  if (updated === null) return null;

  const problemsBefore = parseUserConfig(text, "config").problems.length;
  if (parseUserConfig(updated, "config").problems.length > problemsBefore) return null;
  return recordedLevel(updated, target) === level ? updated : null;
}

function recordedLevel(text: string, target: LevelTarget): AgentLevel | undefined {
  const config = parseUserConfig(text, "config").value;
  if (target.kind === "repo") return config.repos.get(target.identity)?.get(target.name)?.agent;
  const connection = config.connections.get(target.name);
  return connection?.agentSet ? connection.agent : undefined;
}

function withRepoGrant(text: string, identity: string, name: string, level: AgentLevel): string | null {
  const line = `${tomlKey(name)} = "${level}"`;
  const header = headerPattern("repos", identity);
  const inserted = insertAfterHeader(text, header, line);
  if (inserted !== null) return inserted;
  const separator = text === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${separator}[repos.${JSON.stringify(identity)}]\n${line}\n`;
}

function withConnectionLevel(text: string, name: string, level: AgentLevel): string | null {
  return insertAfterHeader(text, headerPattern("connections", name), `agent = "${level}"`);
}

function insertAfterHeader(text: string, header: RegExp, line: string): string | null {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => header.test(l));
  if (at < 0) return null;
  lines.splice(at + 1, 0, line);
  return lines.join("\n");
}

function headerPattern(table: string, key: string): RegExp {
  const keyForms = [JSON.stringify(key), `'${key}'`, ...(isBareKey(key) ? [key] : [])].map(escapeRegExp).join("|");
  return new RegExp(`^\\s*\\[\\s*${table}\\s*\\.\\s*(?:${keyForms})\\s*\\]\\s*(?:#.*)?$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tomlKey(key: string): string {
  return isBareKey(key) ? key : JSON.stringify(key);
}

function isBareKey(key: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(key);
}

export type Recording = { kind: "possible"; target: LevelTarget } | { kind: "impossible"; why: string };

export async function recordingFor(
  connection: { source: "user" | "repo"; name: string },
  worktree: Worktree,
  userConfigPath: string,
): Promise<Recording> {
  if (connection.source === "user") return { kind: "possible", target: { kind: "user", name: connection.name } };
  const identity = worktree.identity;
  if (identity === null) return { kind: "impossible", why: "this worktree has no origin remote to record it under" };

  const target = { kind: "repo", identity, name: connection.name } as const;
  const file = Bun.file(userConfigPath);
  const repos = parseUserConfig((await file.exists()) ? await file.text() : "", "config").value.repos;
  const { grants, exact } = grantsFor(repos, worktree);
  if (exact || grants.size === 0) return { kind: "possible", target };
  return {
    kind: "impossible",
    why: `this repo's grants come from an owner wildcard in your config, and a table for this repo alone would replace them; to keep an answer, add it in ${userConfigPath} by hand`,
  };
}
