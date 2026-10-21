// The box login in the Keychain (DIPO-269) against a fake `security`: reading, its failures, the
// deadline, storing on the terminal, and that no argv, message or text form carries the token.

import { inspect } from "node:util";

import { afterEach, describe, expect, it } from "bun:test";

import type { SpawnOptions } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { BoxError } from "../../src/box/port";
import {
  findTokenArgs,
  readBoxToken,
  SECURITY_CLI,
  SecretToken,
  type SpawnInteractive,
  storeBoxToken,
  storeTokenArgs,
  TOKEN_READ_TIMEOUT_MS,
  TOKEN_REDACTED,
} from "../../src/box/token";
import { type CliReply, type FakeContainer, fakeContainer } from "./fake-container";

const TOKEN_TEXT = "fake-box-login-for-tests-0123456789";
const ENV = { PATH: "/usr/bin:/bin", HOME: "/Users/someone" };

/** Every spawn made in a test, so no argv may carry the token. */
let argvs: (readonly string[])[] = [];

afterEach(() => {
  for (const argv of argvs) {
    for (const arg of argv) expect(arg).not.toContain(TOKEN_TEXT);
  }
  argvs = [];
});

function security(reply: CliReply): FakeContainer {
  const fake = fakeContainer(() => reply);
  const spawn = (options: SpawnOptions) => {
    argvs.push(options.cmd);
    return fake.spawn(options);
  };
  return { ...fake, spawn };
}

async function readError(reply: CliReply): Promise<BoxError> {
  const fake = security(reply);
  const caught = await readBoxToken({
    spawn: fake.spawn,
    clock: new ManualClock(),
    env: ENV,
  }).catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(BoxError);
  const error = caught as BoxError;
  expect(error.message).not.toContain(TOKEN_TEXT);
  expect(JSON.stringify(error.details)).not.toContain(TOKEN_TEXT);
  return error;
}

describe("the Keychain entry", () => {
  it("reads with -w and stores with -w last and no value", () => {
    expect(findTokenArgs()).toEqual([
      "find-generic-password",
      "-s",
      "dipo",
      "-a",
      "box-login",
      "-w",
    ]);
    const store = storeTokenArgs();
    expect(store[0]).toBe("add-generic-password");
    expect(store).toContain("-U");
    expect(store.at(-1)).toBe("-w");
    expect(store.filter((arg) => arg === "-w")).toHaveLength(1);
  });
});

describe("readBoxToken", () => {
  it("reads the token through /usr/bin/security with only the given environment", async () => {
    const fake = security({ stdout: `${TOKEN_TEXT}\n` });
    const token = await readBoxToken({ spawn: fake.spawn, clock: new ManualClock(), env: ENV });
    expect(token.reveal()).toBe(TOKEN_TEXT);
    expect(fake.calls).toEqual([
      { cmd: [SECURITY_CLI, ...findTokenArgs()], env: ENV, stdin: "ignore" },
    ]);
  });

  it("says token.missing when there is no entry", async () => {
    const error = await readError({
      code: 44,
      stderr:
        "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n",
    });
    expect(error.code).toBe("token.missing");
    expect(error.message).toContain("dipo login box");
  });

  it("says token.invalid for an entry that is not one header-safe word, without showing it", async () => {
    for (const stdout of [
      "\n",
      "short\n",
      `${TOKEN_TEXT} ${TOKEN_TEXT}\n`,
      `${TOKEN_TEXT}\r\nX: y\n`,
    ]) {
      const error = await readError({ stdout });
      expect(error.code).toBe("token.invalid");
    }
  });

  it("says token.unreadable when security fails, never with what it printed on stdout", async () => {
    const error = await readError({
      code: 51,
      stdout: `${TOKEN_TEXT}\n`,
      stderr: `security: failed near ${TOKEN_TEXT}\n`,
    });
    expect(error.code).toBe("token.unreadable");
    expect(error.message).toContain(TOKEN_REDACTED);
  });

  it("says token.unreadable when security cannot start", async () => {
    const caught = await readBoxToken({
      spawn: () => {
        throw new Error("ENOENT");
      },
      clock: new ManualClock(),
      env: ENV,
    }).catch((error: unknown) => error);
    expect((caught as BoxError).code).toBe("token.unreadable");
  });

  it("kills security at the deadline and says token.timedOut", async () => {
    const clock = new ManualClock();
    const fake = security({ hang: true });
    const reading = readBoxToken({ spawn: fake.spawn, clock, env: ENV }).catch(
      (error: unknown) => error,
    );
    clock.advance(TOKEN_READ_TIMEOUT_MS);
    const error = (await reading) as BoxError;
    expect(error.code).toBe("token.timedOut");
    expect(fake.children[0]?.signals).toEqual(["SIGKILL"]);
  });
});

