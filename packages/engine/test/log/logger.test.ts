// The daemon logger (DIPO-23, 0006 decision 13): JSON lines, levels, context and redaction.

import { describe, expect, it } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { engineError } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openLogFile } from "../../src/log/file";
import {
  createLogger,
  DEBUG_ONLY,
  DEBUG_ONLY_KEYS,
  isSecretKey,
  LOG_LEVELS,
  REDACTED,
  type Logger,
} from "../../src/log/logger";

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

/** A web bootstrap code as the daemon would make one: 128 random bits. */
const BOOTSTRAP = "9f3c1ab07e5d42c8b6a1f0e2d3c4b5a6";
/** A worst case: a code-shaped bootstrap value, letters only. */
const LETTERS = "qwertyuiopasdfghjklzxcvbnm";

describe("redaction", () => {
  for (const level of LOG_LEVELS) {
    it(`hides secret fields at ${level}, at any depth`, () => {
      const { logger, lines, parsed } = memory("trace");
      at(logger, level)("auth", {
        token: "t0ken-secret",
        session: { token: "s3ssion-secret", expires: 5 },
        "session.token": "flat-secret",
        sessionToken: "camel-secret",
        engine_token: "snake-secret",
        bootstrapCode: `${BOOTSTRAP}-top`,
        nested: [{ token: "deep-secret", web: { bootstrapCode: `${BOOTSTRAP}-deep` } }],
        Authorization: "Bearer header-secret",
        kept: "visible",
      });
      const text = lines.join("\n");
      for (const secret of ["t0ken", "s3ssion", "-secret", BOOTSTRAP]) {
        expect(text).not.toContain(secret);
      }
      expect(parsed()[0]).toMatchObject({
        level,
        token: REDACTED,
        session: { token: REDACTED, expires: 5 },
        "session.token": REDACTED,
        sessionToken: REDACTED,
        engine_token: REDACTED,
        bootstrapCode: REDACTED,
        nested: [{ token: REDACTED, web: { bootstrapCode: REDACTED } }],
        Authorization: REDACTED,
        kept: "visible",
      });
    });
  }

  it("names secrets by their ending, not token counts", () => {
    const secrets = [
      "token",
      "session.token",
      "engineToken",
      "API_KEY",
      "bootstrap-code",
      "credential",
      "awsCredentials",
      "private_key",
      "githubPat",
      "PAT",
      "requestSignature",
      "Set-Cookie",
      "set_cookie",
    ];
    for (const key of secrets) {
      expect(isSecretKey(key)).toBe(true);
    }
    for (const key of ["code", "tokens", "preTokens", "inputTokens", "exitCode", "path", "kept"]) {
      expect(isSecretKey(key)).toBe(false);
    }
  });

  it("hides credentials, private keys, PATs, signatures and Set-Cookie in a line", () => {
    const { logger, lines } = memory("trace");
    logger.error("request", {
      credentials: { user: "u", pass: "cred-secret" },
      privateKey: "key-secret",
      nested: [{ githubPat: "pat-secret", signature: "sig-secret" }],
      "set-cookie": "cookie-secret",
    });
    expect(lines.join("\n")).not.toContain("-secret");
  });

  it("shows an EngineError code in a warn line", () => {
    const { logger, parsed } = memory("trace");
    const recovering = engineError("engine.recovering", "the daemon is recovering");
    logger.warn("command refused", { ...recovering });
    logger.warn("office refused", { code: "office.notFound", step: "marker" });
    logger.warn("office not loaded", { error: engineError("office.refused", "not loaded") });
    logger.info("worker exited", { code: 1, signal: null });
    expect(parsed()).toMatchObject([
      { level: "warn", code: "engine.recovering", retryable: true },
      { level: "warn", code: "office.notFound", step: "marker" },
      { level: "warn", error: { code: "office.refused" } },
      { level: "info", code: 1, signal: null },
    ]);
  });

  for (const level of LOG_LEVELS) {
    it(`keeps a web bootstrap code under code redacted at ${level}, at any depth`, () => {
      const { logger, lines, parsed } = memory("trace");
      at(logger, level)("web", {
        frame: { kind: "auth", requestId: "req_1", code: LETTERS },
        reply: {
          ok: true,
          requestId: "req_2",
          result: { url: "http://127.0.0.1:1/", code: LETTERS },
        },
        deep: [{ frames: [{ kind: "auth", code: `${LETTERS}.x` }] }],
        code: BOOTSTRAP,
      });
      const text = lines.join("\n");
      expect(text).not.toContain(LETTERS);
      expect(text).not.toContain(BOOTSTRAP);
      expect(parsed()[0]).toMatchObject({
        frame: { kind: "auth", code: REDACTED },
        reply: { result: { url: "http://127.0.0.1:1/", code: REDACTED } },
        deep: [{ frames: [{ kind: "auth", code: REDACTED }] }],
        code: REDACTED,
      });
    });
  }

  it("keeps a code that is not code-shaped redacted", () => {
    const { logger, parsed } = memory("trace");
    for (const code of [BOOTSTRAP, "c0de-secret", "a_b", "x".repeat(65), { nested: "x" }, ["x"]]) {
      logger.warn("odd code", { code });
    }
    expect(parsed().map((line) => line["code"])).toEqual(Array(6).fill(REDACTED));
  });

  it("shows a letters-only code outside the contract's bootstrap shapes (residual case)", () => {
    // The logger cannot tell a letters-only secret from an error code here. What keeps the web
    // bootstrap code out of this case is the encoding rule of the 0006 amendment of 2026-10-15
    // (DIPO-91): it is lowercase hex or starts with a prefix holding a digit, so never code-shaped.
    const { logger, parsed } = memory("trace");
    logger.warn("reply", { requestId: "req_3", code: LETTERS });
    expect(parsed()[0]).toMatchObject({ requestId: "req_3", code: LETTERS });
  });

  it("does not loop on cycles", () => {
    const { logger, parsed } = memory();
    const cyclic: Record<string, unknown> = { token: "x" };
    cyclic["self"] = cyclic;
    logger.info("cycle", { cyclic });
    expect(parsed()[0]?.["cyclic"]).toEqual({ token: REDACTED, self: "[cycle]" });
  });
});

