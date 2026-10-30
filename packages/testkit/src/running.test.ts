import { describe, expect, it } from "bun:test";

import { existsSync, readFileSync } from "node:fs";

import { guardRuns } from "./guard";
import { groupRunning, processRunning, procStatGroup } from "./running";

describe("procStatGroup", () => {
  it("reads the state and the process group after the last parenthesis of the name", () => {
    expect(procStatGroup("42 (a (b) c) Z 1 40 40 0 -1 4194304")).toEqual({ state: "Z", pgrp: 40 });
    expect(procStatGroup("7 (sleep) S 6 7 7 0")).toEqual({ state: "S", pgrp: 7 });
  });

  it("is null for a line without a name or a group", () => {
    expect(procStatGroup("42 sleep S 1 40")).toBeNull();
    expect(procStatGroup("42 (sleep) S 1")).toBeNull();
  });
});

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

  it.skipIf(!PROC_RUNS)("count a zombie as gone, alone and in its group", async () => {
    // The shell's background child exits at once and is never reaped: `exec` makes the shell a
    // `sleep` that waits for no child. `setsid` makes the child lead a group of its own.
    const parent = Bun.spawn({
      cmd: ["/bin/sh", "-c", "setsid /bin/sleep 0 & echo $!; exec /bin/sleep 30"],
      stdout: "pipe",
      stderr: "ignore",
    });
    try {
      const { value } = await parent.stdout.getReader().read();
      const zombie = Number(new TextDecoder().decode(value).trim());
      for (let i = 0; i < 100 && !isZombie(zombie); i++) await Bun.sleep(20);
      expect(isZombie(zombie)).toBe(true);
      // kill(pid, 0) still finds it, as it finds a zombie that PID 1 of a box made before DIPO-378
      // never reaps.
      expect(() => process.kill(zombie, 0)).not.toThrow();
      expect(() => process.kill(-zombie, 0)).not.toThrow();
      expect(processRunning(zombie)).toBe(false);
      expect(groupRunning(zombie)).toBe(false);
      expect(processRunning(parent.pid)).toBe(true);
    } finally {
      parent.kill("SIGKILL");
      await parent.exited;
    }
  });
});

const PROC_RUNS = guardRuns(
  "PROC_RUNS",
  "no /proc here (macOS), so there is no zombie state to read",
  existsSync("/proc/self/stat"),
);

function isZombie(pid: number): boolean {
  try {
    return procStatGroup(readFileSync(`/proc/${pid}/stat`, "utf8"))?.state === "Z";
  } catch {
    return false;
  }
}
