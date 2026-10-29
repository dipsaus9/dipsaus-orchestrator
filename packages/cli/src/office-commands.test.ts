// `dipo office open|forget|reload-config|init` (DIPO-27, DIPO-36): the office comes from `--office`, else from the
// repository around the current directory; an unregistered Backlog.md project prints "not an
// office, run `dipo office open`" and a terminal is asked once to open it.

import { describe, expect, it } from "bun:test";

import { type OfficeId, workRun } from "@dipsaus-orchestrator/contract";
import { RECOVERY_POLL_MS } from "@dipsaus-orchestrator/client";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import {
  type DaemonControl,
  type DaemonSession,
  engineFailure,
  REPLY_TIMEOUT_MS,
  withDaemon,
} from "./daemon-commands";
import { type FakeWorkspaceOptions, fakeWorkspace } from "../test/support/fake-workspace";
import { main, type CliDeps } from "./index";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const OTHER = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C2E" as OfficeId;
const REPO = { mainWorktree: "/work/app", commonDir: "/work/app/.git" };

type Sent = { name: string; args: unknown };
type Handler = (sent: Sent) => unknown;

const NO_LIFECYCLE: DaemonControl = {
  inspect: () => Promise.reject(new Error("inspect must not be called")),
  start: () => Promise.reject(new Error("start must not be called")),
  stop: () => Promise.reject(new Error("stop must not be called")),
  restart: () => Promise.reject(new Error("restart must not be called")),
};

function fake(handler: Handler, workspace: FakeWorkspaceOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Sent[] = [];
  let connections = 0;
  const ws = fakeWorkspace({ cwd: "/work/app/src", ...workspace });
  const deps: CliDeps = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    runDaemon: async () => {
      throw new Error("runDaemon must not be called");
    },
    connectDaemon: async () => {
      connections += 1;
      const session: DaemonSession = {
        command: (async (definition: { name: string }, args: unknown) => {
          const message = { name: definition.name, args };
          sent.push(message);
          return handler(message);
        }) as DaemonSession["command"],
        subscribe: () => {
          throw new Error("subscribe must not be called");
        },
        read: (async () => {
          throw new Error("read must not be called");
        }) as DaemonSession["read"],
        close: () => undefined,
      };
      return session;
    },
    daemon: NO_LIFECYCLE,
    clock: new ManualClock(),
    clientChecks: [],
    stamp: undefined,
    runtime: { bun: "1.4.2", os: "linux", arch: "arm64" },
    workspace: ws,
  };
  return { deps, out, err, sent, questions: ws.questions, connections: () => connections };
}

const ok = (result: unknown, changed = true) => ({ ok: true, result, changed });
const unknownOffice = {
  ok: false,
  error: { code: "office.unknown", message: "no such office", retryable: false },
};

describe("dipo office open", () => {
  it("opens the current directory by default and prints the office id", async () => {
    const ctx = fake(() => ok({ office: OFFICE, registered: true }));
    expect(await main(["office", "open"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "office.open", args: { path: "/work/app/src" } }]);
    expect(ctx.out).toEqual([`opened /work/app/src as office ${OFFICE}`]);
  });

  it("resolves a relative path, says when nothing changed and prints warnings", async () => {
    const ctx = fake(() =>
      ok({ office: OFFICE, registered: false, warnings: ["on a network filesystem"] }, false),
    );
    expect(await main(["office", "open", "../other"], ctx.deps)).toBe(0);
    expect(ctx.sent[0]?.args).toEqual({ path: "/work/app/other" });
    expect(ctx.out).toEqual([`/work/app/other is already office ${OFFICE}`]);
    expect(ctx.err).toEqual(["dipo: warning: on a network filesystem"]);
  });

  it("prints the engine error for a path that is not a project", async () => {
    const ctx = fake(() => ({
      ok: false,
      error: { code: "office.notProject", message: "no Backlog.md", retryable: false },
    }));
    expect(await main(["office", "open", "/tmp/x"], ctx.deps)).toBe(1);
    expect(ctx.err).toEqual(["dipo: office.notProject: no Backlog.md"]);
  });
});

