// `dipo run [ID...]` (DIPO-48): sends `work.run` for the office of `--office` or of the current
// directory with the resolved main worktree as `from`, prints started and skipped stories with
// their reasons, and exits 0 only when a story started.

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl, DaemonSession } from "./daemon-commands";
import { type FakeWorkspaceOptions, fakeWorkspace } from "./fake-workspace";
import { main, type CliDeps } from "./index";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const OTHER = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C2E" as OfficeId;
const KEY = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C3F";
const KEY_2 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C4G";
const RUN = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C5H";
const REPO = { mainWorktree: "/work/app", commonDir: "/work/app/.git" };
const IN_OFFICE = { repository: { ...REPO, office: OFFICE, backlog: true } };

type Sent = { name: string; args: unknown; office: unknown };

const NO_LIFECYCLE: DaemonControl = {
  inspect: () => Promise.reject(new Error("inspect must not be called")),
  start: () => Promise.reject(new Error("start must not be called")),
  stop: () => Promise.reject(new Error("stop must not be called")),
  restart: () => Promise.reject(new Error("restart must not be called")),
};

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
        command: (async (definition: { name: string }, args: unknown, options: unknown) => {
          const message = {
            name: definition.name,
            args,
            office: (options as { office?: unknown } | undefined)?.office,
          };
          sent.push(message);
          return reply(message);
        }) as DaemonSession["command"],
        subscribe: () => {
          throw new Error("subscribe must not be called");
        },
        read: () => Promise.reject(new Error("read must not be called")),
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

const result = (
  started: { story: string; key: string; run: string }[],
  skipped: { story: string; key: string; reason: string }[] = [],
) => ({ ok: true, changed: started.length > 0, result: { started, skipped } });

describe("dipo run", () => {
  it("starts the engine's pick with from, and prints started and skipped stories with reasons", async () => {
    const ctx = fake(
      () =>
        result(
          [{ story: "DIPO-7", key: KEY, run: RUN }],
          [{ story: "DIPO-8", key: KEY_2, reason: "dependency" }],
        ),
      IN_OFFICE,
    );
    expect(await main(["run"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "work.run", args: { from: "/work/app" }, office: OFFICE }]);
    expect(ctx.out).toEqual([
      `started DIPO-7 (run ${RUN})`,
      "skipped DIPO-8: a dependency is not Done",
    ]);
    expect(ctx.err).toEqual([]);
  });

  it("names stories, upper-cases ids, keeps keys, and sends no from with --office", async () => {
    const ctx = fake(() => result([], [{ story: "DIPO-7", key: KEY, reason: "capacity" }]));
    expect(await main(["run", "dipo-7", KEY, "--office", OTHER], ctx.deps)).toBe(1);
    expect(ctx.sent).toEqual([
      { name: "work.run", args: { stories: ["DIPO-7", KEY] }, office: OTHER },
    ]);
    expect(ctx.out).toEqual(["skipped DIPO-7: the office already runs a story"]);
  });

  it("says so when nothing was Ready, and prints an unknown reason as it is", async () => {
    const empty = fake(() => result([]), IN_OFFICE);
    expect(await main(["run"], empty.deps)).toBe(1);
    expect(empty.out).toEqual(["no Ready story to start"]);
    const later = fake(
      () => result([], [{ story: "DIPO-7", key: KEY, reason: "tooSoon" }]),
      IN_OFFICE,
    );
    expect(await main(["run"], later.deps)).toBe(1);
    expect(later.out).toEqual(["skipped DIPO-7: tooSoon"]);
  });

  it("prints a refusal and exits 1", async () => {
    const ctx = fake(
      () => ({
        ok: false,
        error: {
          code: "git.fetchFailed",
          message: "Fetching origin failed (offline).",
          retryable: true,
        },
      }),
      IN_OFFICE,
    );
    expect(await main(["run"], ctx.deps)).toBe(1);
    expect(ctx.err.join("\n")).toContain("git.fetchFailed: Fetching origin failed (offline).");
  });

  it("refuses a malformed id and unknown arguments", async () => {
    for (const args of [
      ["run", "seven!"],
      ["run", "--yes"],
    ]) {
      const ctx = fake(() => result([]), IN_OFFICE);
      expect(await main(args, ctx.deps)).toBe(2);
      expect(ctx.sent).toEqual([]);
    }
  });
});
