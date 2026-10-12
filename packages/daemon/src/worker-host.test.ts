// The worker-host form never leaves `launch.json` (it holds the task message) behind when it
// refuses to run (DIPO-44 review).

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { defaultIo, type DaemonIo } from "./io";
import { runWorkerHostForm } from "./worker-host";

const RUN = "run_01JZ0000000000000000000001";

function io(env: Record<string, string>, err: string[]): DaemonIo {
  return {
    ...defaultIo,
    env,
    execArgv: [],
    clock: new ManualClock(),
    writeLine: () => {},
    writeError: (line) => err.push(line),
  };
}

function runDirWithLaunch(dir: string, content = "{}"): string {
  const runDir = join(dir, "runs", RUN);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "launch.json"), content);
  return runDir;
}

describe("worker-host form", () => {
  it("removes launch.json when it refuses --no-orphans", () =>
    withTempDir(async (dir) => {
      const runDir = runDirWithLaunch(dir);
      const err: string[] = [];
      const code = await runWorkerHostForm(
        RUN,
        io({ DIPO_RUN_DIR: runDir, BUN_FEATURE_FLAG_NO_ORPHANS: "1" }, err),
      );
      expect(code).toBe(1);
      expect(err.join("\n")).toContain("--no-orphans");
      expect(existsSync(join(runDir, "launch.json"))).toBe(false);
    }));

  it("removes launch.json when the launch is invalid", () =>
    withTempDir(async (dir) => {
      const runDir = runDirWithLaunch(dir, '{"version":1}');
      const err: string[] = [];
      expect(await runWorkerHostForm(RUN, io({ DIPO_RUN_DIR: runDir }, err))).toBe(1);
      expect(err.join("\n")).toContain("worker host failed");
      expect(existsSync(join(runDir, "launch.json"))).toBe(false);
    }));

  it("refuses a relative DIPO_RUN_DIR without touching anything", async () => {
    const err: string[] = [];
    expect(await runWorkerHostForm(RUN, io({ DIPO_RUN_DIR: "runs/x" }, err))).toBe(2);
  });
});