describe("dipo office reload-config", () => {
  it("uses --office", async () => {
    const ctx = fake(() =>
      ok({ office: OTHER, valid: true, errors: [], configHash: "a".repeat(64) }),
    );
    expect(await main(["office", "reload-config", "--office", OTHER], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "office.reloadConfig", args: { office: OTHER } }]);
    expect(ctx.out).toEqual([`office ${OTHER}: configuration valid (aaaaaaaaaaaa)`]);
  });

  it("uses the office of the current directory and reports an invalid configuration", async () => {
    const ctx = fake(
      () =>
        ok({
          office: OFFICE,
          valid: false,
          errors: [{ file: "f", path: "p", expected: "e", message: "f: p: expected e" }],
          configHash: "b".repeat(64),
        }),
      { repository: { ...REPO, office: OFFICE, backlog: true } },
    );
    expect(await main(["office", "reload-config"], ctx.deps)).toBe(1);
    expect(ctx.sent[0]?.args).toEqual({ office: OFFICE, from: "/work/app" });
    expect(ctx.out).toEqual([
      `office ${OFFICE}: configuration invalid; new runs are refused until it is fixed`,
      "  f: p: expected e",
      "  running work keeps the previous configuration (bbbbbbbbbbbb)",
    ]);
  });

  it("prints 'not an office' in an unregistered Backlog.md project without asking a script", async () => {
    const ctx = fake(() => ok({}), { repository: { ...REPO, backlog: true } });
    expect(await main(["office", "reload-config"], ctx.deps)).toBe(1);
    expect(ctx.err).toEqual(["dipo: not an office, run `dipo office open`"]);
    expect(ctx.questions).toEqual([]);
    expect(ctx.connections()).toBe(0);
  });

  it("asks a terminal once and opens the project, then runs the command", async () => {
    const ctx = fake(
      ({ name }) =>
        name === "office.open"
          ? ok({ office: OFFICE, registered: true })
          : ok({ office: OFFICE, valid: true, errors: [] }, false),
      { repository: { ...REPO, backlog: true }, interactive: true, answers: ["y"] },
    );
    expect(await main(["office", "reload-config"], ctx.deps)).toBe(0);
    expect(ctx.err).toEqual(["dipo: not an office, run `dipo office open`"]);
    expect(ctx.questions).toEqual(["Open /work/app as an office now? [y/N] "]);
    expect(ctx.sent).toEqual([
      { name: "office.open", args: { path: "/work/app" } },
      { name: "office.reloadConfig", args: { office: OFFICE, from: "/work/app" } },
    ]);
    expect(ctx.out).toEqual([
      `opened /work/app as office ${OFFICE}`,
      `office ${OFFICE}: configuration valid`,
    ]);
  });

  it("treats a forgotten office's marker as not an office and stops on no", async () => {
    const ctx = fake(() => unknownOffice, {
      repository: { ...REPO, office: OFFICE, backlog: true },
      interactive: true,
      answers: ["n"],
    });
    expect(await main(["office", "reload-config"], ctx.deps)).toBe(1);
    expect(ctx.err).toEqual(["dipo: not an office, run `dipo office open`"]);
    expect(ctx.questions).toHaveLength(1);
    expect(ctx.sent.map((sent) => sent.name)).toEqual(["office.reloadConfig"]);
  });

  it("says when the current directory is outside git or not a Backlog.md project", async () => {
    const outside = fake(() => ok({}));
    expect(await main(["office", "reload-config"], outside.deps)).toBe(1);
    expect(outside.err[0]).toContain("is not inside a git repository; pass --office <id>");

    const plain = fake(() => ok({}), { repository: { ...REPO, backlog: false } });
    expect(await main(["office", "reload-config"], plain.deps)).toBe(1);
    expect(plain.err[0]).toBe(
      "dipo: /work/app is not a Backlog.md project; pass --office <id> or run this in an office.",
    );
  });

  it("rejects a bad --office", async () => {
    const ctx = fake(() => ok({}));
    expect(await main(["office", "reload-config", "--office", "nope"], ctx.deps)).toBe(2);
  });
});

