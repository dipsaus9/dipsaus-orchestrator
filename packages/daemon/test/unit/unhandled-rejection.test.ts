// The daemon's unhandled rejection listener (DIPO-110): it logs the error with its code, then
// throws the reason again so Bun handles it as it did before. A fake source stands in for
// `process`; the real process is in unhandled-rejection.ci.test.ts.

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";

import { createLogger } from "@dipsaus-orchestrator/engine";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { logUnhandledRejections } from "../../src/foreground";

function logged(): { lines: Record<string, unknown>[]; logger: ReturnType<typeof createLogger> } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    clock: new ManualClock(),
    sinks: [(line) => lines.push(JSON.parse(line) as Record<string, unknown>)],
    component: "daemon",
  });
  return { lines, logger };
}

describe("logUnhandledRejections", () => {
  it("logs one error with the error's code, then throws the reason again", () => {
    const { lines, logger } = logged();
    const source = new EventEmitter();
    logUnhandledRejections(logger, source);
    const reason = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    expect(() => source.emit("unhandledRejection", reason)).toThrow(reason);
    expect(lines).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "an unhandled rejection reached the daemon",
        component: "daemon",
        errorCode: "SQLITE_IOERR",
        error: expect.objectContaining({ name: "Error", message: "disk I/O error" }),
      }),
    ]);
  });

  it("logs a reason without a code, or with one that is not code-shaped, without errorCode", () => {
    const { lines, logger } = logged();
    const source = new EventEmitter();
    logUnhandledRejections(logger, source);
    expect(() => source.emit("unhandledRejection", "plain text")).toThrow();
    expect(() =>
      source.emit("unhandledRejection", Object.assign(new Error("odd"), { code: "not a code" })),
    ).toThrow();
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).not.toHaveProperty("errorCode");
  });

  it("stops listening once removed", () => {
    const { lines, logger } = logged();
    const source = new EventEmitter();
    const remove = logUnhandledRejections(logger, source);
    expect(source.listenerCount("unhandledRejection")).toBe(1);
    remove();
    expect(source.listenerCount("unhandledRejection")).toBe(0);
    expect(lines).toEqual([]);
  });
});
