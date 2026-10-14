import { describe, expect, it } from "bun:test";

import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { fakeWorkspace } from "./fake-workspace";
import { HELP, main, packageName, type CliDeps, type ClientCheck } from "./index";

type Captured = { out: string[]; err: string[]; daemonCalls: string[][] };

function fakeDeps(overrides: { daemonCode?: number; clientChecks?: ClientCheck[] } = {}): {
  deps: CliDeps;
  captured: Captured;
} {
  const captured: Captured = { out: [], err: [], daemonCalls: [] };
  const deps: CliDeps = {
    writeLine: (line) => captured.out.push(line),
    writeError: (line) => captured.err.push(line),
    runDaemon: async (argv) => {
      captured.daemonCalls.push([...argv]);
      captured.out.push("ok   sqlite-wal");
      return overrides.daemonCode ?? 0;
    },
    connectDaemon: async () => {
      throw new Error("connectDaemon must not be called");
    },
    daemon: {
      inspect: () => Promise.reject(new Error("the lifecycle must not be called")),
      start: () => Promise.reject(new Error("the lifecycle must not be called")),
      stop: () => Promise.reject(new Error("the lifecycle must not be called")),
      restart: () => Promise.reject(new Error("the lifecycle must not be called")),
    },
    clock: new ManualClock(),
    clientChecks: overrides.clientChecks ?? [{ name: "ink", run: () => undefined }],
    stamp: { version: "0.0.0-dev", commit: "0123456789ab", commitDate: "2026-10-12" },
    runtime: { bun: "1.4.2", os: "linux", arch: "arm64" },
    workspace: fakeWorkspace(),
  };
  return { deps, captured };
}

describe("cli", () => {
  it("names its package", () => {
    expect(packageName).toBe("@dipsaus-orchestrator/cli");
  });

  it("prints the version", async () => {
    const { deps, captured } = fakeDeps();
    expect(await main(["--version"], deps)).toBe(0);
    expect(captured.out).toEqual([
      "dipo 0.0.0-dev (0123456789ab 2026-10-12) bun 1.4.2 linux-arm64",
    ]);
  });

  it("prints the version as JSON", async () => {
    const { deps, captured } = fakeDeps();
    expect(await main(["--version", "--json"], deps)).toBe(0);
    expect(JSON.parse(captured.out[0] ?? "")).toMatchObject({ version: "0.0.0-dev", os: "linux" });
  });

  it("prints help without the hidden self-check", async () => {
    const { deps, captured } = fakeDeps();
    expect(await main(["--help"], deps)).toBe(0);
    expect(captured.out).toEqual([HELP]);
    expect(HELP).not.toContain("self-check");
  });

  it("rejects unknown arguments", async () => {
    const { deps, captured } = fakeDeps();
    expect(await main(["--version", "--yaml"], deps)).toBe(2);
    expect(captured.err.join("\n")).toContain("unknown arguments");
  });

  it("passes the daemon-side forms to runDaemon without the daemon word", async () => {
    for (const argv of [
      ["daemon", "--foreground", "--log-level", "debug"],
      ["daemon", "worker-host", "run_01"],
      ["daemon", "wait-pid", "42"],
      ["daemon", "sandbox-exec", "--policy", "p.json", "--", "true"],
    ]) {
      const { deps, captured } = fakeDeps({ daemonCode: 3 });
      expect(await main(argv, deps)).toBe(3);
      expect(captured.daemonCalls).toEqual([argv.slice(1)]);
    }
  });

  it("runs restore through runDaemon with the file made absolute (DIPO-76)", async () => {
    const { deps, captured } = fakeDeps({ daemonCode: 1 });
    expect(await main(["restore", "backups/dipo-20261014.db"], deps)).toBe(1);
    expect(await main(["restore", "/abs/dipo.db"], deps)).toBe(1);
    // A usage problem goes as given; the daemon form prints the usage.
    expect(await main(["restore"], deps)).toBe(1);
    expect(captured.daemonCalls).toEqual([
      ["restore", "/work/backups/dipo-20261014.db"],
      ["restore", "/abs/dipo.db"],
      ["restore"],
    ]);
    expect(HELP).toContain("dipo restore <file>");
    expect(HELP).toContain("dipo office purge [--office <id>] [--yes]");
  });

  it("does not send other daemon subcommands to runDaemon", async () => {
    const { deps, captured } = fakeDeps();
    expect(await main(["daemon", "self-check"], deps)).toBe(2);
    expect(await main(["daemon"], deps)).toBe(2);
    expect(captured.daemonCalls).toEqual([]);
  });

  it("runs the daemon-side checks through runDaemon, then the client checks", async () => {
    const { deps, captured } = fakeDeps();
    expect(await main(["self-check"], deps)).toBe(0);
    expect(captured.daemonCalls).toEqual([["self-check"]]);
    expect(captured.out).toEqual(["ok   sqlite-wal", "ok   ink"]);
  });

  it("names the failing check and exits non-zero when a probe throws", async () => {
    let laterRan = false;
    const { deps, captured } = fakeDeps({
      clientChecks: [
        {
          name: "ink",
          run: () => {
            throw new Error("yoga did not load");
          },
        },
        { name: "later", run: () => void (laterRan = true) },
      ],
    });
    expect(await main(["self-check"], deps)).toBe(1);
    expect(captured.out.at(-1)).toBe("fail ink: yoga did not load");
    expect(laterRan).toBe(false);
  });

  it("stops before the client checks when a daemon-side check fails", async () => {
    let inkRan = false;
    const { deps } = fakeDeps({
      daemonCode: 1,
      clientChecks: [{ name: "ink", run: () => void (inkRan = true) }],
    });
    expect(await main(["self-check"], deps)).toBe(1);
    expect(inkRan).toBe(false);
  });
});