describe("dipo office forget", () => {
  it("asks for confirmation at a terminal before connecting", async () => {
    const ctx = fake(() => ok({ office: OFFICE, path: "/work/app" }), {
      repository: { ...REPO, office: OFFICE, backlog: true },
      interactive: true,
      answers: ["yes"],
    });
    expect(await main(["office", "forget"], ctx.deps)).toBe(0);
    expect(ctx.questions[0]).toMatch(/^Forget the office at \/work\/app\? /);
    expect(ctx.sent).toEqual([
      { name: "office.forget", args: { office: OFFICE, from: "/work/app" } },
    ]);
    expect(ctx.out).toEqual([`forgot office ${OFFICE} at /work/app`]);
  });

  it("names the office id in the prompt only with --office", async () => {
    const ctx = fake(() => ok({ office: OTHER, path: "/elsewhere" }), {
      interactive: true,
      answers: ["y"],
    });
    expect(await main(["office", "forget", "--office", OTHER], ctx.deps)).toBe(0);
    expect(ctx.questions[0]).toMatch(new RegExp(`^Forget office ${OTHER}\\? `));
    expect(ctx.sent).toEqual([{ name: "office.forget", args: { office: OTHER } }]);
    expect(ctx.out).toEqual([`forgot office ${OTHER} at /elsewhere`]);
  });

  it("needs --yes in a script and sends nothing without it", async () => {
    const without = fake(() => ok({ office: OFFICE }));
    expect(await main(["office", "forget", "--office", OFFICE], without.deps)).toBe(1);
    expect(without.sent).toEqual([]);
    expect(without.connections()).toBe(0);

    const withYes = fake(() => ok({ office: OFFICE }, false));
    expect(await main(["office", "forget", "--office", OFFICE, "--yes"], withYes.deps)).toBe(0);
    expect(withYes.out).toEqual([`office ${OFFICE} was already forgotten`]);
  });

  it("reports office.busy", async () => {
    const ctx = fake(() => ({
      ok: false,
      error: { code: "office.busy", message: "has active work", retryable: false },
    }));
    expect(await main(["office", "forget", "--office", OFFICE, "--yes"], ctx.deps)).toBe(1);
    expect(ctx.err).toEqual(["dipo: office.busy: has active work"]);
  });
});