describe("storeBoxToken", () => {
  it("runs security on the terminal with no token in its argv or its input", async () => {
    const seen: Parameters<SpawnInteractive>[0][] = [];
    const result = await storeBoxToken({
      spawnInteractive: async (options) => {
        seen.push(options);
        argvs.push(options.cmd);
        return { code: 0, signal: null };
      },
      env: ENV,
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([{ cmd: [SECURITY_CLI, ...storeTokenArgs()], env: ENV }]);
    // The seam has no stdin of dipo's: security reads the terminal itself.
    expect(Object.keys(seen[0] ?? {}).toSorted()).toEqual(["cmd", "env"]);
  });

  it("reports a failed or interrupted store", async () => {
    const failed = await storeBoxToken({
      spawnInteractive: async () => ({ code: 45, signal: null }),
      env: ENV,
    });
    expect(failed).toEqual({
      ok: false,
      code: "token.storeFailed",
      reason: "security exited 45; nothing was stored.",
    });
    const interrupted = await storeBoxToken({
      spawnInteractive: async () => ({ code: null, signal: "SIGINT" }),
      env: ENV,
    });
    expect(interrupted.ok).toBe(false);
    const missing = await storeBoxToken({
      spawnInteractive: async () => {
        throw new Error("ENOENT");
      },
      env: ENV,
    });
    expect(missing.ok).toBe(false);
  });
});

describe("SecretToken", () => {
  it("prints as a placeholder in every text form", () => {
    const token = new SecretToken(TOKEN_TEXT);
    expect(String(token)).toBe(TOKEN_REDACTED);
    expect(`${token}`).toBe(TOKEN_REDACTED);
    expect(JSON.stringify({ token })).toBe(`{"token":"${TOKEN_REDACTED}"}`);
    expect(inspect(token)).toBe(TOKEN_REDACTED);
    expect(inspect({ token })).not.toContain(TOKEN_TEXT);
  });

  it("finds the token across chunk boundaries and not where it is absent", () => {
    const token = new SecretToken(TOKEN_TEXT);
    const bytes = new TextEncoder().encode(`${"a".repeat(1000)}${TOKEN_TEXT}${"b".repeat(1000)}`);
    for (const size of [1, 7, 33, 512, bytes.length]) {
      const scanner = token.scanner();
      for (let at = 0; at < bytes.length; at += size) scanner.push(bytes.subarray(at, at + size));
      expect(scanner.found).toBe(true);
    }
    const partial = token.scanner();
    partial.push(new TextEncoder().encode(TOKEN_TEXT.slice(0, -1)));
    partial.push(new TextEncoder().encode(`x${TOKEN_TEXT.slice(1)}`));
    expect(partial.found).toBe(false);
  });

  it("redacts every occurrence", () => {
    const token = new SecretToken(TOKEN_TEXT);
    expect(token.redact(`${TOKEN_TEXT} and ${TOKEN_TEXT}`)).toBe(
      `${TOKEN_REDACTED} and ${TOKEN_REDACTED}`,
    );
  });
});
