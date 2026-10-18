// `dipo stats [--office <id>]` (DIPO-65): reads `office.stats` for the office from `--office` or
// the current directory and prints each table's rows and approximate bytes, largest first.

import { describe, expect, it } from "bun:test";

import { DaemonNotRunningError } from "@dipsaus-orchestrator/client/node";
import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl, DaemonSession } from "./daemon-commands";
import { START_HINT } from "./daemon-commands";
import { fakeWorkspace, type FakeWorkspaceOptions } from "./fake-workspace";
import { main, type CliDeps } from "./index";
import { formatBytes, formatStats } from "./stats-command";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const REPO = { mainWorktree: "/work/app", commonDir: "/work/app/.git" };

const NO_LIFECYCLE: DaemonControl = {
  inspect: () => Promise.reject(new Error("inspect must not be called")),
  start: () => Promise.reject(new Error("start must not be called")),
  stop: () => Promise.reject(new Error("stop must not be called")),
  restart: () => Promise.reject(new Error("restart must not be called")),
};

type Sent = { name: string; args: unknown };

function fake(reply: (sent: Sent) => unknown, workspace: FakeWorkspaceOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Sent[] = [];
  const deps: CliDeps = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    runDaemon: async () => {
      throw new Error("runDaemon must not be called");
    },
    connectDaemon: async () => {
      const session: DaemonSession = {
        command: (async () => {
          throw new Error("command must not be called");
        }) as DaemonSession["command"],
        read: (async (definition: { name: string }, args: unknown) => {
          const message = { name: definition.name, args };
          sent.push(message);
          return reply(message);
        }) as DaemonSession["read"],
        subscribe: () => {
          throw new Error("subscribe must not be called");
        },
        close: () => undefined,
      };
      return session;
    },
    daemon: NO_LIFECYCLE,
    clock: new ManualClock(),
    clientChecks: [],
    stamp: undefined,
    runtime: { bun: "1.4.2", os: "linux", arch: "arm64" },
    workspace: fakeWorkspace({ cwd: "/work/app/src", ...workspace }),
  };
  return { deps, out, err, sent };
}

const TABLES = [
  { table: "requests", rows: 31, bytes: 9_300 },
  { table: "change_log", rows: 12_400, bytes: 7_900_000 },
  { table: "stories", rows: 0, bytes: 0 },
];

describe("dipo stats without a daemon (DIPO-187)", () => {
  it("prints the not-running line with the start hint, exits 1 and asks not to start the daemon", async () => {
    const modes: string[] = [];
    const ctx = fake(() => ({ ok: true, result: { tables: TABLES } }), {
      repository: { ...REPO, office: OFFICE, backlog: true },
    });
    const deps: CliDeps = {
      ...ctx.deps,
      connectDaemon: async (mode) => {
        modes.push(mode);
        throw new DaemonNotRunningError("/state", "nothing answers on /state/dipo.sock");
      },
    };
    expect(await main(["stats"], deps)).toBe(1);
    expect(modes).toEqual(["running"]);
    expect(ctx.err).toEqual([
      `dipo: no daemon is running (nothing answers on /state/dipo.sock). ${START_HINT}`,
    ]);
    expect(ctx.out).toEqual([]);
  });
});

describe("dipo stats", () => {
  it("reads office.stats for --office and prints the tables largest first", async () => {
    const ctx = fake(() => ({ ok: true, result: { office: OFFICE, tables: TABLES } }));
    expect(await main(["stats", "--office", OFFICE], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "office.stats", args: { office: OFFICE } }]);
    expect(ctx.out).toEqual([
      `office ${OFFICE}`,
      "table         rows   bytes",
      "change_log  12,400  7.5 MB",
      "requests        31  9.1 KB",
      "stories          0     0 B",
      "total       12,431  7.5 MB",
      "bytes: column data of the office's rows, estimated from a sample; indexes and free pages not counted",
    ]);
  });

  it("uses the office of the current directory", async () => {
    const ctx = fake(() => ({ ok: true, result: { office: OFFICE, tables: [] } }), {
      repository: { ...REPO, office: OFFICE },
    });
    expect(await main(["stats"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "office.stats", args: { office: OFFICE } }]);
  });

  it("reports engine errors and rejects unknown arguments", async () => {
    const failing = fake(() => ({
      ok: false,
      error: { code: "office.pathMissing", message: "path missing", retryable: false },
    }));
    expect(await main(["stats", "--office", OFFICE], failing.deps)).toBe(1);
    expect(failing.err).toEqual(["dipo: office.pathMissing: path missing"]);

    const bad = fake(() => undefined);
    expect(await main(["stats", "--json"], bad.deps)).toBe(2);
    expect(bad.sent).toEqual([]);
  });

  it("formats bytes in binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(formatStats(OFFICE, [])).toContain("total     0    0 B");
  });
});
