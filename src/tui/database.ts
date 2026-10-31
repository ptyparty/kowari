import postgres, { type ReservedSql, type Sql } from "postgres";
import { collectRows, type AgentResult, type Cancellable } from "../agent/read-only.ts";
import type { ConnectionParams } from "../connections/resolve.ts";

export type Run = { result: AgentResult; ms: number };

export const humanMaxRows = 1000;

export class Database {
  private running: Cancellable | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly sql: Sql,
    private readonly conn: ReservedSql,
  ) {}

  static async open(params: ConnectionParams): Promise<Database> {
    const sql = postgres({
      ...params,
      password: params.password ?? undefined,
      max: 1,
      onnotice: () => {},
      connect_timeout: 5,
      connection: { application_name: "kowari" },
    });
    try {
      return new Database(sql, await sql.reserve());
    } catch (e) {
      await sql.end({ timeout: 1 });
      throw e;
    }
  }

  get busy(): boolean {
    return this.running !== null;
  }

  run(text: string, maxRows = humanMaxRows): Promise<Run> {
    const next = this.queue.then(() => this.runNow(text, maxRows));
    this.queue = next.catch(() => {});
    return next;
  }

  private async runNow(text: string, maxRows: number): Promise<Run> {
    const started = performance.now();
    try {
      const result = await collectRows(
        this.sql,
        this.conn,
        text,
        { maxRows, maxBytes: Number.POSITIVE_INFINITY },
        (q) => {
          this.running = q;
        },
        "text",
      );
      return { result, ms: performance.now() - started };
    } catch (e) {
      return { result: { kind: "error", message: e instanceof Error ? e.message : String(e) }, ms: performance.now() - started };
    } finally {
      this.running = null;
    }
  }

  cancel(): boolean {
    if (!this.running) return false;
    this.running.cancel();
    return true;
  }

  async close(): Promise<void> {
    this.conn.release();
    await this.sql.end({ timeout: 1 });
  }
}
