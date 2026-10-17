// The deciding guard of worker outcomes (DIPO-128): the one helper that holds the decisions under
// way, keyed `<run> <what>`.

import { describe, expect, it } from "bun:test";

import { DecidingGuard } from "../../src/run/deciding";

describe("DecidingGuard", () => {
  it("holds a key from the call until the work settles", async () => {
    const guard = new DecidingGuard();
    const { promise, resolve } = Promise.withResolvers<string>();
    const running = guard.within("run_1 agent_1", () => promise);
    expect(guard.has("run_1 agent_1")).toBe(true);
    expect(guard.busy("run_1")).toBe(true);
    resolve("done");
    expect(await running).toBe("done");
    expect(guard.has("run_1 agent_1")).toBe(false);
    expect(guard.busy("run_1")).toBe(false);
  });

  it("lets go of the key when the work throws", async () => {
    const guard = new DecidingGuard();
    await expect(
      guard.within("run_1 agent_1", () => Promise.reject(new Error("failed"))),
    ).rejects.toThrow("failed");
    expect(guard.has("run_1 agent_1")).toBe(false);
  });

  it("is busy for the decisions of one run only", async () => {
    const guard = new DecidingGuard();
    const { promise, resolve } = Promise.withResolvers<void>();
    const running = guard.within("run_1 plan-limit", () => promise);
    expect(guard.busy("run_1")).toBe(true);
    expect(guard.busy("run_10")).toBe(false);
    expect(guard.busy("run_2")).toBe(false);
    resolve();
    await running;
  });

  it("keeps a key while another decision of the same run ends", async () => {
    const guard = new DecidingGuard();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const a = guard.within("run_1 agent_1", () => first.promise);
    const b = guard.within("run_1 park-resume", () => second.promise);
    first.resolve();
    await a;
    expect(guard.busy("run_1")).toBe(true);
    second.resolve();
    await b;
    expect(guard.busy("run_1")).toBe(false);
  });
});
