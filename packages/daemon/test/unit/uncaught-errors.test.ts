// The daemon's listener for errors no code caught (DIPO-110, DIPO-117): it logs each one once with
// its code, then reports it so the daemon drains and exits as a crash, and never throws. A fake
// source stands in for `process`; the real process is in uncaught-error.ci.test.ts.

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";

import { createLogger } from "@dipsaus-orchestrator/engine";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { onUncaughtErrors } from "../../src/foreground";
import type { UncaughtEvent } from "../../src/io";

function logged(): { lines: Record<string, unknown>[]; logger: ReturnType<typeof createLogger> } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    clock: new ManualClock(),
    sinks: [(line) => lines.push(JSON.parse(line) as Record<string, unknown>)],
    component: "daemon",
  });
  return { lines, logger };
}

describe("onUncaughtErrors", () => {
  it("logs a rejection and an exception once each with their codes, then reports them without throwing", () => {
    const { lines, logger } = logged();
    const source = new EventEmitter();
    const reported: UncaughtEvent[] = [];
    onUncaughtErrors(logger, (event) => reported.push(event), source);
    const rejection = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    const exception = Object.assign(new Error("no space left"), { code: "ENOSPC" });
    expect(() => source.emit("unhandledRejection", rejection)).not.toThrow();
    expect(() => source.emit("uncaughtException", exception)).not.toThrow();
    expect(reported).toEqual(["unhandledRejection", "uncaughtException"]);
    expect(lines).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "an unhandled rejection reached the daemon",
        component: "daemon",
        errorCode: "SQLITE_IOERR",
        error: expect.objectContaining({ name: "Error", message: "disk I/O error" }),
      }),
      expect.objectContaining({
        level: "error",
        msg: "an uncaught exception reached the daemon",
        errorCode: "ENOSPC",
        error: expect.objectContaining({ message: "no space left" }),
      }),
    ]);
  });

  it("logs a reason without a code, or with one that is not code-shaped, without errorCode", () => {
    const { lines, logger } = logged();
    const source = new EventEmitter();
    onUncaughtErrors(logger, () => {}, source);
    source.emit("unhandledRejection", "plain text");
    source.emit("uncaughtException", Object.assign(new Error("odd"), { code: "not a code" }));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).not.toHaveProperty("errorCode");
  });

  it("still reports the error when logging throws, and swallows a throwing report", () => {
    const source = new EventEmitter();
    const reported: UncaughtEvent[] = [];
    const logger = createLogger({
      clock: new ManualClock(),
      sinks: [
        () => {
          throw new Error("log sink failed");
        },
      ],
      component: "daemon",
    });
    onUncaughtErrors(logger, (event) => reported.push(event), source);
    expect(() => source.emit("uncaughtException", new Error("boom"))).not.toThrow();
    expect(reported).toEqual(["uncaughtException"]);

    const other = new EventEmitter();
    onUncaughtErrors(
      logged().logger,
      () => {
        throw new Error("report failed");
      },
      other,
    );
    expect(() => other.emit("unhandledRejection", new Error("boom"))).not.toThrow();
  });

  it("stops listening once removed", () => {
    const { lines, logger } = logged();
    const source = new EventEmitter();
    const remove = onUncaughtErrors(logger, () => {}, source);
    expect(source.listenerCount("unhandledRejection")).toBe(1);
    expect(source.listenerCount("uncaughtException")).toBe(1);
    remove();
    expect(source.listenerCount("unhandledRejection")).toBe(0);
    expect(source.listenerCount("uncaughtException")).toBe(0);
    expect(lines).toEqual([]);
  });
});
