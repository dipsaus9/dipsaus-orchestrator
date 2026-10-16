// Fire-and-forget engine jobs (DIPO-110): `background` logs a failed job once, with its error code,
// keeps it in the owner's in-flight set until it settled, runs `settled` either way, and never
// leaves an unhandled rejection.

import { describe, expect, it } from "bun:test";

import { background } from "../../src/platform/background";

import { watchRejections } from "./rejections";

type Line = { message: string; fields: Readonly<Record<string, unknown>> };

function recorder(): { lines: Line[]; log: (message: string, fields: Line["fields"]) => void } {
  const lines: Line[] = [];
  return { lines, log: (message, fields) => lines.push({ message, fields }) };
}

function sqliteError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("background", () => {
  it("resolves to the job's value and logs nothing when it succeeds", async () => {
    const { lines, log } = recorder();
    const inflight = new Set<Promise<unknown>>();
    const done = background(async () => 7, { failed: "the job failed", log, inflight });
    expect(inflight.size).toBe(1);
    expect(await done).toBe(7);
    await Promise.resolve();
    expect(inflight.size).toBe(0);
    expect(lines).toEqual([]);
  });

  it("logs a failed job once with its reason and error code, and leaves no unhandled rejection", async () => {
    const watch = watchRejections();
    const { lines, log } = recorder();
    const inflight = new Set<Promise<unknown>>();
    const done = background(
      async () => {
        await Promise.resolve();
        throw sqliteError("disk I/O error", "SQLITE_IOERR");
      },
      { failed: "writing the notice failed", fields: { run: "run_1" }, log, inflight },
    );
    expect(await done).toBeUndefined();
    expect(await watch.stop()).toEqual([]);
    expect(inflight.size).toBe(0);
    expect(lines).toEqual([
      {
        message: "writing the notice failed",
        fields: { run: "run_1", reason: "disk I/O error", errorCode: "SQLITE_IOERR" },
      },
    ]);
  });

  it("catches a job that throws before its first await", async () => {
    const watch = watchRejections();
    const { lines, log } = recorder();
    const done = background(
      () => {
        throw new Error("no database");
      },
      { failed: "the job failed", log },
    );
    expect(await done).toBeUndefined();
    expect(await watch.stop()).toEqual([]);
    expect(lines).toEqual([{ message: "the job failed", fields: { reason: "no database" } }]);
  });

  it("runs settled after a failure too, and logs a settled callback that throws", async () => {
    const watch = watchRejections();
    const { lines, log } = recorder();
    const order: string[] = [];
    await background(
      async () => {
        order.push("job");
        throw new Error("pass failed");
      },
      {
        failed: "retention pass failed",
        log,
        settled: () => {
          order.push("settled");
          throw new Error("arming failed");
        },
      },
    );
    expect(await watch.stop()).toEqual([]);
    expect(order).toEqual(["job", "settled"]);
    expect(lines.map((line) => line.fields["reason"])).toEqual(["pass failed", "arming failed"]);
  });

  it("leaves out an error code that is not code-shaped, and survives a log that throws", async () => {
    const watch = watchRejections();
    const { lines, log } = recorder();
    await background(() => Promise.reject(sqliteError("odd", "not a code")), {
      failed: "the job failed",
      log,
    });
    await background(() => Promise.reject(new Error("again")), {
      failed: "the job failed",
      log: () => {
        throw new Error("the log is closed");
      },
    });
    expect(await watch.stop()).toEqual([]);
    expect(lines).toEqual([{ message: "the job failed", fields: { reason: "odd" } }]);
  });
});
