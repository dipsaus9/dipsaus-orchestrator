import { describe, expect, it } from "bun:test";

import { systemClock } from "./clock";

describe("systemClock", () => {
  it("reads wall-clock time", () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("fires a timer and lets a cleared one stay silent", async () => {
    const fired: string[] = [];
    const cleared = systemClock.setTimeout(() => fired.push("cleared"), 1);
    systemClock.clearTimeout(cleared);
    await new Promise<void>((resolve) => {
      systemClock.setTimeout(() => {
        fired.push("kept");
        resolve();
      }, 5);
    });
    expect(fired).toEqual(["kept"]);
  });
});
