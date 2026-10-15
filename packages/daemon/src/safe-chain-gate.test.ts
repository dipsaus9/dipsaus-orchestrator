import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { systemClock } from "@dipsaus-orchestrator/engine";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { runDaemon } from "./index";
import { parseSafeChainGateArgs, runSafeChainGateForm } from "./safe-chain-gate";

describe("parseSafeChainGateArgs", () => {
  it("reads one absolute --dir", () => {
    expect(parseSafeChainGateArgs(["--dir", "/tmp/dipo-p-x"])).toEqual({ dir: "/tmp/dipo-p-x" });
  });

  it("refuses anything else", () => {
    for (const args of [[], ["--dir"], ["--dir", "rel"], ["--dir", "/a", "/b"], ["/a"]]) {
      expect(parseSafeChainGateArgs(args)).toBeNull();
    }
  });
});

describe("runDaemon safe-chain-gate", () => {
  it("is a hidden form that prints its usage on bad arguments", async () => {
    const errors: string[] = [];
    expect(await runDaemon(["safe-chain-gate"], { writeError: (line) => errors.push(line) })).toBe(
      2,
    );
    expect(errors.join("\n")).toContain("safe-chain-gate --dir <dir>");
    const usage: string[] = [];
    await runDaemon(["nope"], { writeError: (line) => usage.push(line) });
    expect(usage.join("\n")).not.toContain("safe-chain-gate");
  });

  it("reports not ready when Safe-Chain cannot start, and exits 1", () =>
    withTempDir(async (dir) => {
      // A "Safe-Chain" that exits at once: the gate never gets a holder report.
      const bin = join(dir, "sc", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "safe-chain"), "#!/bin/sh\necho no proxy here >&2\nexit 3\n", {
        mode: 0o700,
      });
      mkdirSync(join(dir, "out"), { recursive: true });
      mkdirSync(join(dir, "home"), { recursive: true });
      const lines: string[] = [];
      const errors: string[] = [];
      const code = await runSafeChainGateForm(
        ["--dir", dir],
        {
          writeLine: (line) => lines.push(line),
          writeError: (line) => errors.push(line),
          env: { PATH: "/usr/bin:/bin" },
          execArgv: [],
          version: "test",
          onShutdownSignal: () => () => {},
          clock: systemClock,
        },
        () => new Promise(() => {}),
      );
      expect(code).toBe(1);
      const report = JSON.parse(lines[0] ?? "{}");
      expect(report.ready).toBe(false);
      expect(report.reason).toContain("the npm Safe-Chain process exited before its proxy started");
      expect(report.reason).toContain("no proxy here");
    }));
});
