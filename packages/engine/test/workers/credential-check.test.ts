// The engine-side credential check (DIPO-43, 0008 amendment "DIPO-43 live sessions"): only the
// marker line written from inside the sandbox counts; a wrapper that failed before the program
// ran never passes as a refusal.

import { describe, expect, it } from "bun:test";

import type { StepResult } from "../../src/sandbox/step";
import {
  credentialCommands,
  judgeCredentialStep,
  KEYCHAIN_TOOL,
  marked,
} from "../../src/workers/credential-check";

function exited(code: number, stdout = ""): StepResult {
  return {
    outcome: "exited",
    code,
    signal: null,
    timedOut: false,
    stdout: { text: stdout, truncated: false },
    stderr: { text: "", truncated: false },
    warnings: [],
  };
}

describe("(unit) credential step verdict", () => {
  it.each([125, 1, 2])("cannot run when the wrapper exits %d without the marker", (code) => {
    expect(judgeCredentialStep("gh-token", exited(code))).toMatchObject({
      ok: false,
      unsafe: false,
      failure: { check: "credential-check", key: "gh-token" },
    });
  });

  it("passes on the marker with a non-zero program exit", () => {
    expect(judgeCredentialStep("gh-token", exited(0, "dipo-credential-exit 1\n"))).toEqual({
      ok: true,
      code: 1,
    });
  });

  it("is unsafe on the marker with exit 0", () => {
    expect(judgeCredentialStep("keychain", exited(0, "dipo-credential-exit 0\n"))).toMatchObject({
      ok: false,
      unsafe: true,
      failure: { key: "keychain" },
    });
  });

  it("cannot run on the marker with 126 or 127", () => {
    for (const code of [126, 127]) {
      const verdict = judgeCredentialStep("gh-token", exited(0, `dipo-credential-exit ${code}\n`));
      expect(verdict).toMatchObject({ ok: false, unsafe: false });
    }
  });

  it("cannot run when the marker comes with other output, a failed wrapper or a timeout", () => {
    for (const step of [
      exited(0, "token\ndipo-credential-exit 1\n"),
      exited(1, "dipo-credential-exit 1\n"),
      { ...exited(0, "dipo-credential-exit 1\n"), timedOut: true },
      { outcome: "startFailed", reason: "srt is missing" } as const,
    ]) {
      expect(judgeCredentialStep("gh-token", step)).toMatchObject({ ok: false, unsafe: false });
    }
  });

  it("wraps the program so its output goes to /dev/null and only the marker is printed", async () => {
    const argv = marked(["/usr/bin/false"]);
    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
    expect(await new Response(child.stdout).text()).toBe("dipo-credential-exit 1\n");
    expect(await child.exited).toBe(0);
    const echo = Bun.spawn([...marked(["/bin/echo", "secret"])], { stdout: "pipe" });
    expect(await new Response(echo.stdout).text()).toBe("dipo-credential-exit 0\n");
  });

  it("probes the Keychain on macOS only", () => {
    expect(credentialCommands("linux", "/usr/bin/gh").map((c) => c.probe)).toEqual(["gh-token"]);
    expect(credentialCommands("darwin", "/usr/bin/gh")[1]?.argv[0]).toBe(KEYCHAIN_TOOL);
  });
});

describe("(unit) Keychain lookup", () => {
  it("asks for the secret with -w, so a lookup that works would be a real leak", () => {
    expect(credentialCommands("darwin", "/usr/bin/gh")[1]?.argv).toEqual([
      KEYCHAIN_TOOL,
      "find-generic-password",
      "-s",
      "gh:github.com",
      "-w",
    ]);
  });
});
