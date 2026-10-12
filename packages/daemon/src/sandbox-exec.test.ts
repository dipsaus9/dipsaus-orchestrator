import { describe, expect, it } from "bun:test";

import { runDaemon } from "./index";
import { parseSandboxExecArgs } from "./sandbox-exec";

describe("parseSandboxExecArgs", () => {
  it("reads the policy file and the command after --", () => {
    expect(parseSandboxExecArgs(["--policy", "/p.json", "--", "bun", "run", "verify"])).toEqual({
      policyPath: "/p.json",
      command: ["bun", "run", "verify"],
    });
  });

  it("keeps a -- inside the command", () => {
    expect(parseSandboxExecArgs(["--policy", "p", "--", "sh", "--", "-c"])).toEqual({
      policyPath: "p",
      command: ["sh", "--", "-c"],
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
    expect(errors.join("\n")).toContain("sandbox-exec --policy <file> -- <cmd>");

    const usage: string[] = [];
    await runDaemon(["nope"], { writeError: (line) => usage.push(line) });
    expect(usage.join("\n")).not.toContain("sandbox-exec");
  });
});
