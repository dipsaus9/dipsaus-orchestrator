// `dipo update` (DIPO-485): sends `daemon.update` for the office, asks first, prints the result.

import { describe, expect, it } from "bun:test";

import { type OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl, DaemonSession } from "./daemon-commands";
import { fakeWorkspace } from "../test/support/fake-workspace";
import { type CliDeps, main } from "./index";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const NO_LIFECYCLE = {} as DaemonControl;

function fake(reply: unknown, options: { interactive?: boolean; answers?: string[] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: { name: string; args: unknown }[] = [];
  const ws = fakeWorkspace({
    cwd: "/work/app",
    repository: {
      mainWorktree: "/work/app",
      commonDir: "/work/app/.git",
      office: OFFICE,
      backlog: true,
    },
    ...options,
  });
  const deps: CliDeps = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    runDaemon: async () => 0,
    connectDaemon: async () =>
      ({
        command: (async (definition: { name: string }, args: unknown) => {
          sent.push({ name: definition.name, args });
          return reply;
        }) as DaemonSession["command"],
        read: (async () => ({ ok: true, result: {} })) as DaemonSession["read"],
        close: () => undefined,
      }) as unknown as DaemonSession,
    daemon: NO_LIFECYCLE,
    clock: new ManualClock(),
    clientChecks: [],
    stamp: undefined,
    runtime: { bun: "1.4.2", os: "linux", arch: "arm64" },
    workspace: ws,
  };
  return { deps, out, err, sent };
}

const UPDATED = { ok: true, changed: true, result: { commit: "1a2b3c4d5e6f", commits: 3 } };

describe("dipo update (DIPO-485)", () => {
  it("sends daemon.update for the office of the directory and prints the commit built", async () => {
    const t = fake(UPDATED);
    expect(await main(["update", "--yes"], t.deps)).toBe(0);
    expect(t.sent).toEqual([{ name: "daemon.update", args: { office: OFFICE } }]);
    expect(t.out).toEqual([
      "dipo built 1a2b3c4d5e6f (3 engine commits) and is restarting on it; `dipo daemon status` names the new commit",
    ]);
  });

  it("asks first at a terminal and sends nothing on a no", async () => {
    const t = fake(UPDATED, { interactive: true, answers: ["n"] });
    expect(await main(["update"], t.deps)).toBe(1);
    expect(t.sent).toEqual([]);
    expect(t.out).toEqual(["nothing updated"]);
    const yes = fake(UPDATED, { interactive: true, answers: ["y"] });
    expect(await main(["update"], yes.deps)).toBe(0);
    expect(yes.sent).toHaveLength(1);
  });

  it("refuses without a terminal and without --yes", async () => {
    const t = fake(UPDATED);
    expect(await main(["update"], t.deps)).toBe(1);
    expect(t.sent).toEqual([]);
    expect(t.err[0]).toContain("needs confirmation");
  });

  it("prints the engine's refusal and exits 1", async () => {
    const t = fake({
      ok: false,
      error: {
        code: "update.refused",
        message: "dipo does not update: not while anything runs: 1 story run.",
        retryable: false,
      },
    });
    expect(await main(["update", "--yes"], t.deps)).toBe(1);
    expect(t.err).toEqual([
      "dipo: update.refused: dipo does not update: not while anything runs: 1 story run.",
    ]);
  });
});
