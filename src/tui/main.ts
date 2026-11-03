import { createCliRenderer } from "@opentui/core";
import { resolveConnections } from "../connections/resolve.ts";
import { ready } from "../sql/tokens.ts";
import { listenForContext } from "../context.ts";
import { App } from "./app.ts";

export async function runTui(cwd: string): Promise<number> {
  await ready;
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: false, useKittyKeyboard: {} });
  const done = Promise.withResolvers<void>();
  const signals = ["SIGTERM", "SIGHUP", "SIGINT"] as const;
  const finish = () => done.resolve();
  for (const signal of signals) process.on(signal, finish);
  const app = new App(renderer, { resolve: () => resolveConnections({ cwd }), onQuit: finish });
  const stopContext = listenForContext((request) => {
    const context = app.context();
    if (typeof context === "string") request.none(context);
    else request.attach([context]);
  });

  try {
    await app.start();
    await done.promise;
    return 0;
  } finally {
    for (const signal of signals) process.off(signal, finish);
    stopContext();
    await app.stop().catch(() => {});
    renderer.destroy();
  }
}
