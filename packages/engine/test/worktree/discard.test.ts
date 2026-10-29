// `work.discard` (DIPO-161; 0020 section 8), with real git and a bare remote (the reconcile
// harness, its scripted Backlog CLI), a lane that journals into the real journal and records its
// ops, and a code host that records its PR closes: a parked story with uncommitted files, a
// merged PR, a remote tip dipo did not push, the leftovers of a story Done on the base, a running
// story, and a story with nothing to discard.
//
// Two cases stay local: a remote tip the loss list keeps, and the refusal of a merged PR. The rest
// is in discard.ci.test.ts (CI only, DIPO-225).

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";

import {
  type CommandReply,
  type OfficeId,
  RequestId,
  type RunId,
  type Spawn,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";

import { allEntries, type LaneOp, type OfficeLane, planningLane } from "../../src/backlog/lane";
import type { BacklogCli } from "../../src/backlog/runner";
import { insertEntry } from "../../src/backlog/lane/journal";
import { executeCommand } from "../../src/commands/execute";
import { crashAfterHandler } from "../commands/crash";
import type { FeatureModule } from "../../src/commands/registry";
import type { OfficeHandle } from "../../src/db/office";
import type { OfficeGit } from "../../src/git/office";
import { executeRead } from "../../src/reads/execute";
import { insertStoryPr } from "../../src/story-pr/records";
import { StoryDiscard } from "../../src/stories/discard";
import { StoryPlanning } from "../../src/stories/planning";
import { liveClaimOf } from "../../src/worktree/records";
import { lastSeq } from "../stories/helpers";
import {
  claim,
  type FakeTask,
  keyOf,
  noticesAfter,
  type ReconcileOffice,
  setBranch,
  withReconcileOffice,
} from "../reconcile/helpers";
import { backlogStoryStore } from "../../src/backlog/store";

interface Closed {
  readonly repo: string;
  readonly number: number;
  readonly comment: string;
}

/** What a test sees of the discard's dependencies. */
interface Seen {
  office?: OfficeHandle;
  readonly ops: LaneOp[];
  readonly closed: Closed[];
  readonly stops: string[];
  boxes: number;
  /** PIDs the fake probe reports as running. */
  alive: number[];
  /** What the fake stop does to the run. */
  onStop?: () => void;
  /** The Backlog CLI the discard reads `_base` with; none by default. */
  spawn?: Spawn;
}

const HOST_START = 1_767_225_600_000;

function features(seen: Seen) {
  const probe = async (pid: number) =>
    seen.alive.includes(pid)
      ? { pid, startTimeMs: HOST_START, zombie: false, command: "dipo daemon worker-host" }
      : null;
  return ({ engineGit }: { engineGit: { forOffice(o: OfficeId): OfficeGit | undefined } }) => {
    const lane = {
      journal: async (op: LaneOp) => {
        seen.ops.push(op);
        const office = seen.office;
        if (office === undefined) throw new Error("the office is not loaded");
        return office.immediate(() => insertEntry(office, op, 1));
      },
      flush: async () => ({}),
      get office() {
        return seen.office;
      },
      clock: { now: () => 1 },
    } as unknown as OfficeLane;
    const host = {
      closePr: async (repo: string, number: number, comment: string) => {
        seen.closed.push({ repo, number, comment });
      },
    };
    const discarder = new StoryDiscard({
      lane: () => planningLane(lane),
      git: (office) => engineGit.forOffice(office),
      host,
      probe,
      stop: async (_ctx, args) => {
        seen.stops.push(args.story);
        seen.onStop?.();
      },
      finishBoxes: async () => {
        seen.boxes += 1;
      },
      stories: backlogStoryStore({
        spawn: (options) => {
          if (seen.spawn === undefined) throw new Error("no CLI in this test");
          return seen.spawn(options);
        },
      } as BacklogCli),
    });
    const planning = new StoryPlanning({
      lane: () => planningLane(lane),
      git: (office) => engineGit.forOffice(office),
      host,
      implemented: () => true,
      probe,
    });
    return [discarder.feature, planning.feature] as readonly FeatureModule[];
  };
}

function seenOf(): Seen {
  return { ops: [], closed: [], stops: [], boxes: 0, alive: [] };
}

let sequence = 0;
function requestId(): RequestId {
  sequence += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${String(sequence).padStart(8, "1")}`);
}

function discard(
  o: ReconcileOffice,
  story: string,
  note = "wrong approach",
  retry?: { readonly id: RequestId; readonly crash: boolean },
): Promise<CommandReply> {
  // A crash after the handler's commits and before the requests row (DIPO-168 in DIPO-155).
  const deps = retry?.crash === true ? crashAfterHandler(o.s.deps, "work.discard") : o.s.deps;
  return executeCommand(deps, {
    requestId: retry?.id ?? requestId(),
    name: "work.discard",
    args: { story, note },
    origin: "cli",
    confirmed: true,
    office: o.officeId,
  });
}

async function losses(
  o: ReconcileOffice,
  story: string,
  command: "story.drop" | "work.discard" = "work.discard",
) {
  const reply = await executeRead(
    { registry: o.s.registry, offices: o.s.manager, clock: o.s.clock },
    { requestId: requestId(), name: "story.losses", args: { office: o.officeId, story, command } },
  );
  if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
  return reply.result as { commits: { subject: string }[]; files: string[]; kept?: string[] };
}

function errorCode(reply: CommandReply): string {
  if (reply.ok) throw new Error(`expected an error, got ${JSON.stringify(reply)}`);
  return reply.error.code;
}

async function tipOf(o: ReconcileOffice, ref: string): Promise<string | null> {
  const result = await o.repo.run(["git", "rev-parse", "--verify", "--quiet", ref], o.repo.dir);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function remoteTip(o: ReconcileOffice, branch: string): Promise<string> {
  return (await o.repo.git("ls-remote", "origin", `refs/heads/${branch}`)).split("\t")[0] ?? "";
}

function openPr(office: OfficeHandle, key: StoryKey, runId: RunId, head: string, state = "open") {
  office.immediate(() =>
    insertStoryPr(office, {
      runId,
      key,
      number: 7,
      url: "https://github.com/o/r/pull/7",
      branch: "TASK-1/a-story",
      base: "main",
      headSha: head,
      state: state as "open",
      title: "feat(TASK-1): x",
      bodyHash: "h",
      openedAt: 1,
      closedAt: null,
    }),
  );
}

const PARKED: readonly FakeTask[] = [{ id: "TASK-1", status: "Ready" }];

describe("work.discard refusals and the remote branch (DIPO-161)", () => {
  it("refuses a story whose PR merged, changing nothing", async () => {
    const seen = seenOf();
    await withReconcileOffice({ base: PARKED, features: features(seen) }, async (o) => {
      seen.office = o.office;
      const key = keyOf(o.office, "TASK-1");
      const record = await claim(o, o.office, "TASK-1", key, { active: false });
      openPr(o.office, key, record.runId, record.claimSha ?? "", "merged");

      expect(errorCode(await discard(o, "TASK-1"))).toBe("story.prMerged");
      expect(existsSync(record.worktree)).toBe(true);
      expect(liveClaimOf(o.office, key)).not.toBeNull();
      expect(seen.ops).toEqual([]);
      expect(allEntries(o.office)).toEqual([]);
    });
  });
});

describe("work.discard removes nothing its loss list did not show (DIPO-161 review)", () => {
  it("keeps a remote tip dipo pushed but the local branch no longer holds, so its commits stay", async () => {
    const seen = seenOf();
    await withReconcileOffice({ base: PARKED, features: features(seen) }, async (o) => {
      seen.office = o.office;
      const key = keyOf(o.office, "TASK-1");
      const record = await claim(o, o.office, "TASK-1", key, { active: false });
      const pushed = await setBranch(o, record, { id: "TASK-1", status: "Parked" });
      await o.repo.git("push", "--quiet", "origin", record.branch);
      openPr(o.office, key, record.runId, pushed);
      // The local branch is moved back by hand: the PR's head is no longer on it.
      await o.repo.git("update-ref", `refs/heads/${record.branch}`, record.claimSha ?? "");
      expect((await losses(o, "TASK-1")).commits.map((c) => c.subject)).toEqual([
        "TASK-1: status In Progress",
      ]);
      const seq = lastSeq(o.office);

      expect(await discard(o, "TASK-1")).toMatchObject({ ok: true });

      expect(await remoteTip(o, record.branch)).toBe(pushed);
      expect(await tipOf(o, `refs/heads/${record.branch}`)).toBeNull();
      expect(
        noticesAfter(o.office, seq).filter((n) => n.code === "discard.remoteBranchKept"),
      ).toHaveLength(1);
    });
  });
});
