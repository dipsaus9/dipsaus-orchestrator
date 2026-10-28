import { describe, expect, it } from "bun:test";

import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { fakeWorkspace } from "./fake-workspace";
import {
  connectFor,
  type ConnectWays,
  HELP,
  main,
  packageName,
  type CliDeps,
  type ClientCheck,
} from "./index";

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

  it("names the read-only commands that never start the daemon (DIPO-187)", () => {
    expect(HELP).toContain("Commands that need the daemon start it");
    expect(HELP).toContain(
      "Read-only commands never start it: dipo gate, dipo run\n--dry-run, dipo stats, dipo desk and dipo watch",
    );
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

  it("runs login through runDaemon as given, without a daemon (DIPO-269)", async () => {
    const { deps, captured } = fakeDeps({ daemonCode: 2 });
    expect(await main(["login", "box"], deps)).toBe(2);
    expect(await main(["login"], deps)).toBe(2);
    expect(captured.daemonCalls).toEqual([["login", "box"], ["login"]]);
    expect(HELP).toContain("dipo login box");
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

describe("connectFor (DIPO-187)", () => {
  type Session = { readonly hello: { readonly engine: string } | null };
  function ways(started: { pid: number; version: string } | null) {
    const calls: string[] = [];
    const session: Session = { hello: { engine: "0.0.0-dev" } };
    const value: ConnectWays<Session> = {
      running: async () => {
        calls.push("running");
        return session;
      },
      orStart: async () => {
        calls.push("orStart");
        return { session, started };
      },
    };
    return { calls, value, session };
  }

  it("reaches only a running daemon for a read-only command and never the start path", async () => {
    const w = ways({ pid: 42, version: "0.0.0-dev" });
    const err: string[] = [];
    expect(await connectFor("running", w.value, "0.0.0-dev", (line) => err.push(line))).toBe(
      w.session,
    );
    expect(w.calls).toEqual(["running"]);
    expect(err).toEqual([]);
  });

  it("may start the daemon for any other command and says so", async () => {
    const w = ways({ pid: 42, version: "0.0.0-dev" });
    const err: string[] = [];
    expect(await connectFor("start", w.value, "0.0.0-dev", (line) => err.push(line))).toBe(
      w.session,
    );
    expect(w.calls).toEqual(["orStart"]);
    expect(err).toEqual(["dipo: started the daemon (pid 42, version 0.0.0-dev)"]);
  });
});

// DIPO-316 AC #1: a state or runtime folder override dipo cannot use stops every command with the
// coded error; `--help`, `--version` and the daemon's own forms (which check it themselves) run.
describe("an unusable DIPO_HOME or DIPO_RUNTIME_DIR", () => {
  const refusal = {
    code: "paths.runtimeDirUnusable",
    message:
      "paths.runtimeDirUnusable: DIPO_RUNTIME_DIR /x/run cannot be used: it is a symlink. Fix or unset DIPO_RUNTIME_DIR; dipo does not fall back to another runtime directory.",
  };

  it("refuses every command with the coded error and exit 78", async () => {
    for (const argv of [
      ["daemon", "status"],
      ["daemon", "start"],
      ["office", "list"],
      ["run", "--dry-run"],
      ["restore", "backup.db"],
      ["login", "box"],
      ["self-check"],
    ]) {
      const { deps, captured } = fakeDeps();
      expect(await main(argv, { ...deps, dirRefusal: () => refusal })).toBe(78);
      expect(captured.err).toEqual([`dipo: ${refusal.message}`]);
      expect(captured.daemonCalls).toEqual([]);
    }
  });

  it("still prints help and the version, and leaves the daemon's own forms to the daemon", async () => {
    for (const argv of [["--help"], ["--version"], ["daemon", "--foreground"], ["hook", "x"]]) {
      const { deps, captured } = fakeDeps();
      expect(await main(argv, { ...deps, dirRefusal: () => refusal })).toBe(0);
      expect(captured.err).toEqual([]);
    }
  });
});
