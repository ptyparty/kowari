import { readdir } from "node:fs/promises";
import path from "node:path";

export type Worktree = {
  root: string;
  identity: string | null;
  identityFromRemote: boolean;
  composeServices: Set<string>;
};

export async function findWorktree(cwd: string): Promise<Worktree> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])) ?? cwd;
  const remote = await git(root, ["remote", "get-url", "origin"]);
  const commonDir = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const identity = remote ? normalizeRemote(remote) : commonDir ? checkoutPath(commonDir) : null;
  return { root, identity, identityFromRemote: remote !== null, composeServices: await composeServices(root) };
}

function checkoutPath(commonDir: string): string {
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
}

export function normalizeRemote(remote: string): string {
  const trimmed = remote.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(trimmed);
  if (scp && !trimmed.includes("://")) return `${scp[1]!.toLowerCase()}/${scp[2]!.replace(/^\/+/, "")}`;
  try {
    const url = new URL(trimmed);
    return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+/, "")}`;
  } catch {
    return trimmed;
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? out.trim() || null : null;
}

async function composeServices(root: string): Promise<Set<string>> {
  const services = new Set<string>();
  const entries = await readdir(root).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!/^(docker-)?compose([.-].*)?\.ya?ml$/.test(entry)) continue;
    try {
      const doc = Bun.YAML.parse(await Bun.file(path.join(root, entry)).text()) as { services?: Record<string, unknown> };
      for (const name of Object.keys(doc?.services ?? {})) {
        if (!name.includes(".")) services.add(name.toLowerCase());
      }
    } catch {
      continue;
    }
  }
  return services;
}
