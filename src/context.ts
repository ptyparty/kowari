import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export type Attachment = { label: string; text: string };

type Env = Record<string, string | undefined>;

export class ContextRequest {
  private open = true;
  private cancelled: (() => void) | undefined;

  constructor(private readonly write: (message: object, last: boolean) => void) {}

  get active(): boolean {
    return this.open;
  }

  onCancel(callback: () => void): void {
    this.cancelled = callback;
  }

  picking(hint: string): void {
    this.send({ picking: hint }, false);
  }

  attach(attachments: Attachment[]): void {
    this.send({ attach: attachments }, true);
  }

  none(reason: string): void {
    this.send({ none: reason }, true);
  }

  cancel(): void {
    this.send({ cancelled: true }, true);
  }

  end(): void {
    if (!this.open) return;
    this.open = false;
    this.cancelled?.();
  }

  private send(message: object, last: boolean): void {
    if (!this.open) return;
    if (last) this.open = false;
    this.write(message, last);
  }
}

export function contextSocket(env: Env = process.env): string | undefined {
  const { KOMUX_TAB_DIR: tabDir, KOMUX_PANE_ID: pane } = env;
  if (!tabDir || !pane || !/^\d+$/.test(pane)) return undefined;
  return join(tabDir, "context", `${pane}.sock`);
}

export function listenForContext(onContext: (request: ContextRequest) => void, env: Env = process.env): () => void {
  const path = contextSocket(env);
  if (!path) return () => {};
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const requests = new Map<object, ContextRequest>();
  const buffers = new Map<object, string>();
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, data) {
        const lines = ((buffers.get(socket) ?? "") + data.toString()).split("\n");
        buffers.set(socket, lines.pop()!);
        for (const line of lines) {
          const message = parse(line);
          if (message?.context !== undefined && !requests.has(socket)) {
            const request = new ContextRequest((reply, last) => {
              const text = `${JSON.stringify(reply)}\n`;
              if (last) socket.end(text);
              else socket.write(text);
            });
            requests.set(socket, request);
            onContext(request);
          } else if (message?.cancel === true) {
            requests.get(socket)?.end();
            socket.end();
          }
        }
      },
      close(socket) {
        requests.get(socket)?.end();
        requests.delete(socket);
        buffers.delete(socket);
      },
    },
  });
  return () => {
    for (const request of requests.values()) request.end();
    server.stop(true);
    rmSync(path, { force: true });
  };
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const message = JSON.parse(line) as unknown;
    return typeof message === "object" && message !== null ? (message as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
