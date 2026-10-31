import type { ConnectionParams } from "./resolve.ts";

export type KeyringState = "unlocked" | "locked" | "unavailable";

export type Keyring = {
  state: () => Promise<KeyringState>;
  get: (key: string) => Promise<string | null>;
  set: (key: string, password: string) => Promise<void>;
  forget: (key: string) => Promise<void>;
};

const service = "kowari";

export function keyringKey(params: Pick<ConnectionParams, "user" | "host" | "port" | "database">): string {
  return `${params.user}@${params.host}:${params.port}/${params.database}`;
}

export const systemKeyring: Keyring = {
  state: systemState,
  get: async (key) => {
    if ((await systemState()) !== "unlocked") return null;
    return (await Bun.secrets.get({ service, name: key })) ?? null;
  },
  set: async (key, password) => {
    if ((await systemState()) !== "unlocked") throw new Error("the keyring is locked or not running");
    await Bun.secrets.set({ service, name: key, value: password });
  },
  forget: async (key) => {
    if ((await systemState()) !== "unlocked") throw new Error("the keyring is locked or not running");
    await Bun.secrets.delete({ service, name: key });
  },
};

let cachedState: { state: KeyringState; at: number } | null = null;

async function systemState(): Promise<KeyringState> {
  if (cachedState && Date.now() - cachedState.at < 2000) return cachedState.state;
  const state = await queryState();
  cachedState = { state, at: Date.now() };
  return state;
}

async function queryState(): Promise<KeyringState> {
  if (process.platform !== "linux") return "unlocked";
  const busctl = Bun.which("busctl");
  if (!busctl) return "unavailable";
  const proc = Bun.spawn(
    [busctl, "--user", "get-property", "org.freedesktop.secrets", "/org/freedesktop/secrets/aliases/default", "org.freedesktop.Secret.Collection", "Locked"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return "unavailable";
  return out.trim() === "b false" ? "unlocked" : "locked";
}

export function memoryKeyring(initial: Record<string, string> = {}, state: KeyringState = "unlocked"): Keyring & { entries: Map<string, string> } {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    state: async () => state,
    get: async (key) => (state === "unlocked" ? (entries.get(key) ?? null) : null),
    set: async (key, password) => {
      if (state !== "unlocked") throw new Error("the keyring is locked or not running");
      entries.set(key, password);
    },
    forget: async (key) => {
      entries.delete(key);
    },
  };
}
