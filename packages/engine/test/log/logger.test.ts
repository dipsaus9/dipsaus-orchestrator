// The daemon logger (DIPO-23, 0006 decision 13): JSON lines, levels, context and redaction.

import { describe, expect, it } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openLogFile } from "../../src/log/file";
import { createLogger, LOG_LEVELS, REDACTED, type Logger } from "../../src/log/logger";

function memory(level: Parameters<typeof createLogger>[0]["level"] = "trace") {
  const lines: string[] = [];
  const logger = createLogger({
    clock: new ManualClock(),
    sinks: [(line) => lines.push(line)],
    level,
    component: "daemon",
  });
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, parsed };
}

const at = (logger: Logger, level: (typeof LOG_LEVELS)[number]) => logger[level].bind(logger);

describe("log lines", () => {
  it("are JSON with ts, level, msg and component", () => {
    const { logger, lines, parsed } = memory();
    logger.info("daemon starting", { pid: 42 });
    expect(lines).toHaveLength(1);
    expect(parsed()[0]).toEqual({
      ts: "2026-01-01T00:00:00.000Z",
      level: "info",
      msg: "daemon starting",
      component: "daemon",
      pid: 42,
    });
  });

  it("carry office and run when a child knows them, and keep context over fields", () => {
    const { logger, parsed } = memory();
    logger
      .child({ component: "worker-host", office: "off_1", run: "run_1" })
      .warn("slow", { component: "spoofed", ms: 9 });
    expect(parsed()[0]).toEqual({
      ts: "2026-01-01T00:00:00.000Z",
      level: "warn",
      msg: "slow",
      component: "worker-host",
      office: "off_1",
      run: "run_1",
      ms: 9,
    });
  });

  it("drop levels below the threshold and follow setLevel on every child", () => {
    const { logger, parsed } = memory("warn");
    const child = logger.child({ component: "database" });
    child.info("hidden");
    child.error("shown");
    logger.setLevel("debug");
    child.debug("now shown");
    child.trace("still hidden");
    expect(parsed().map((l) => l["msg"])).toEqual(["shown", "now shown"]);
  });

  it("serialise errors with name and message", () => {
    const { logger, parsed } = memory();
    logger.error("failed", { error: new TypeError("boom") });
    expect(parsed()[0]?.["error"]).toMatchObject({ name: "TypeError", message: "boom" });
  });

  it("survive a sink that throws", () => {
    const lines: string[] = [];
    const logger = createLogger({
      clock: new ManualClock(),
      sinks: [
        () => {
          throw new Error("disk full");
        },
        (line) => lines.push(line),
      ],
      component: "daemon",
    });
    logger.info("still logged");
    expect(lines).toHaveLength(1);
  });
});

describe("redaction", () => {
  for (const level of LOG_LEVELS) {
    it(`hides code, token and session.token at ${level}`, () => {
      const { logger, lines, parsed } = memory("trace");
      at(logger, level)("auth", {
        code: "c0de-secret",
        token: "t0ken-secret",
        session: { token: "s3ssion-secret", expires: 5 },
        "session.token": "flat-secret",
        nested: [{ token: "deep-secret" }],
        kept: "visible",
      });
      const text = lines.join("\n");
      for (const secret of ["c0de", "t0ken", "s3ssion", "flat-secret", "deep-secret"]) {
        expect(text).not.toContain(secret);
      }
      expect(parsed()[0]).toMatchObject({
        level,
        code: REDACTED,
        token: REDACTED,
        session: { token: REDACTED, expires: 5 },
        "session.token": REDACTED,
        nested: [{ token: REDACTED }],
        kept: "visible",
      });
    });
  }

  it("does not loop on cycles", () => {
    const { logger, parsed } = memory();
    const cyclic: Record<string, unknown> = { token: "x" };
    cyclic["self"] = cyclic;
    logger.info("cycle", { cyclic });
    expect(parsed()[0]?.["cyclic"]).toEqual({ token: REDACTED, self: "[cycle]" });
  });
});

describe("log file", () => {
  it("appends lines to daemon.log with private modes", async () => {
    await withTempDir((dir) => {
      const logs = join(dir, "logs");
      const file = openLogFile(logs);
      const logger = createLogger({
        clock: new ManualClock(),
        sinks: [file.sink],
        component: "daemon",
      });
      logger.info("one");
      logger.info("two");
      file.close();
      file.sink("after close is dropped");
      const text = readFileSync(join(logs, "daemon.log"), "utf8");
      expect(
        text
          .trim()
          .split("\n")
          .map((l) => (JSON.parse(l) as { msg: string }).msg),
      ).toEqual(["one", "two"]);
      expect(statSync(logs).mode & 0o777).toBe(0o700);
      expect(statSync(join(logs, "daemon.log")).mode & 0o777).toBe(0o600);
    });
  });
});
