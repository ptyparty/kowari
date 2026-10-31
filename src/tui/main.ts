import { createCliRenderer } from "@opentui/core";
import { resolveConnections } from "../connections/resolve.ts";
import { ready } from "../sql/tokens.ts";
import { App } from "./app.ts";

export async function runTui(cwd: string): Promise<number> {
  await ready;
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: false, useKittyKeyboard: {} });
  const done = Promise.withResolvers<void>();
  const signals = ["SIGTERM", "SIGHUP", "SIGINT"] as const;
  const finish = () => done.resolve();
  for (const signal of signals) process.on(signal, finish);
  const app = new App(renderer, { resolve: () => resolveConnections({ cwd }), onQuit: finish });

  try {
    await app.start();
    await done.promise;
    return 0;
  } finally {
    for (const signal of signals) process.off(signal, finish);
    await app.stop().catch(() => {});
    renderer.destroy();
  }
}