const content = () => ({
  prompt: "secret-prompt",
  output: "secret-output",
  stdout: "secret-stdout",
  stderr: "secret-stderr",
  body: { text: "secret-body" },
  args: { title: "secret-args" },
  nested: [{ prompt: "secret-nested" }],
  kept: "visible",
});

describe("prompts, worker output and command bodies (DIPO-64)", () => {
  for (const level of ["error", "warn", "info"] as const) {
    it(`are replaced in ${level} lines, at any depth`, () => {
      const { logger, lines, parsed } = memory("trace");
      at(logger, level)("worker event", content());
      expect(lines.join("\n")).not.toContain("secret");
      expect(parsed()[0]).toMatchObject({
        prompt: DEBUG_ONLY,
        output: DEBUG_ONLY,
        stdout: DEBUG_ONLY,
        stderr: DEBUG_ONLY,
        body: DEBUG_ONLY,
        args: DEBUG_ONLY,
        nested: [{ prompt: DEBUG_ONLY }],
        kept: "visible",
      });
    });
  }

  for (const level of ["debug", "trace"] as const) {
    it(`appear in ${level} lines, with secrets still redacted`, () => {
      const { logger, parsed } = memory("trace");
      at(logger, level)("worker event", { ...content(), body: { token: "t0ken" } });
      expect(parsed()[0]).toMatchObject({
        prompt: "secret-prompt",
        output: "secret-output",
        args: { title: "secret-args" },
        body: { token: REDACTED },
        nested: [{ prompt: "secret-nested" }],
      });
    });
  }

  it("are named by DEBUG_ONLY_KEYS", () => {
    expect([...DEBUG_ONLY_KEYS].toSorted()).toEqual([
      "args",
      "body",
      "output",
      "prompt",
      "stderr",
      "stdout",
    ]);
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
