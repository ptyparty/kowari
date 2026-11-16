import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultHistoryPath, loadHistory, oneLine, recordHistory, searchHistory, type HistoryEntry } from "./history.ts";

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "kowari-history-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("history", () => {
  test("lives under XDG_STATE_HOME, else ~/.local/state", () => {
    expect(defaultHistoryPath({ XDG_STATE_HOME: "/state" })).toBe("/state/kowari/history.jsonl");
    expect(defaultHistoryPath({})).toBe(path.join(os.homedir(), ".local", "state", "kowari", "history.jsonl"));
  });

  test("a missing file is an empty history, and a line that does not read is an error", async () => {
    const file = path.join(scratch, "mixed.jsonl");
    expect(await loadHistory(file)).toEqual([]);
    await writeFile(file, `{"sql":"select 1","at":1,"connection":"local"}\n\n`);
    expect(await loadHistory(file)).toEqual([{ sql: "select 1", at: 1, connection: "local" }]);
    await writeFile(file, `{"sql":"select 1","at":1,"connection":"local"}\nnot json\n`);
    expect(loadHistory(file)).rejects.toThrow();
    await writeFile(file, `{"sql":2}\n`);
    expect(loadHistory(file)).rejects.toThrow(`${file} line 1 is not a history entry`);
  });

  test("keeps each query once, at its last run, oldest first, readable only by you", async () => {
    const file = path.join(scratch, "nested", "history.jsonl");
    await recordHistory(file, { sql: "select 1", at: 1, connection: "local" });
    await recordHistory(file, { sql: "select 2", at: 2, connection: "local" });
    await recordHistory(file, { sql: "select 1", at: 3, connection: "staging" });
    expect(await loadHistory(file)).toEqual([
      { sql: "select 2", at: 2, connection: "local" },
      { sql: "select 1", at: 3, connection: "staging" },
    ]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("search matches every word in any order, the current connection's first, newest first", () => {
    const entries: HistoryEntry[] = [
      { sql: "select * from shipment", at: 1, connection: "local" },
      { sql: "select id\nfrom Shipment where status = 'booked'", at: 2, connection: "staging" },
      { sql: "select * from invoice", at: 3, connection: "local" },
      { sql: "select status from shipment", at: 4, connection: "staging" },
    ];
    const sqls = (query: string, connection: string | null) => searchHistory(entries, query, connection).map((e) => e.at);
    expect(sqls("", null)).toEqual([4, 3, 2, 1]);
    expect(sqls("", "local")).toEqual([3, 1, 4, 2]);
    expect(sqls("SHIPMENT status", "local")).toEqual([4, 2]);
    expect(sqls("nothing", "local")).toEqual([]);
  });

  test("shows a query on one line", () => {
    expect(oneLine("  select id\n\tfrom  shipment\n")).toBe("select id from shipment");
  });
});
