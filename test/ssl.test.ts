import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConnectionParams } from "../src/connections/resolve.ts";
import type { SslMode } from "../src/connections/ssl.ts";
import { Database } from "../src/tui/database.ts";
import { adminUrl } from "./escape/fixture.ts";

const u = new URL(adminUrl);
let scratch: string;
let serverCert: string | null = null;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "kowari-ssl-"));
  const copy = Bun.spawn(["docker", "cp", "kowari-test-pg:/etc/ssl/certs/ssl-cert-snakeoil.pem", path.join(scratch, "server.pem")], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await copy.exited) === 0) serverCert = path.join(scratch, "server.pem");
});

async function serverHasTls(): Promise<void> {
  const db = await Database.open(params("disable"));
  try {
    const run = await db.run("show ssl");
    const on = run.result.kind === "rows" && run.result.rows[0]?.[0] === "on";
    if (!on) throw new Error("the test database has ssl off; restart it with scripts/test-db");
  } finally {
    await db.close();
  }
}

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function params(sslmode: SslMode, sslrootcert: string | null = null): ConnectionParams {
  return { host: u.hostname, port: Number(u.port), database: u.pathname.slice(1), user: u.username, password: u.password, sslmode, sslrootcert };
}

async function encrypted(p: ConnectionParams): Promise<boolean | string> {
  let db: Database;
  try {
    db = await Database.open(p);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  try {
    const run = await db.run("select ssl from pg_stat_ssl where pid = pg_backend_pid()");
    if (run.result.kind !== "rows") return run.result.kind === "error" ? run.result.message : run.result.reason;
    return run.result.rows[0]?.[0] === "t";
  } finally {
    await db.close();
  }
}

describe("sslmode against a server with TLS on", () => {
  beforeAll(serverHasTls);

  test("disable connects in the clear", async () => {
    expect(await encrypted(params("disable"))).toBe(false);
  });

  test("prefer and require encrypt", async () => {
    expect(await encrypted(params("prefer"))).toBe(true);
    expect(await encrypted(params("require"))).toBe(true);
  });

  test("verify-full refuses a certificate it cannot trust", async () => {
    expect(await encrypted(params("verify-full"))).toMatch(/self.signed|certificate/i);
  });

  test("require with an sslrootcert verifies the chain, like libpq", async () => {
    expect(await encrypted(params("require", path.join(scratch, "missing.pem")))).toMatch(/ENOENT|no such file/i);
  });

  test("a directory is not a CA file", async () => {
    expect(await encrypted(params("verify-full", scratch))).toMatch(/not a file/);
  });

  test("with the server's certificate as sslrootcert, verify-ca connects and verify-full checks the host name", async () => {
    if (!serverCert) throw new Error("could not copy the server certificate out of kowari-test-pg; these tests need scripts/test-db");
    expect(await encrypted(params("verify-ca", serverCert))).toBe(true);
    expect(await encrypted(params("verify-full", serverCert))).toMatch(/host|altname|match/i);
  });
});
