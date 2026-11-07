// `dipo ideas [--state held|passed|rejected] [--office <id>] [--json]` (DIPO-452; 0022): reads
// `office.ideas` and prints a count line, then each idea with its state, id, origin, source story
// and title, and under it a passed idea's proposed user story, a rejected idea's reason and who
// gave it, or what a held idea waits for; `--json` prints the read's result; it never starts the
// daemon.

import { describe, expect, it } from "bun:test";

import { type IdeaView, type OfficeId, officeIdeas } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { ConnectMode, DaemonControl, DaemonSession } from "./daemon-commands";
import { formatIdeas, NO_IDEAS } from "./ideas-command";
import { main, type CliDeps } from "./index";
import { fakeWorkspace } from "../test/support/fake-workspace";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const REPO = {
  mainWorktree: "/work/dipsaus-orchestrator",
  commonDir: "/work/dipsaus-orchestrator/.git",
};

const NO_LIFECYCLE: DaemonControl = {
  inspect: () => Promise.reject(new Error("inspect must not be called")),
  start: () => Promise.reject(new Error("start must not be called")),
  stop: () => Promise.reject(new Error("stop must not be called")),
  restart: () => Promise.reject(new Error("restart must not be called")),
};

type Sent = { name: string; args: unknown };

function fake(ideas: readonly IdeaView[]) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Sent[] = [];
  const modes: ConnectMode[] = [];
  const deps: CliDeps = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    runDaemon: async () => {
      throw new Error("runDaemon must not be called");
    },
    connectDaemon: async (mode) => {
      modes.push(mode);
      const session: DaemonSession = {
        command: (async () => {
          throw new Error("command must not be called");
        }) as DaemonSession["command"],
        read: (async (definition: { name: string }, args: unknown) => {
          sent.push({ name: definition.name, args });
          return { ok: true, result: ideas };
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
    workspace: fakeWorkspace({
      cwd: "/work/dipsaus-orchestrator/src",
      repository: { ...REPO, office: OFFICE, backlog: true },
    }),
  };
  return { deps, out, err, sent, modes };
}

const IDEAS: IdeaView[] = officeIdeas.result.parse([
  {
    id: "3f2a9c1b7d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8",
    origin: "proposal",
    story: "DIPO-140",
    run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
    title: "Cap the PR poll retry",
    text: "Story: As maintainer ...",
    state: "passed",
    decidedBy: "audit",
    proposal: {
      found: "The poll retries a failed read at once, without a limit.",
      evidence: [
        { file: "src/poll.ts", line: 42 },
        { file: "src/poll.ts", line: 57 },
      ],
      sourceStory: "DIPO-140",
      storyLine:
        "As maintainer I want the PR poll to back off after a failed read so that a dead host is not hammered",
      proposed: "Back off the retry and cap it.",
      why: "A dead host gets one request per second.",
      serves: "tech-debt",
    },
    attempts: 0,
    createdAt: "2026-11-06T10:00:00.000Z",
    decidedAt: "2026-11-06T11:00:00.000Z",
  },
  {
    id: "b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    origin: "finding",
    story: "DIPO-141",
    title: "Cap the PR poll retry",
    text: "A reviewer's advisory finding",
    state: "rejected",
    decidedBy: "code",
    reason: "it is the same as idea 3f2a9c1b7d4e, held already",
    attempts: 0,
    createdAt: "2026-11-06T10:05:00.000Z",
    decidedAt: "2026-11-06T11:00:00.000Z",
  },
  {
    id: "c1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    origin: "aside",
    title: "Rename the desk",
    text: "The desk could read better.",
    state: "rejected",
    decidedBy: "audit",
    reason: "No problem in the code: it is a naming taste.",
    attempts: 0,
    createdAt: "2026-11-06T10:06:00.000Z",
  },
  {
    id: "d1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    origin: "quick",
    title: "Show the spend per tier",
    text: "The TUI shows no spend per tier.",
    state: "held",
    attempts: 2,
    lastProblem: "the audit session failed: dipo stopped it: its time cap",
    createdAt: "2026-11-06T10:07:00.000Z",
  },
  {
    id: "e1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    origin: "proposal",
    story: "DIPO-142",
    run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1E",
    title: "Split the poll",
    text: "Story: ...",
    state: "held",
    attempts: 0,
    createdAt: "2026-11-06T10:08:00.000Z",
  },
]);

describe("dipo ideas (DIPO-452)", () => {
  it("lists the held, passed and rejected ideas with their reasons", () => {
    expect(formatIdeas("shop", IDEAS)).toEqual([
      "shop · ideas 5 · held 2 · passed 1 · rejected 2",
      "PASSED   3f2a9c1b7d4e proposal DIPO-140  Cap the PR poll retry",
      "    Found: The poll retries a failed read at once, without a limit.",
      "    Evidence: src/poll.ts:42",
      "    Evidence: src/poll.ts:57",
      "    Source story: DIPO-140",
      "    Story: As maintainer I want the PR poll to back off after a failed read so that a dead host is not hammered",
      "    Proposed: Back off the retry and cap it.",
      "    Why: A dead host gets one request per second.",
      "    Serves: tech debt",
      "    On your desk as a proposed story.",
      "REJECTED b1b2c3d4e5f6 finding DIPO-141  Cap the PR poll retry",
      "    Rejected by code: it is the same as idea 3f2a9c1b7d4e, held already",
      "REJECTED c1b2c3d4e5f6 aside -  Rename the desk",
      "    Rejected by the audit: No problem in the code: it is a naming taste.",
      "HELD     d1b2c3d4e5f6 quick -  Show the spend per tier",
      "    Audited 2 times without a decision; audited again at the next trigger.",
      "    Last problem: the audit session failed: dipo stopped it: its time cap",
      "HELD     e1b2c3d4e5f6 proposal DIPO-142  Split the poll",
      "    Waits for its audit once the run of DIPO-142 is merged or parked.",
    ]);
  });

  it("names a milestone a passed idea serves", () => {
    const [passed] = IDEAS;
    if (passed?.proposal === undefined) throw new Error("no passed idea");
    const lines = formatIdeas("shop", [
      { ...passed, proposal: { ...passed.proposal, serves: "m-3" } },
    ]);
    expect(lines).toContain("    Serves: milestone m-3");
  });

  it("says when no idea is held", () => {
    expect(formatIdeas("shop", [])).toEqual([NO_IDEAS]);
  });

  it("reads office.ideas for the office, with --state, never starting the daemon", async () => {
    const { deps, out, sent, modes } = fake(IDEAS.slice(1, 3));
    expect(await main(["ideas", "--state", "rejected"], deps)).toBe(0);
    expect(sent).toEqual([{ name: "office.ideas", args: { office: OFFICE, state: "rejected" } }]);
    expect(modes).toEqual(["running"]);
    expect(out[0]).toBe("dipsaus-orchestrator · ideas 2 · held 0 · passed 0 · rejected 2");
  });

  it("prints the read's result with --json", async () => {
    const { deps, out } = fake(IDEAS);
    expect(await main(["ideas", "--json"], deps)).toBe(0);
    expect(JSON.parse(out[0] ?? "null")).toEqual(IDEAS);
  });

  it("refuses an unknown state", async () => {
    const { deps, err, sent } = fake(IDEAS);
    expect(await main(["ideas", "--state", "open"], deps)).toBe(2);
    expect(err.join("\n")).toContain("--state needs one of held, passed, rejected");
    expect(sent).toEqual([]);
  });
});