describe("dipo office rescan", () => {
  type Subscribe = DaemonSession["subscribe"];
  type Options = Parameters<Subscribe>[1];

  /**
   * A session that answers `office.rescan` with `reply` and then, when given, delivers `data` as
   * `scan.finished` on the office stream, after an unrelated one from a load scan.
   */
  function rescanFake(reply: unknown, data?: Record<string, unknown>) {
    const ctx = fake(() => reply, { repository: { ...REPO, office: OFFICE, backlog: true } });
    const subscribed: { stream: string; filter: readonly string[] | undefined }[] = [];
    let listener: Options | null = null;
    let unsubscribed = 0;
    const event = (eventData: Record<string, unknown>) => ({
      cursor: { stream: `office:${OFFICE}`, seq: 1 },
      at: "2026-10-13T09:00:00Z",
      type: "scan.finished",
      data: eventData,
    });
    // As the daemon does: `filter` names the event type prefixes left out (0005 section 5).
    const deliver = (sent: ReturnType<typeof event>) => {
      if (listener?.filter?.some((prefix) => sent.type.startsWith(prefix)) === true) return;
      listener?.onEvent(sent as never);
    };
    const inner = ctx.deps.connectDaemon;
    const deps: CliDeps = {
      ...ctx.deps,
      connectDaemon: async (mode) => {
        const session = await inner(mode);
        return {
          ...session,
          command: (async (definition: unknown, args: unknown, options: unknown) => {
            const result = await session.command(
              definition as Parameters<DaemonSession["command"]>[0],
              args as never,
              options as never,
            );
            if (data !== undefined) {
              deliver(event({ scripts: {}, warnings: [], trigger: "start" }));
              deliver(event(data));
            }
            return result;
          }) as DaemonSession["command"],
          subscribe: ((stream, options) => {
            subscribed.push({ stream, filter: options.filter });
            listener = options;
            queueMicrotask(() => options.onCaughtUp?.({ stream, seq: 0 } as never));
            return {
              stream,
              cursor: undefined,
              unsubscribe: () => {
                unsubscribed += 1;
              },
            };
          }) as Subscribe,
        };
      },
    };
    return { ...ctx, deps, subscribed, unsubscribed: () => unsubscribed };
  }

  it("prints the diff, the conformance level and each deviation", async () => {
    const ctx = rescanFake(ok({ scan: "started" }, false), {
      scripts: { verify: "bun run verify" },
      warnings: ["Fetching origin failed (offline). The scan used local refs.", "No dev script."],
      deviations: ["No dev script."],
      trigger: "rescan",
      level: "partial",
      diff: ["~ verify: bun run test -> bun run verify"],
    });
    expect(await main(["office", "rescan"], ctx.deps)).toBe(0);
    expect(ctx.subscribed).toEqual([{ stream: `office:${OFFICE}`, filter: undefined }]);
    expect(ctx.sent).toEqual([{ name: "office.rescan", args: {} }]);
    expect(ctx.out).toEqual([
      `office ${OFFICE}: rescanned, conformance partial`,
      "changes since the previous profile:",
      "  ~ verify: bun run test -> bun run verify",
      "deviations from the script standard:",
      "  - No dev script.",
    ]);
    expect(ctx.err).toEqual([
      "dipo: warning: Fetching origin failed (offline). The scan used local refs.",
    ]);
    expect(ctx.unsubscribed()).toBe(1);
  });

  it("says when nothing changed and nothing deviates", async () => {
    const ctx = rescanFake(ok({ scan: "started" }, false), {
      scripts: {},
      warnings: [],
      deviations: [],
      trigger: "rescan",
      level: "conforming",
      diff: [],
    });
    expect(await main(["office", "rescan", "--office", OFFICE], ctx.deps)).toBe(0);
    expect(ctx.out).toEqual([
      `office ${OFFICE}: rescanned, conformance conforming`,
      "no changes since the previous profile",
      "no deviations from the script standard",
    ]);
  });

  it("reports a failed scan", async () => {
    const ctx = rescanFake(ok({ scan: "started" }, false), {
      scripts: {},
      warnings: [],
      trigger: "rescan",
      error: "origin/main does not exist",
    });
    expect(await main(["office", "rescan"], ctx.deps)).toBe(1);
    expect(ctx.err).toEqual([
      `dipo: the rescan of office ${OFFICE} failed: origin/main does not exist`,
    ]);
  });

  it("reports scan.running", async () => {
    const ctx = rescanFake({
      ok: false,
      error: { code: "scan.running", message: "already running", retryable: false },
    });
    expect(await main(["office", "rescan"], ctx.deps)).toBe(1);
    expect(ctx.err).toEqual(["dipo: scan.running: already running"]);
    expect(ctx.unsubscribed()).toBe(1);
  });

  /**
   * A session whose office stream is refused `refusals` times with `refusal` before it is accepted;
   * the scan's event follows the rescan command.
   */
  function refusingRescan(refusal: { code: string; message: string }, refusals: number) {
    const ctx = fake(() => ok({ scan: "started" }, false), {
      repository: { ...REPO, office: OFFICE, backlog: true },
    });
    const subscribed: Options[] = [];
    let listener: Options | null = null;
    const inner = ctx.deps.connectDaemon;
    const deps: CliDeps = {
      ...ctx.deps,
      connectDaemon: async (mode) => {
        const session = await inner(mode);
        return {
          ...session,
          command: (async (definition: unknown, args: unknown, options: unknown) => {
            const result = await session.command(
              definition as Parameters<DaemonSession["command"]>[0],
              args as never,
              options as never,
            );
            listener?.onEvent({
              cursor: { stream: `office:${OFFICE}`, seq: 1 },
              at: "2026-10-23T09:00:00Z",
              type: "scan.finished",
              data: { scripts: {}, warnings: [], trigger: "rescan", level: "partial" },
            } as never);
            return result;
          }) as DaemonSession["command"],
          subscribe: ((stream, options) => {
            subscribed.push(options);
            if (subscribed.length <= refusals) {
              queueMicrotask(() => options.onEnded?.(refusal as never));
            } else {
              listener = options;
              queueMicrotask(() => options.onCaughtUp?.({ stream, seq: 0 } as never));
            }
            return { stream, cursor: undefined, unsubscribe: () => undefined };
          }) as Subscribe,
        };
      },
    };
    return { ...ctx, deps, subscribed };
  }

  it("waits for a recovering daemon before the scan stream is subscribed, then rescans (DIPO-325)", async () => {
    const ctx = refusingRescan({ code: "engine.recovering", message: "recovering" }, 1);
    const code = main(["office", "rescan"], ctx.deps);
    await settle();
    expect(ctx.subscribed).toHaveLength(1);
    (ctx.deps.clock as ManualClock).advance(RECOVERY_POLL_MS);
    await settle();
    expect(await code).toBe(0);
    expect(ctx.subscribed).toHaveLength(2);
    expect(ctx.sent).toEqual([{ name: "office.rescan", args: {} }]);
    expect(ctx.out).toEqual([
      `office ${OFFICE}: rescanned, conformance partial`,
      "no changes since the previous profile",
      "no deviations from the script standard",
    ]);
    expect(ctx.err).toEqual([]);
  });

  it("ends with the stream's error, not an unhandled rejection, when the scan stream closes", async () => {
    const ctx = refusingRescan({ code: "stream.resetRequired", message: "history gap" }, 1);
    expect(await main(["office", "rescan"], ctx.deps)).toBe(1);
    expect(ctx.err).toEqual(["dipo: stream.resetRequired: history gap"]);
    expect(ctx.sent).toEqual([]);
  });
});

