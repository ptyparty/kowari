import { TextAttributes, type CapturedFrame } from "@opentui/core";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function frameHtml(frame: CapturedFrame, background = "#1f1f28"): string {
  const lines = frame.lines.map((line) =>
    line.spans
      .map((span) => {
        const [fr, fg, fb, fa] = span.fg.toInts();
        const [br, bg, bb, ba] = span.bg.toInts();
        const style = [
          `color:rgba(${fr},${fg},${fb},${fa / 255})`,
          ba > 0 ? `background:rgba(${br},${bg},${bb},${ba / 255})` : "",
          span.attributes & TextAttributes.BOLD ? "font-weight:bold" : "",
          span.attributes & TextAttributes.ITALIC ? "font-style:italic" : "",
          span.attributes & TextAttributes.DIM ? "opacity:0.6" : "",
          span.attributes & TextAttributes.UNDERLINE ? "text-decoration:underline" : "",
        ]
          .filter(Boolean)
          .join(";");
        return `<span style="${style}">${escapeHtml(span.text)}</span>`;
      })
      .join(""),
  );
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:${background}}
pre{margin:0;padding:8px;font-family:"DejaVu Sans Mono","Menlo",monospace;font-size:14px;line-height:17px;white-space:pre}
</style><pre>${lines.join("\n")}</pre>`;
}

export async function screenshot(frame: CapturedFrame, png: string, chrome = findChrome()): Promise<void> {
  if (!chrome) throw new Error("screenshots need Chrome or Chromium");
  const dir = await mkdtemp(path.join(os.tmpdir(), "kowari-shot-"));
  try {
    const html = path.join(dir, "frame.html");
    await Bun.write(html, frameHtml(frame));
    const width = Math.ceil(frame.cols * 8.43 + 16);
    const height = frame.rows * 17 + 16 + 87;
    const proc = Bun.spawn(
      [chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", `--screenshot=${png}`, `--window-size=${width},${height}`, `file://${html}`],
      { stdout: "ignore", stderr: "pipe" },
    );
    if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function findChrome(): string | undefined {
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = Bun.which(name);
    if (found) return found;
  }
  return undefined;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
