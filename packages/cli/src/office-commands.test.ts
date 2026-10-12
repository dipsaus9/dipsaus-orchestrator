// `dipo office open|forget|reload-config` (DIPO-27): the office comes from `--office`, else from the
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
    expect(ctx.sent[0]?.args).toEqual({ office: OFFICE });
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
      { name: "office.reloadConfig", args: { office: OFFICE } },
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
    const ctx = fake(() => ok({ office: OFFICE }), {
      repository: { ...REPO, office: OFFICE, backlog: true },
      interactive: true,
      answers: ["yes"],
    });
    expect(await main(["office", "forget"], ctx.deps)).toBe(0);
    expect(ctx.questions[0]).toContain(`Forget office ${OFFICE}?`);
    expect(ctx.sent).toEqual([{ name: "office.forget", args: { office: OFFICE } }]);
    expect(ctx.out).toEqual([`forgot office ${OFFICE}`]);
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
