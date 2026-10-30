// The client's own process probe (DIPO-320): its system calls feed the contract's runtime layout,
// the rules the daemon uses too, so a live process reads the way the daemon's lock reads it.

import { describe, expect, it } from "bun:test";

import { isSameProcess } from "@dipsaus-orchestrator/contract";

import { systemProcessProbe } from "../../src/node/index";

const platform = process.platform === "linux" ? "linux" : "darwin";

describe("the client's process probe", () => {
  it("reads this process with a start time in the past and the same identity twice", async () => {
    const probe = systemProcessProbe(platform);
    const own = await probe(process.pid);
    expect(own).not.toBeNull();
    expect(own?.pid).toBe(process.pid);
    expect(own?.zombie).toBe(false);
    expect(own?.command).toContain("bun");
    expect(own?.startTimeMs ?? Infinity).toBeLessThanOrEqual(
      performance.timeOrigin + performance.now() + 2000,
    );
    const again = await probe(process.pid);
    expect(isSameProcess({ pid: process.pid, startTimeMs: own?.startTimeMs ?? 0 }, again)).toBe(
      true,
    );
  });

  it("returns null for a process that has exited", async () => {
    const child = Bun.spawn({ cmd: ["true"], stdout: "ignore", stderr: "ignore" });
    await child.exited;
    expect(await systemProcessProbe(platform)(child.pid)).toBeNull();
  });
});
