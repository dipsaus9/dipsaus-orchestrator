// Short `dipo` commands start without the TUI and the daemon packages (DIPO-318): the CLI loads
// each with a dynamic import, only in the subcommands that use it. A `dipo` process from source
// with a preload that reports every TUI or daemon source file it loads runs `--version` and
// `watch` (outside any repository, so it exits before connecting), and reports none; `self-check`
// is the control that loads both.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

const MAIN = join(import.meta.dir, "main.ts");
const RECORDER = join(import.meta.dir, "..", "test", "support", "record-loads.ts");

/** Runs `dipo <args>` from source in `dir`; returns the TUI and daemon files it loaded. */
async function loads(dir: string, args: readonly string[]): Promise<string[]> {
  const proc = Bun.spawn({
    cmd: [process.execPath, "--preload", RECORDER, MAIN, ...args],
    cwd: dir,
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: dir,
      DIPO_HOME: join(dir, "state"),
      DIPO_TMP: dir,
      DIPO_TEST: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("loaded "))
    .map((line) => line.slice("loaded ".length));
}

describe("the TUI and daemon packages load only where they are used", () => {
  it("dipo --version loads neither", () =>
    withTempDir(async (dir) => {
      expect(await loads(dir, ["--version"])).toEqual([]);
    }));

  it("dipo watch loads neither", () =>
    withTempDir(async (dir) => {
      expect(await loads(dir, ["watch"])).toEqual([]);
    }));

  it("the recorder sees them when a command uses them (dipo self-check)", () =>
    withTempDir(async (dir) => {
      const loaded = await loads(dir, ["self-check"]);
      expect(loaded.some((path) => path.includes("/packages/tui/src/"))).toBe(true);
      expect(loaded.some((path) => path.includes("/packages/daemon/src/"))).toBe(true);
    }));
});
