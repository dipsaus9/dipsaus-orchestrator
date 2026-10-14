// `dipo office open|forget|reload-config|init` (DIPO-27, DIPO-36): the office comes from `--office`, else from the
// repository around the current directory; an unregistered Backlog.md project prints "not an
// office, run `dipo office open`" and a terminal is asked once to open it.

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl, DaemonSession } from "./daemon-commands";
import { type FakeWorkspaceOptions, fakeWorkspace } from "./fake-workspace";
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
      cursor: { stream: `office:${OFFICE}`, epoch: "e", seq: 1 },
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
      connectDaemon: async () => {
        const session = await inner();
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
            queueMicrotask(() => options.onCaughtUp?.({ stream, epoch: "e", seq: 0 } as never));
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

describe("dipo office purge", () => {
  const purged = ok({
    office: OFFICE,
    path: "/work/app",
    rows: 42,
    directory: "/work/app/.git/dipo",
  });

  it("asks at a terminal, says it cannot be undone, then purges the office of the repository", async () => {
    const ctx = fake(() => purged, {
      repository: { ...REPO, office: OFFICE, backlog: true },
      interactive: true,
      answers: ["yes"],
    });
    expect(await main(["office", "purge"], ctx.deps)).toBe(0);
    expect(ctx.questions[0]).toMatch(/^Purge the office at \/work\/app\? /);
    expect(ctx.questions[0]).toContain("This cannot be undone.");
    expect(ctx.sent).toEqual([
      { name: "office.purge", args: { office: OFFICE, from: "/work/app" } },
    ]);
    expect(ctx.out).toEqual([
      `purged office ${OFFICE} at /work/app: 42 rows deleted`,
      "removed /work/app/.git/dipo",
    ]);
  });

  it("sends nothing when the answer is no, or in a script without --yes", async () => {
    const declined = fake(() => purged, { interactive: true, answers: ["n"] });
    expect(await main(["office", "purge", "--office", OFFICE], declined.deps)).toBe(1);
    expect(declined.questions[0]).toMatch(new RegExp(`^Purge office ${OFFICE}\\? `));
    expect(declined.out).toEqual(["nothing purged"]);
    expect(declined.connections()).toBe(0);

    const script = fake(() => purged);
    expect(await main(["office", "purge", "--office", OFFICE], script.deps)).toBe(1);
    expect(script.err).toEqual([
      `dipo: purging office ${OFFICE} cannot be undone, so it needs confirmation; run it at a terminal or pass --yes.`,
    ]);
    expect(script.connections()).toBe(0);
  });

  it("purges a named office with --yes and says when there was no directory", async () => {
    const ctx = fake(() => ok({ office: OTHER, path: "/gone", rows: 3 }));
    expect(await main(["office", "purge", "--office", OTHER, "--yes"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "office.purge", args: { office: OTHER } }]);
    expect(ctx.out).toEqual([
      `purged office ${OTHER} at /gone: 3 rows deleted`,
      "no .git/dipo directory of this office to remove (the path is missing or holds another office)",
    ]);
  });

  it("sends the repository as from, also with --office, and reports a path mismatch", async () => {
    const mismatch = {
      ok: false,
      error: {
        code: "office.unknown",
        message: `/work/app is not office ${OFFICE}, which is registered at /work/original.`,
        retryable: false,
        details: { office: OFFICE, from: "/work/app", reason: "path" },
      },
    };
    // A copy: the marker names an office registered elsewhere.
    const copy = fake(() => mismatch, { repository: { ...REPO, office: OFFICE, backlog: true } });
    expect(await main(["office", "purge", "--yes"], copy.deps)).toBe(1);
    expect(copy.sent).toEqual([
      { name: "office.purge", args: { office: OFFICE, from: "/work/app" } },
    ]);
    expect(copy.err[0]).toBe(
      `dipo: office.unknown: /work/app is not office ${OFFICE}, which is registered at /work/original.`,
    );
    expect(copy.err[1]).toContain("nothing purged");
    expect(copy.questions).toEqual([]);

    // --office inside a repository still sends that repository as from.
    const named = fake(() => mismatch, { repository: { ...REPO, office: OTHER, backlog: true } });
    expect(await main(["office", "purge", "--office", OFFICE, "--yes"], named.deps)).toBe(1);
    expect(named.sent).toEqual([
      { name: "office.purge", args: { office: OFFICE, from: "/work/app" } },
    ]);
  });

  it("sends no from outside any repository", async () => {
    const ctx = fake(() => ok({ office: OFFICE, path: "/work/app", rows: 2 }));
    expect(await main(["office", "purge", "--office", OFFICE, "--yes"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "office.purge", args: { office: OFFICE } }]);
  });

  it("reports office.busy", async () => {
    const ctx = fake(() => ({
      ok: false,
      error: { code: "office.busy", message: "has active work", retryable: false },
    }));
    expect(await main(["office", "purge", "--office", OFFICE, "--yes"], ctx.deps)).toBe(1);
    expect(ctx.err).toEqual(["dipo: office.busy: has active work"]);
  });
});
