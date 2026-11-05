import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextSocket, listenForContext, type ContextRequest } from "./context.ts";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tabEnv(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "kowari-context-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { KOMUX_TAB_DIR: dir, KOMUX_PANE_ID: "4" };
}

function komux(path: string) {
  const lines: unknown[] = [];
  let buffer = "";
  let closed = false;
  const connection = Bun.connect({
    unix: path,
    socket: {
      data(_socket, data) {
        buffer += data.toString();
        const parts = buffer.split("\n");
        buffer = parts.pop()!;
        lines.push(...parts.map((line) => JSON.parse(line)));
      },
      close() {
        closed = true;
      },
    },
  });
  return {
    lines,
    closed: () => closed,
    send: async (message: unknown) => void (await connection).write(`${JSON.stringify(message)}\n`),
    close: async () => void (await connection).end(),
  };
}

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100 && !done(); tries++) await Bun.sleep(5);
}

describe("the context socket", () => {
  test("lives in the tab folder under the pane's id", () => {
    expect(contextSocket({ KOMUX_TAB_DIR: "/run/tab", KOMUX_PANE_ID: "4" })).toBe("/run/tab/context/4.sock");
    expect(contextSocket({ KOMUX_TAB_DIR: "/run/tab" })).toBeUndefined();
    expect(contextSocket({})).toBeUndefined();
  });

  test("hands komux what the app attaches after it picks", async () => {
    const env = tabEnv();
    let asked: ContextRequest | undefined;
    const stop = listenForContext((request) => (asked = request), env);
    cleanups.push(stop);
    const client = komux(contextSocket(env)!);
    await client.send({ context: 1 });
    await until(() => asked !== undefined);
    asked!.picking("Pick a block");
    asked!.attach([{ label: "plan.md:3", text: "> ship it" }]);
    await until(client.closed);
    expect(client.lines).toEqual([{ picking: "Pick a block" }, { attach: [{ label: "plan.md:3", text: "> ship it" }] }]);
    expect(asked!.active).toBe(false);
  });

  test("tells the app when komux cancels", async () => {
    const env = tabEnv();
    let cancelled = 0;
    cleanups.push(listenForContext((request) => request.onCancel(() => cancelled++), env));
    const client = komux(contextSocket(env)!);
    await client.send({ context: 1 });
    await client.send({ cancel: true });
    await until(() => cancelled > 0);
    expect(cancelled).toBe(1);
  });

  test("tells the app when komux hangs up", async () => {
    const env = tabEnv();
    let cancelled = 0;
    cleanups.push(listenForContext((request) => request.onCancel(() => cancelled++), env));
    const client = komux(contextSocket(env)!);
    await client.send({ context: 1 });
    await Bun.sleep(10);
    await client.close();
    await until(() => cancelled > 0);
    expect(cancelled).toBe(1);
  });

  test("answers komux's keys question with one line and closes", async () => {
    const env = tabEnv();
    let contexts = 0;
    const groups = [{ name: "Results", commands: [{ label: "search cells", keys: "/", send: "/" }, { label: "move", keys: "hjkl" }] }];
    cleanups.push(listenForContext(() => contexts++, env, () => ({ app: "kowari", groups })));
    const client = komux(contextSocket(env)!);
    await client.send({ keys: 1 });
    await until(client.closed);
    expect(client.lines).toEqual([{ keys: { app: "kowari", groups } }]);
    expect(contexts).toBe(0);
  });

  test("still answers context questions when it lists keys", async () => {
    const env = tabEnv();
    let asked: ContextRequest | undefined;
    cleanups.push(listenForContext((request) => (asked = request), env, () => ({ app: "kowari", groups: [] })));
    const client = komux(contextSocket(env)!);
    await client.send({ context: 1 });
    await until(() => asked !== undefined);
    asked!.none("nothing here");
    await until(client.closed);
    expect(client.lines).toEqual([{ none: "nothing here" }]);
  });

  test("removes the socket when it stops", () => {
    const env = tabEnv();
    const stop = listenForContext(() => {}, env);
    expect(existsSync(contextSocket(env)!)).toBe(true);
    stop();
    expect(existsSync(contextSocket(env)!)).toBe(false);
  });
});
