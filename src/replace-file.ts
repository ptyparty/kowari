import { chmod, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function replaceFile(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const target = await realpath(file).catch(() => file);
  const mode = await stat(target).then((st) => st.mode & 0o777, () => 0o600);
  const temp = `${target}.kowari-${process.pid}`;
  try {
    await writeFile(temp, text, { mode });
    await chmod(temp, mode);
    await rename(temp, target);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
}