describe("dipo office init", () => {
  const PR = { number: 12, url: "https://github.com/o/r/pull/12" };

  it("sends office.init for --office and prints the backlog PR and the stories left alone", async () => {
    const ctx = fake(() =>
      ok({ office: OTHER, pr: PR, branch: "dipo/backlog-x", leftAlone: ["DIPO-36"] }),
    );
    expect(await main(["office", "init", "--office", OTHER], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "office.init", args: { office: OTHER } }]);
    expect(ctx.out).toEqual([
      "left DIPO-36 at To Do: a branch DIPO-36/... exists; if it is left over, delete it and run dipo office init again",
      `office ${OTHER}: init steps committed to the backlog PR #12 ${PR.url}`,
      "dipo merges it once its structural check and required checks pass",
    ]);
  });

  it("uses the office of the current directory and says when nothing changed", async () => {
    const ctx = fake(() => ok({ office: OFFICE }, false), {
      repository: { ...REPO, office: OFFICE, backlog: true },
    });
    expect(await main(["office", "init"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "office.init", args: { office: OFFICE } }]);
    expect(ctx.out).toEqual([`office ${OFFICE}: the backlog is already initialised`]);
  });

  it("prints the waiting branch, and fails when the steps could not be applied", async () => {
    const waiting = fake(() =>
      ok({ office: OTHER, branch: "dipo/backlog-x", waiting: "the office has no remote origin" }),
    );
    expect(await main(["office", "init", "--office", OTHER], waiting.deps)).toBe(0);
    expect(waiting.out).toEqual([
      `office ${OTHER}: init steps on dipo/backlog-x, waiting: the office has no remote origin`,
    ]);

    const failed = fake(() => ok({ office: OTHER, waiting: "git commit failed" }));
    expect(await main(["office", "init", "--office", OTHER], failed.deps)).toBe(1);
    expect(failed.err).toEqual(["dipo: office init could not apply its steps: git commit failed"]);
  });

  it("reports an unknown office and an engine error", async () => {
    const unknown = fake(() => unknownOffice);
    expect(await main(["office", "init", "--office", OTHER], unknown.deps)).toBe(1);
    expect(unknown.err).toEqual([`dipo: office.unknown: there is no office ${OTHER}.`]);

    const unreadable = fake(() => ({
      ok: false,
      error: { code: "backlog.unreadable", message: "no backlog", retryable: false },
    }));
    expect(await main(["office", "init", "--office", OTHER], unreadable.deps)).toBe(1);
    expect(unreadable.err).toEqual(["dipo: backlog.unreadable: no backlog"]);
  });

  it("refuses an unknown argument", async () => {
    const ctx = fake(() => ok({}));
    expect(await main(["office", "init", "--yes"], ctx.deps)).toBe(2);
    expect(ctx.sent).toEqual([]);
  });
});

