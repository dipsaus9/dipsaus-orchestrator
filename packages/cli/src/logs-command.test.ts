// `dipo daemon logs` (DIPO-64): reads the files directly, with no daemon to talk to, and filters.

import { describe, expect, it } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl } from "./daemon-commands";
import { fakeWorkspace } from "./fake-workspace";
import { main, type CliDeps } from "./index";
import { LOGS_USAGE, parseLogsArgs } from "./logs-command";

const NO_DAEMON: DaemonControl = {
  inspect: () => Promise.reject(new Error("inspect must not be called")),
  start: () => Promise.reject(new Error("start must not be called")),
  stop: () => Promise.reject(new Error("stop must not be called")),
  restart: () => Promise.reject(new Error("restart must not be called")),
};

function fake(dir: string, stop?: AbortSignal) {
  const out: string[] = [];
  const err: string[] = [];
  const clock = new ManualClock();
  const deps: CliDeps = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    runDaemon: () => Promise.reject(new Error("runDaemon must not be called")),
    connectDaemon: () => Promise.reject(new Error("the daemon must not be contacted")),
    daemon: NO_DAEMON,
    clock,
    clientChecks: [],
    stamp: undefined,
    runtime: { bun: "1.4.2", os: "linux", arch: "arm64" },
    workspace: fakeWorkspace(),
    logs: stop === undefined ? { dir } : { dir, stop },
  };
  return { deps, out, err, clock };
}

const line = (msg: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ ts: "2026-10-13T08:00:00.000Z", level: "info", msg, component: "daemon", ...extra })}\n`;

describe("parseLogsArgs", () => {
  it("reads -f, --office, --run and --level", () => {
    expect(parseLogsArgs([])).toEqual({ follow: false, filter: {} });
    expect(parseLogsArgs(["-f", "--office", "off_1", "--run", "run_1", "--level", "warn"])).toEqual(
      { follow: true, filter: { office: "off_1", run: "run_1", level: "warn" } },
    );
    expect(parseLogsArgs(["--follow"])).toEqual({ follow: true, filter: {} });
  });

  it("refuses unknown, repeated or incomplete options", () => {
    for (const args of [
      ["--level", "loud"],
      ["--office"],
      ["--office", "--run", "r"],
      ["--run", "a", "--run", "b"],
      ["-f", "-f"],
      ["--json"],
      ["extra"],
    ]) {
      expect(parseLogsArgs(args)).toBe(LOGS_USAGE);
    }
  });
});

describe("dipo daemon logs", () => {
  it("prints the rotated files and daemon.log, rendered, without a daemon", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "daemon.log.1"), line("older"));
      writeFileSync(join(dir, "daemon.log"), line("newer", { pid: 7 }));
      const ctx = fake(dir);
      expect(await main(["daemon", "logs"], ctx.deps)).toBe(0);
      expect(ctx.out).toEqual([
        "2026-10-13T08:00:00.000Z INFO  [daemon] older",
        "2026-10-13T08:00:00.000Z INFO  [daemon] newer pid=7",
      ]);
      expect(ctx.err).toEqual([]);
    });
  });

  it("filters by office, run and level", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(
        join(dir, "daemon.log"),
        line("a", { office: "off_1", run: "run_1", level: "warn" }) +
          line("b", { office: "off_1", run: "run_2", level: "warn" }) +
          line("c", { office: "off_1", run: "run_1", level: "debug" }) +
          line("d", { office: "off_2", run: "run_1", level: "error" }),
      );
      const ctx = fake(dir);
      const args = ["daemon", "logs", "--office", "off_1", "--run", "run_1", "--level", "warn"];
      expect(await main(args, ctx.deps)).toBe(0);
      expect(ctx.out).toEqual(["2026-10-13T08:00:00.000Z WARN  [daemon office=off_1 run=run_1] a"]);
    });
  });

  it("says so when there is no log yet", async () => {
    await withTempDir(async (dir) => {
      const ctx = fake(join(dir, "logs"));
      expect(await main(["daemon", "logs"], ctx.deps)).toBe(0);
      expect(ctx.out).toEqual([]);
      expect(ctx.err).toEqual([`dipo: no daemon log in ${join(dir, "logs")} yet.`]);
    });
  });

  it("prints usage for bad options", async () => {
    await withTempDir(async (dir) => {
      const ctx = fake(dir);
      expect(await main(["daemon", "logs", "--level", "loud"], ctx.deps)).toBe(2);
      expect(ctx.err[0]).toBe(`dipo: ${LOGS_USAGE}\nRun \`dipo --help\` for usage.`);
    });
  });

  it("-f keeps printing new lines until it is stopped", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "daemon.log");
      writeFileSync(path, line("first"));
      const stop = new AbortController();
      const ctx = fake(dir, stop.signal);
      const done = main(["daemon", "logs", "-f", "--level", "info"], ctx.deps);
      expect(ctx.out).toEqual(["2026-10-13T08:00:00.000Z INFO  [daemon] first"]);
      appendFileSync(path, line("second") + line("hidden", { level: "debug" }));
      ctx.clock.advance(250);
      expect(ctx.out).toHaveLength(2);
      expect(ctx.out[1]).toBe("2026-10-13T08:00:00.000Z INFO  [daemon] second");
      stop.abort();
      expect(await done).toBe(0);
    });
  });
});
