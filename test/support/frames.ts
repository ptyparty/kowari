import type { TestRendererSetup } from "@opentui/core/testing";

export async function until(s: TestRendererSetup, predicate: (frame: string) => boolean): Promise<string> {
  for (let i = 0; i < 200; i++) {
    await s.renderOnce();
    const frame = s.captureCharFrame();
    if (predicate(frame)) return frame;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for the frame; last frame:\n${s.captureCharFrame()}`);
}
