// `dipo office profile`, `dipo office confirm` and `dipo office infer` (DIPO-310 criteria 5 to 7):
// the profile prints each capability with source, confidence, confirmed, pending and stale, and
// each deviation with its fix; confirm parses its actions into `office.confirm` and prints the
// diff and the run refusal; infer sends `office.infer` and prints what it asks for and proposes.

import { describe, expect, it } from "bun:test";

import {
  type OfficeId,
  officeConfirm,
  officeInfer,
  type ProfileView,
  ProfileView as ProfileViewSchema,
} from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl, DaemonSession } from "./daemon-commands";
import { fakeWorkspace } from "./fake-workspace";
import { main, type CliDeps } from "./index";
import { formatProfile, parseConfirm, splitCommands } from "./profile-commands";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const REPO = { mainWorktree: "/work/app", commonDir: "/work/app/.git" };

const NO_LIFECYCLE: DaemonControl = {
  inspect: () => Promise.reject(new Error("inspect must not be called")),
  start: () => Promise.reject(new Error("start must not be called")),
  stop: () => Promise.reject(new Error("stop must not be called")),
  restart: () => Promise.reject(new Error("restart must not be called")),
};

const VIEW: ProfileView = ProfileViewSchema.parse({
  office: OFFICE,
  scanned: true,
  scannedAt: "2026-10-23T10:00:00.000Z",
  commit: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  fingerprint: "sha256:1",
  level: "partial",
  nothingToStart: false,
  inferring: false,
  runRefusal:
    'Verify is unresolved: add a "verify" script. Or have a model propose it with `dipo office infer`.',
  testRefusal: undefined,
  capabilities: [
    {
      name: "install",
      status: "resolved",
      command: "bun install --frozen-lockfile",
      commands: [["bun", "install", "--frozen-lockfile"]],
      cwd: ".",
      source: "standard",
      confidence: "high",
      evidence: "frozen install of the package manager",
      confirmed: false,
      stale: false,
      cli: [],
    },
    {
      name: "dev",
      status: "resolved",
      command: "make dev",
      commands: [["make", "dev"]],
      cwd: ".",
      source: "maintainer",
      confidence: "high",
      evidence: "confirmed (set by the maintainer): set by the maintainer",
      confirmed: true,
      stale: true,
      fix: 'add a "dev" script, so code resolves it and the confirmation can go',
      cli: ["dipo office confirm keep dev", "dipo office confirm set dev -- <command>"],
    },
    {
      name: "verify",
      status: "unresolved",
      confirmed: false,
      stale: false,
      pending: {
        command: "make check",
        commands: [["make", "check"]],
        cwd: ".",
        confidence: "low",
        modelConfidence: "medium",
        evidence: ["Makefile: target check runs the tests"],
        stale: false,
        proposedAt: "2026-10-23T10:05:00.000Z",
      },
      cli: ["dipo office confirm accept verify", "dipo office confirm reject verify"],
    },
  ],
  deviations: [
    {
      code: "missing-test",
      message: 'No "test" script. Add one: it is required.',
      conflict: false,
      fix: 'add a "test" script',
    },
  ],
});

type Sent = { name: string; args: unknown };

function fake(reply: (sent: Sent) => unknown) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Sent[] = [];
  const ws = fakeWorkspace({
    cwd: "/work/app",
    repository: { ...REPO, office: OFFICE, backlog: true },
  });
  const deps: CliDeps = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    runDaemon: async () => {
      throw new Error("runDaemon must not be called");
    },
    connectDaemon: async () => {
      const session: DaemonSession = {
        command: (async (definition: { name: string }, args: unknown) => {
          const message = { name: definition.name, args };
          sent.push(message);
          return reply(message);
        }) as DaemonSession["command"],
        read: (async (definition: { name: string }, args: unknown) => {
          const message = { name: definition.name, args };
          sent.push(message);
          return reply(message);
        }) as DaemonSession["read"],
        subscribe: ((_stream: unknown, handlers: { onCaughtUp?: () => void }) => {
          queueMicrotask(() => handlers.onCaughtUp?.());
          return { unsubscribe: () => undefined };
        }) as unknown as DaemonSession["subscribe"],
        close: () => undefined,
      };
      return session;
    },
    daemon: NO_LIFECYCLE,
    clock: new ManualClock(Date.parse("2026-10-23T12:00:00.000Z")),
    clientChecks: [],
    stamp: undefined,
    runtime: { bun: "1.4.2", os: "linux", arch: "arm64" },
    workspace: ws,
  };
  return { deps, out, err, sent };
}

