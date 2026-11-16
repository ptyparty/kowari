import os from "node:os";
import path from "node:path";
import { appendFile, chmod, mkdir } from "node:fs/promises";

export type HistoryEntry = { sql: string; at: number; connection: string };

export function defaultHistoryPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "kowari", "history.jsonl");
}

export async function loadHistory(file: string): Promise<HistoryEntry[]> {
  const f = Bun.file(file);
  if (!(await f.exists())) return [];
  const latest = new Map<string, HistoryEntry>();
  (await f.text()).split("\n").forEach((line, i) => {
    if (line === "") return;
    const entry = JSON.parse(line);
    if (typeof entry?.sql !== "string" || typeof entry.at !== "number" || typeof entry.connection !== "string") {
      throw new Error(`${file} line ${i + 1} is not a history entry`);
    }
    latest.delete(entry.sql);
    latest.set(entry.sql, { sql: entry.sql, at: entry.at, connection: entry.connection });
  });
  return [...latest.values()];
}

export async function recordHistory(file: string, entry: HistoryEntry): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export function searchHistory(entries: HistoryEntry[], query: string, connection: string | null): HistoryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  return entries
    .filter((e) => {
      const text = e.sql.toLowerCase();
      return words.every((w) => text.includes(w));
    })
    .sort((a, b) => Number(b.connection === connection) - Number(a.connection === connection) || b.at - a.at);
}

export function oneLine(sql: string): string {
  return sql.trim().split(/\s+/).join(" ");
}
