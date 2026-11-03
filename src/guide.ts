import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const guideDir = join(import.meta.dir, "..", "guide");

export function guidePages(dir = guideDir): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -".md".length))
    .sort();
}

export function guidePage(requested: string, dir = guideDir): string | undefined {
  const name = basename(requested.split("#")[0]!).replace(/\.md$/, "");
  return guidePages(dir).includes(name) ? readFileSync(join(dir, `${name}.md`), "utf8") : undefined;
}

export function guideCommand(tool: string, args: string[], dir = guideDir): number {
  if (args.length > 1) {
    console.error(`Usage: ${tool} guide [page]`);
    return 2;
  }
  const requested = args[0] ?? "index";
  const page = guidePage(requested, dir);
  if (page === undefined) {
    console.error(`${tool} guide has no page ${requested}; its pages are: ${guidePages(dir).join(", ")}`);
    return 1;
  }
  process.stdout.write(page);
  return 0;
}