describe("a command against a recovering daemon", () => {
  const RECOVERING = { code: "engine.recovering", message: "recovering", retryable: true };

  /**
   * The daemon refuses the first `refusals` commands with `engine.recovering`, and every command
   * while the last `daemon.status` said `starting` or `recovering`, then answers with `answer`;
   * `daemon.status` reports `states` one per poll, the last one repeating. With `held`, the
   * state is ignored: the daemon answers `answer` once the refusals are used up, as a daemon held
   * in `recovering` does.
   */
  function recovering(
    refusals: number,
    states: string[],
    answer: unknown = ok({ office: OFFICE, registered: true }),
    reason?: string,
    held = false,
  ) {
    let last = "recovering";
    const ctx = fake(() =>
      refusals-- > 0 || (!held && (last === "starting" || last === "recovering"))
        ? { ok: false, error: RECOVERING }
        : answer,
    );
    const clock = ctx.deps.clock as ManualClock;
    const ids: unknown[] = [];
    let polls = 0;
    const deps: CliDeps = {
      ...ctx.deps,
      connectDaemon: async (mode) => {
        const session = await ctx.deps.connectDaemon(mode);
        return {
          ...session,
          command: ((definition: never, args: never, options: { requestId?: unknown }) => {
            ids.push(options.requestId);
            return session.command(definition, args, options as never);
          }) as DaemonSession["command"],
          read: (async (definition: { name: string }) => {
            expect(definition.name).toBe("daemon.status");
            polls += 1;
            const state = states.length > 1 ? states.shift() : states[0];
            last = state ?? "running";
            return { ok: true, result: { state, ...(reason ? { stateReason: reason } : {}) } };
          }) as DaemonSession["read"],
        };
      },
    };
    /** Moves the clock poll by poll, letting the replies through after each step. */
    const advance = async (ms: number) => {
      for (let at = 0; at < ms; at += RECOVERY_POLL_MS) {
        await settle();
        clock.advance(Math.min(RECOVERY_POLL_MS, ms - at));
      }
      await settle();
    };
    return { ...ctx, deps, ids, advance, polls: () => polls };
  }

  it("dipo office open waits out two engine.recovering replies and succeeds", async () => {
    const ctx = recovering(2, ["running"]);
    const code = main(["office", "open"], ctx.deps);
    await ctx.advance(2 * RECOVERY_POLL_MS);
    expect(await code).toBe(0);
    expect(ctx.sent.map((sent) => sent.name)).toEqual([
      "office.open",
      "office.open",
      "office.open",
    ]);
    expect(ctx.ids).toHaveLength(3);
    expect(new Set(ctx.ids).size).toBe(1);
    expect(ctx.ids[0]).toEqual(expect.any(String));
    expect(ctx.polls()).toBe(2);
    expect(ctx.out).toEqual([`opened /work/app/src as office ${OFFICE}`]);
    // Half a second of waiting says nothing.
    expect(ctx.err).toEqual([]);
  });

  it("says once that it waits when recovery takes longer than a second", async () => {
    const ctx = recovering(1, ["recovering", "recovering", "recovering", "recovering", "running"]);
    const code = main(["office", "open"], ctx.deps);
    await ctx.advance(5 * RECOVERY_POLL_MS);
    expect(await code).toBe(0);
    expect(ctx.err).toEqual(["dipo: waiting for the daemon to finish recovering"]);
    expect(ctx.out).toEqual([`opened /work/app/src as office ${OFFICE}`]);
  });

  it("names safe mode and resume-scheduling when recovery ends in safe", async () => {
    const ctx = recovering(1, ["recovering", "safe"], undefined, "crash loop");
    const code = main(["office", "open"], ctx.deps);
    await ctx.advance(2 * RECOVERY_POLL_MS);
    // Office commands run in safe (0006 decision 7); the maintainer is told scheduling is off.
    expect(await code).toBe(0);
    expect(ctx.err).toEqual([
      "dipo: the daemon finished recovering in safe mode (crash loop): scheduling is off until you run `dipo daemon resume-scheduling`.",
    ]);
  });

  it("fails a command that schedules work in safe with the safe-mode line, not a timeout", async () => {
    const off = {
      code: "scheduling.off",
      message: "Scheduling is off (crash loop); run `dipo daemon resume-scheduling` to turn it on.",
      retryable: true,
    };
    const ctx = recovering(1, ["safe"], { ok: false, error: off }, "crash loop");
    const deps = { ...ctx.deps, version: "0.0.0-test" };
    const code = withDaemon(deps, async (session) => {
      const outcome = await session.command(workRun, {}, { office: OFFICE });
      return outcome.ok ? 0 : engineFailure(deps, outcome.error);
    });
    await ctx.advance(RECOVERY_POLL_MS);
    expect(await code).toBe(1);
    expect(ctx.err).toEqual([
      "dipo: the daemon finished recovering in safe mode (crash loop): scheduling is off until you run `dipo daemon resume-scheduling`.",
      "dipo: scheduling.off: Scheduling is off (crash loop); run `dipo daemon resume-scheduling` to turn it on.",
    ]);
  });

  it("ends a command sent before the migrations failed with database.unavailable", async () => {
    const unavailable = {
      code: "database.unavailable",
      message:
        "The state database is damaged. No office is loaded. Run `dipo daemon stop`, then `dipo restore /s/backups/dipo-20261015.db`.",
      retryable: false,
      details: { reason: "damaged", backup: "/s/backups/dipo-20261015.db" },
    };
    const ctx = recovering(2, ["recovering"], { ok: false, error: unavailable }, undefined, true);
    const code = main(["office", "open"], ctx.deps);
    await ctx.advance(2 * RECOVERY_POLL_MS);
    expect(await code).toBe(1);
    expect(ctx.ids).toHaveLength(3);
    expect(new Set(ctx.ids).size).toBe(1);
    expect(ctx.err).toEqual([`dipo: database.unavailable: ${unavailable.message}`]);
    expect((ctx.deps.clock as ManualClock).pendingTimers).toBe(0);
  });

  it("gives up at the reply deadline with a line that says the daemon is still recovering", async () => {
    const ctx = recovering(Infinity, ["recovering"]);
    const code = main(["office", "open"], ctx.deps);
    await ctx.advance(REPLY_TIMEOUT_MS);
    expect(await code).toBe(1);
    await settle();
    expect(ctx.err).toEqual([
      "dipo: waiting for the daemon to finish recovering",
      "dipo: the daemon was still recovering after 10 s; try again shortly, or see `dipo daemon status`.",
    ]);
    expect((ctx.deps.clock as ManualClock).pendingTimers).toBe(0);
  });
});

/** Lets every queued reply and the code awaiting it run. */
async function settle(): Promise<void> {
  await Bun.sleep(0);
}
