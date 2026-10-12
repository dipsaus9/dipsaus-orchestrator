import { describe, expect, it } from "bun:test";

import { packageName, runDaemon } from "./index";

describe("daemon", () => {
  it("names its package", () => {
    expect(packageName).toBe("@dipsaus-orchestrator/daemon");
  });

  it("rejects an unknown form with exit code 2", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runDaemon(["no-such-form"], {
      writeLine: (line) => out.push(line),
      writeError: (line) => err.push(line),
      env: {},
    });
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("no-such-form");
  });
});
