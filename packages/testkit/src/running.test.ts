import { describe, expect, it } from "bun:test";

import { groupRunning, processRunning } from "./running";

describe("processRunning and groupRunning", () => {
  it("find a running child and its group, and neither once it is killed and reaped", async () => {
    const child = Bun.spawn(["sleep", "30"], { detached: true });
    try {
      expect(processRunning(child.pid)).toBe(true);
      expect(groupRunning(child.pid)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    expect(processRunning(child.pid)).toBe(false);
    expect(groupRunning(child.pid)).toBe(false);
  });
});