describe("dipo office profile", () => {
  it("prints each capability with source, confidence, confirmed, pending and stale", () => {
    const lines = formatProfile("office app", VIEW);
    expect(lines.slice(0, 4)).toEqual([
      "office app · conformance partial · scanned 2026-10-23T10:00:00.000Z at 4b825dc642cb",
      `run: refused: ${VIEW.runRefusal}`,
      "test: can run",
      "capabilities:",
    ]);
    expect(lines).toContain(
      "  install  bun install --frozen-lockfile · standard, high · frozen install of the package manager",
    );
    expect(lines).toContain(
      "  dev      make dev · maintainer, high · confirmed (set by the maintainer): set by the maintainer [confirmed, stale]",
    );
    expect(lines).toContain("  verify   unresolved [pending]");
    expect(lines).toContain(
      "           proposed: make check · confidence low (the model said medium)",
    );
    expect(lines).toContain("             evidence: Makefile: target check runs the tests");
    expect(lines).toContain(
      "           dipo office confirm accept verify | dipo office confirm reject verify",
    );
    expect(lines.slice(-2)).toEqual([
      "deviations:",
      '  - No "test" script. Add one: it is required. · fix: add a "test" script',
    ]);
  });

  it("reads office.profile for the office and prints it, or its JSON with --json", async () => {
    const f = fake(() => ({ ok: true, result: VIEW }));
    expect(await main(["office", "profile"], f.deps)).toBe(0);
    expect(f.sent).toEqual([{ name: "office.profile", args: { office: OFFICE } }]);
    expect(f.out[0]).toContain("conformance partial");
    const j = fake(() => ({ ok: true, result: VIEW }));
    expect(await main(["office", "profile", "--json"], j.deps)).toBe(0);
    expect(JSON.parse(j.out[0] ?? "null")).toEqual(VIEW);
  });

  it("says when there is no profile yet", () => {
    expect(
      formatProfile("office app", {
        office: OFFICE,
        scanned: false,
        nothingToStart: false,
        inferring: false,
        capabilities: [],
        deviations: [],
      }),
    ).toEqual(["office app · no run profile yet: run `dipo office rescan`"]);
  });
});

describe("dipo office confirm", () => {
  it("parses every action into office.confirm arguments", () => {
    expect(parseConfirm(["accept", "verify"])).toEqual({
      office: null,
      args: { action: "accept", capability: "verify" },
    });
    expect(parseConfirm(["reject", "dev", "--office", OFFICE])).toEqual({
      office: OFFICE,
      args: { action: "reject", capability: "dev" },
    });
    expect(parseConfirm(["keep", "verify"])).toMatchObject({ args: { action: "keep" } });
    expect(parseConfirm(["pick", "verify", "2"])).toMatchObject({
      args: { action: "pick", capability: "verify", candidate: 2 },
    });
    expect(
      parseConfirm(["set", "verify", "--cwd", "apps/web", "--", "bun run lint && bun test"]),
    ).toEqual({
      office: null,
      args: {
        action: "set",
        capability: "verify",
        commands: [
          ["bun", "run", "lint"],
          ["bun", "test"],
        ],
        cwd: "apps/web",
      },
    });
    expect(parseConfirm(["edit", "dev", "--", "make", "dev", "&&", "make", "watch"])).toMatchObject(
      {
        args: {
          action: "edit",
          commands: [
            ["make", "dev"],
            ["make", "watch"],
          ],
        },
      },
    );
    expect(parseConfirm(["nothing-to-start"])).toEqual({
      office: null,
      args: { action: "nothing-to-start", value: true },
    });
    expect(parseConfirm(["nothing-to-start", "--undo"])).toMatchObject({
      args: { value: false },
    });
  });

  it("refuses what it cannot send", () => {
    expect(parseConfirm([])).toContain("name an action");
    expect(parseConfirm(["accept", "deploy"])).toContain("name a capability");
    expect(parseConfirm(["set", "verify"])).toBe("set needs a command after --");
    expect(parseConfirm(["accept", "verify", "--", "x"])).toBe("accept takes only the capability");
    expect(parseConfirm(["pick", "verify", "zero"])).toContain("candidate's number");
    expect(parseConfirm(["accept", "verify", "--undo"])).toContain("--undo");
    expect(parseConfirm(["launch", "verify"])).toContain("unknown action");
    expect(splitCommands(['bun "run']).toString()).toContain("unclosed quote");
    expect(splitCommands(["&&", "x"])).toContain("give a command");
  });

  it("sends office.confirm and prints the diff and the run refusal", async () => {
    const f = fake(() => ({
      ok: true,
      result: {
        capability: "verify",
        source: "inferred",
        confirmed: true,
        diff: ["~ verify: unresolved -> make check [inferred]"],
      },
    }));
    expect(await main(["office", "confirm", "accept", "verify"], f.deps)).toBe(0);
    expect(f.sent).toEqual([
      { name: officeConfirm.name, args: { action: "accept", capability: "verify" } },
    ]);
    expect(f.out).toEqual([
      `office ${OFFICE}: verify: confirmed (inferred)`,
      "changes:",
      "  ~ verify: unresolved -> make check [inferred]",
      "dipo run can start stories",
    ]);
  });

  it("prints the engine's error and exits 1", async () => {
    const f = fake(() => ({
      ok: false,
      error: {
        code: "scan.noProposal",
        message: "verify has no pending proposal.",
        retryable: false,
      },
    }));
    expect(await main(["office", "confirm", "accept", "verify"], f.deps)).toBe(1);
    expect(f.err).toEqual(["dipo: scan.noProposal: verify has no pending proposal."]);
  });
});

describe("dipo office infer", () => {
  it("says when nothing is left to infer, and asks no model", async () => {
    const f = fake(() => ({ ok: true, result: { infer: "nothing", capabilities: [] } }));
    expect(await main(["office", "infer"], f.deps)).toBe(0);
    expect(f.sent).toEqual([{ name: officeInfer.name, args: {} }]);
    expect(f.out).toEqual([
      `office ${OFFICE}: nothing to infer: code and your confirmations resolve every capability`,
    ]);
  });
});
