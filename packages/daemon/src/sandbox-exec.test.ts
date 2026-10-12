import { describe, expect, it } from "bun:test";

import { runDaemon } from "./index";
import { parseSandboxExecArgs } from "./sandbox-exec";

describe("parseSandboxExecArgs", () => {
  it("reads the policy file and the command after --", () => {
    expect(parseSandboxExecArgs(["--policy", "/p.json", "--", "bun", "run", "verify"])).toEqual({
      policyPath: "/p.json",
      cwd: undefined,
      command: ["bun", "run", "verify"],
    });
  });

  it("keeps a -- inside the command", () => {
    expect(parseSandboxExecArgs(["--policy", "p", "--", "sh", "--", "-c"])).toEqual({
      policyPath: "p",
      cwd: undefined,
      command: ["sh", "--", "-c"],
    });
  });

  it("reads an absolute --cwd before --", () => {
    expect(parseSandboxExecArgs(["--policy", "p", "--cwd", "/w", "--", "true"])).toEqual({
      policyPath: "p",
      cwd: "/w",
      command: ["true"],
    });
  });

  it("refuses anything else", () => {
    for (const args of [
      [],
      ["--policy"],
      ["--policy", "p"],
      ["--policy", "p", "--"],
      ["--policy", "", "--", "true"],
      ["--policy", "p", "true"],
      ["true"],
      ["--policy", "p", "--cwd", "--", "true"],
      ["--policy", "p", "--cwd", "rel", "--", "true"],
    ]) {
      expect(parseSandboxExecArgs(args)).toBeNull();
    }
  });
});

describe("runDaemon sandbox-exec", () => {
  it("is a hidden form that prints its usage on bad arguments", async () => {
    const errors: string[] = [];
    const code = await runDaemon(["sandbox-exec", "--policy"], {
      writeError: (line) => errors.push(line),
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("sandbox-exec --policy <file> [--cwd <dir>] -- <cmd>");

    const usage: string[] = [];
    await runDaemon(["nope"], { writeError: (line) => usage.push(line) });
    expect(usage.join("\n")).not.toContain("sandbox-exec");
  });
});
