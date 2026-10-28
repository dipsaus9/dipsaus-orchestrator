// CI only (0017 section 1, DIPO-225): real git repositories and processes, too slow for the local
// run.
// `work.discard` (DIPO-161; 0020 section 8), with real git and a bare remote (the reconcile
// harness, its scripted Backlog CLI), a lane that journals into the real journal and records its
// ops, and a code host that records its PR closes: a parked story with uncommitted files, a
// merged PR, a remote tip dipo did not push, the leftovers of a story Done on the base, a running
// story, and a story with nothing to discard.

import { describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CommandReply,
  type OfficeId,
  RequestId,
  type RunId,
  type Spawn,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";

import { type LaneOp, type OfficeLane } from "../../src/backlog/lane";
import type { BacklogCli } from "../../src/backlog/runner";
import { insertEntry } from "../../src/backlog/lane/journal";
import { executeCommand } from "../../src/commands/execute";
import { CRASH, crashAfterHandler } from "../commands/crash";
import type { FeatureModule } from "../../src/commands/registry";
import type { OfficeHandle } from "../../src/db/office";
import type { OfficeGit } from "../../src/git/office";
import { insertWorkerQuestion } from "../../src/hooks/questions";
import { executeRead } from "../../src/reads/execute";
import { reconcileOffice } from "../../src/reconcile";
import { insertStoryPr, latestStoryPr } from "../../src/story-pr/records";
import { discardOp, StoryDiscard } from "../../src/stories/discard";
import { StoryPlanning } from "../../src/stories/planning";
import { doneElsewhereDeskItems, findDoneElsewhere } from "../../src/worktree/done-elsewhere";
import {
  findClaim,
  liveClaimOf,
  openReleasedBranches,
  releaseClaim,
} from "../../src/worktree/records";
import { releaseForDiscard } from "../../src/worktree/release";
import { SlotTable } from "../../src/worktree/slots";
import { lastSeq } from "../stories/helpers";
import {
  claim,
  fakeBacklog,
  type FakeTask,
  keyOf,
  noticesAfter,
  type ReconcileOffice,
  withReconcileOffice,
} from "../reconcile/helpers";

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
    } as unknown as OfficeLane;
    const host = {
      closePr: async (repo: string, number: number, comment: string) => {
        seen.closed.push({ repo, number, comment });
      },
    };
    const discarder = new StoryDiscard({
      lane: () => lane,
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
      cli: {
        spawn: (options) => {
          if (seen.spawn === undefined) throw new Error("no CLI in this test");
          return seen.spawn(options);
        },
      } as BacklogCli,
    });
    const planning = new StoryPlanning({
      lane: () => lane,
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

function parkRow(office: OfficeHandle, key: StoryKey, runId: RunId): void {
  office.run(
    `insert into parks (office_id, park_id, key, story_id, run_id, reason, detail, last_good_commit, at)
     values ($office_id, 1, $key, 'TASK-1', $run, 'by-maintainer', 'stopped', null, 1)`,
    { key, run: runId },
  );
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

function entriesOf(office: OfficeHandle, type: string, afterSeq: number) {
  return office
    .all<{ delta: string }>(
      "select delta from change_log where office_id = $office_id and seq > $seq and type = $type order by seq",
      { seq: afterSeq, type },
    )
    .map((row) => JSON.parse(row.delta) as Record<string, unknown>);
}

const PARKED: readonly FakeTask[] = [{ id: "TASK-1", status: "Ready" }];

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("work.discard of a parked story (DIPO-161)", () => {
    it("removes the worktree with its uncommitted files and the branch, closes the PR and writes Refined", async () => {
      const seen = seenOf();
      await withReconcileOffice({ base: PARKED, features: features(seen) }, async (o) => {
        seen.office = o.office;
        const key = keyOf(o.office, "TASK-1");
        const record = await claim(o, o.office, "TASK-1", key, { active: false });
        await o.repo.git("push", "--quiet", "origin", record.branch);
        parkRow(o.office, key, record.runId);
        openPr(o.office, key, record.runId, record.claimSha ?? "");
        o.office.immediate(() =>
          insertWorkerQuestion(o.office, {
            questionId: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
            runId: record.runId,
            agentId: "agt_1",
            text: "Which flag?",
            at: 1,
          }),
        );
        writeFileSync(join(record.worktree, "README.md"), "uncommitted\n");
        writeFileSync(join(record.worktree, "scratch.txt"), "untracked\n");
        const slots = new SlotTable(join(o.repo.root, "slots.json"));
        expect(await losses(o, "TASK-1")).toMatchObject({
          commits: [{ subject: "TASK-1: status In Progress" }],
          files: ["README.md", "scratch.txt"],
        });
        const seq = lastSeq(o.office);

        const reply = await discard(o, "TASK-1");

        expect(reply).toMatchObject({ ok: true, result: { story: "TASK-1", key } });
        expect(existsSync(record.worktree)).toBe(false);
        expect(await tipOf(o, `refs/heads/${record.branch}`)).toBeNull();
        expect(await remoteTip(o, record.branch)).toBe("");
        expect(findClaim(o.office, record.runId)?.releaseReason).toBe("discard");
        expect(liveClaimOf(o.office, key)).toBeNull();
        expect(openReleasedBranches(o.office, key)).toEqual([]);
        expect(slots.slotOf(record.worktree)).toBeNull();
        const park = o.office.get<{ how: string }>(
          "select resolved_how as how from parks where office_id = $office_id and park_id = 1",
        );
        expect(park?.how).toBe("discard");
        const question = o.office.get<{ how: string }>(
          "select closed_how as how from questions where office_id = $office_id",
        );
        expect(question?.how).toBe("ended");
        expect(seen.closed).toEqual([
          { repo: "o/r", number: 7, comment: expect.stringContaining("discarded (work.discard)") },
        ]);
        expect(latestStoryPr(o.office, key)?.state).toBe("closed");
        // Lane b writes Refined, never over a Done story; the pending-op skip covers it at once.
        expect(seen.ops).toEqual([
          {
            kind: "discard",
            key,
            subject: "TASK-1",
            target: {
              from: ["In Progress", "In Review", "Parked", "Ready", "Refined", "To Do"],
              status: "Refined",
              unset: ["park"],
            },
            releasesClaim: true,
          },
        ]);
        expect(entriesOf(o.office, "story.state", seq).at(-1)).toMatchObject({ to: "Refined" });
        expect(entriesOf(o.office, "question.closed", seq)).toHaveLength(1);
        // The ended run's box goes too (0021 section 6).
        expect(seen.boxes).toBe(1);

        // A re-run finds the target state and changes nothing.
        const again = await discard(o, "TASK-1");
        expect(again).toMatchObject({ ok: true, changed: false });
        expect(seen.ops).toHaveLength(1);
      });
    });

    it("repeats no effect when a crash before the requests row makes the retry run the handler again (DIPO-168)", async () => {
      const seen = seenOf();
      await withReconcileOffice({ base: PARKED, features: features(seen) }, async (o) => {
        seen.office = o.office;
        const key = keyOf(o.office, "TASK-1");
        const record = await claim(o, o.office, "TASK-1", key, { active: false });
        await o.repo.git("push", "--quiet", "origin", record.branch);
        parkRow(o.office, key, record.runId);
        openPr(o.office, key, record.runId, record.claimSha ?? "");
        const seq = lastSeq(o.office);
        const id = requestId();

        const crashed = await discard(o, "TASK-1", "wrong approach", { id, crash: true });
        expect(crashed.ok ? null : crashed.error.message).toContain(CRASH);
        expect(existsSync(record.worktree)).toBe(false);
        expect([seen.ops.length, seen.closed.length, seen.boxes]).toEqual([1, 1, 1]);

        // The retry sees what the first run did: no second op, PR close, box removal or state.
        const retried = await discard(o, "TASK-1", "wrong approach", { id, crash: false });
        expect(retried).toMatchObject({ ok: true, result: { story: "TASK-1", key } });
        expect([seen.ops.length, seen.closed.length, seen.boxes]).toEqual([1, 1, 1]);
        expect(await tipOf(o, `refs/heads/${record.branch}`)).toBeNull();
        expect(entriesOf(o.office, "story.state", seq).map((d) => d["to"])).toEqual(["Refined"]);
      });
    });

    it("is registered on the waiting command path", async () => {
      const seen = seenOf();
      await withReconcileOffice({ features: features(seen) }, async (o) => {
        const command = o.s.registry.command("work.discard");
        expect(command).toMatchObject({ level: "office", waits: true });
      });
    });
  });

  describe("work.discard refusals and the remote branch (DIPO-161)", () => {
    it("keeps a remote branch whose tip dipo did not push, with a notice, and goes on: a PR head changed outside dipo", async () => {
      const seen = seenOf();
      await withReconcileOffice({ base: PARKED, features: features(seen) }, async (o) => {
        seen.office = o.office;
        const key = keyOf(o.office, "TASK-1");
        const record = await claim(o, o.office, "TASK-1", key, { active: false });
        await o.repo.git("push", "--quiet", "origin", record.branch);
        openPr(o.office, key, record.runId, record.claimSha ?? "");
        // Someone pushes a commit to the PR's branch on the host.
        const tree = (await o.repo.git("rev-parse", `${record.branch}^{tree}`)).trim();
        const theirs = (
          await o.repo.git("commit-tree", tree, "-p", record.claimSha ?? "", "-m", "theirs")
        ).trim();
        await o.repo.git("push", "--quiet", "origin", `${theirs}:refs/heads/${record.branch}`);
        const seq = lastSeq(o.office);

        const reply = await discard(o, "TASK-1");

        expect(reply).toMatchObject({ ok: true });
        expect(await remoteTip(o, record.branch)).toBe(theirs);
        expect(await tipOf(o, `refs/heads/${record.branch}`)).toBeNull();
        expect(existsSync(record.worktree)).toBe(false);
        expect(findClaim(o.office, record.runId)?.releaseReason).toBe("discard");
        expect(seen.closed.map((c) => c.number)).toEqual([7]);
        const kept = noticesAfter(o.office, seq).filter(
          (n) => n.code === "discard.remoteBranchKept",
        );
        expect(kept).toHaveLength(1);
        expect(kept[0]?.text).toContain(theirs);
      });
    });

    it("refuses a story with neither a claim nor leftovers", async () => {
      const seen = seenOf();
      await withReconcileOffice({ base: PARKED, features: features(seen) }, async (o) => {
        seen.office = o.office;
        expect(errorCode(await discard(o, "TASK-1"))).toBe("story.notDiscardable");
        expect(seen.ops).toEqual([]);
      });
    });

    it("stops a running story first, and answers run.hostAlive while its host still runs", async () => {
      const seen = seenOf();
      await withReconcileOffice({ base: PARKED, features: features(seen) }, async (o) => {
        seen.office = o.office;
        const key = keyOf(o.office, "TASK-1");
        const record = await claim(o, o.office, "TASK-1", key);
        o.office.run(
          `insert into worker_hosts (office_id, run_id, agent_id, pid, start_time_ms, socket_path,
           protocol_version, run_dir, event_file, started_at)
         values ($office_id, $run, 'agent-1', 4242, $start, '/s', 1, '/d', '/e', 0)`,
          { run: record.runId, start: HOST_START },
        );
        seen.alive = [4242];
        seen.onStop = () =>
          o.office.run(
            "update runs set ended_at = 2, end_kind = 'stopped' where office_id = $office_id and run_id = $run",
            { run: record.runId },
          );

        const busy = await discard(o, "TASK-1");
        expect(errorCode(busy)).toBe("run.hostAlive");
        expect(busy.ok === false && busy.error.retryable).toBe(true);
        // The maintainer park gets the story as the command resolved it.
        expect(seen.stops).toEqual([key]);
        expect(existsSync(record.worktree)).toBe(true);
        expect(seen.ops).toEqual([]);

        seen.alive = [];
        expect(await discard(o, "TASK-1")).toMatchObject({ ok: true });
        expect(existsSync(record.worktree)).toBe(false);
        expect(findClaim(o.office, record.runId)?.releaseReason).toBe("discard");
      });
    });
  });

  describe("work.discard of the leftovers of a story Done on the base (DIPO-161)", () => {
    it("removes the kept worktree and branch, clears the desk item and writes nothing to the backlog", async () => {
      const seen = seenOf();
      await withReconcileOffice(
        { base: [{ id: "TASK-1", status: "Done" }], features: features(seen) },
        async (o) => {
          seen.office = o.office;
          const key = keyOf(o.office, "TASK-1");
          const record = await claim(o, o.office, "TASK-1", key, { active: false });
          await o.repo.git("push", "--quiet", "origin", record.branch);
          writeFileSync(join(record.worktree, "scratch.txt"), "work in progress\n");
          const git = o.engineGit.forOffice(o.officeId) as OfficeGit;
          const pass = await o.index.indexStories(o.officeId);
          await reconcileOffice(
            { officeId: o.officeId, office: o.office, git, clock: o.s.clock },
            { trigger: "rescan", pass, reindex: () => o.index.indexStories(o.officeId) },
          );
          expect(findDoneElsewhere(o.office, record.runId)).toMatchObject({
            worktreeKept: true,
            branchKept: true,
          });
          expect(await losses(o, "TASK-1")).toMatchObject({
            commits: [{ subject: "TASK-1: status In Progress" }],
            files: ["scratch.txt"],
          });
          const seq = lastSeq(o.office);

          const reply = await discard(o, "TASK-1", "leftovers of a hand finish");

          expect(reply).toMatchObject({ ok: true, changed: true });
          expect(existsSync(record.worktree)).toBe(false);
          expect(await tipOf(o, `refs/heads/${record.branch}`)).toBeNull();
          expect(await remoteTip(o, record.branch)).toBe("");
          expect(openReleasedBranches(o.office, key)).toEqual([]);
          expect(doneElsewhereDeskItems(o.office)).toEqual([]);
          expect(findDoneElsewhere(o.office, record.runId)?.clearedAt).not.toBeNull();
          // No backlog write and no new state: the base already says Done.
          expect(seen.ops).toEqual([]);
          expect(entriesOf(o.office, "story.state", seq)).toEqual([]);

          expect(await discard(o, "TASK-1")).toMatchObject({ ok: true, changed: false });
        },
      );
    });
  });

  describe("work.discard removes nothing its loss list did not show (DIPO-161 review)", () => {
    it("lists and removes the branch of leftovers a crash left unsettled; drop lists the worktree as kept", async () => {
      const seen = seenOf();
      await withReconcileOffice(
        { base: [{ id: "TASK-1", status: "Done" }], features: features(seen) },
        async (o) => {
          seen.office = o.office;
          const key = keyOf(o.office, "TASK-1");
          const record = await claim(o, o.office, "TASK-1", key, { active: false });
          // Released as done-elsewhere, then a crash before its PR, worktree and branch were settled:
          // no `released_branches` row for its branch.
          o.office.immediate(() => {
            releaseClaim(o.office, record.runId, {
              at: 5,
              reason: "done-elsewhere",
              keepBranch: false,
            });
            o.office.run(
              `insert into done_elsewhere (office_id, run_id, key, story_id, branch, worktree,
               start_sha, base, released_at)
             values ($office_id, $run, $key, 'TASK-1', $branch, $worktree, $start, 'main', 5)`,
              {
                run: record.runId,
                key,
                branch: record.branch,
                worktree: record.worktree,
                start: record.startSha,
              },
            );
          });
          expect(openReleasedBranches(o.office, key)).toEqual([]);

          expect(await losses(o, "TASK-1")).toMatchObject({
            commits: [{ subject: "TASK-1: status In Progress" }],
            files: [],
          });
          // `story.drop` never removes the leftovers' worktree: listed as kept, its branch not lost.
          const drop = await losses(o, "TASK-1", "story.drop");
          expect(drop.commits).toEqual([]);
          expect(drop.kept).toEqual([record.worktree]);

          expect(await discard(o, "TASK-1")).toMatchObject({ ok: true, changed: true });
          expect(await tipOf(o, `refs/heads/${record.branch}`)).toBeNull();
          expect(existsSync(record.worktree)).toBe(false);
        },
      );
    });

    it("reads the files of a kept worktree after retention removed its claim row", async () => {
      const seen = seenOf();
      await withReconcileOffice(
        { base: [{ id: "TASK-1", status: "Done" }], features: features(seen) },
        async (o) => {
          seen.office = o.office;
          const key = keyOf(o.office, "TASK-1");
          const record = await claim(o, o.office, "TASK-1", key, { active: false });
          writeFileSync(join(record.worktree, "scratch.txt"), "work in progress\n");
          const git = o.engineGit.forOffice(o.officeId) as OfficeGit;
          const pass = await o.index.indexStories(o.officeId);
          await reconcileOffice(
            { officeId: o.officeId, office: o.office, git, clock: o.s.clock },
            { trigger: "rescan", pass, reindex: () => o.index.indexStories(o.officeId) },
          );
          o.office.run("delete from claims where office_id = $office_id and run_id = $run", {
            run: record.runId,
          });
          expect(findClaim(o.office, record.runId)).toBeNull();

          expect((await losses(o, "TASK-1")).files).toEqual(["scratch.txt"]);
          expect(await discard(o, "TASK-1")).toMatchObject({ ok: true });
          expect(existsSync(record.worktree)).toBe(false);
        },
      );
    });
  });

  describe("work.discard after a crash and on a story Done on the base (DIPO-161 review)", () => {
    it("writes the facts a crash between the release and the commit left owed, then answers unchanged", async () => {
      const seen = seenOf();
      await withReconcileOffice({ base: PARKED, features: features(seen) }, async (o) => {
        seen.office = o.office;
        const key = keyOf(o.office, "TASK-1");
        const record = await claim(o, o.office, "TASK-1", key, { active: false });
        parkRow(o.office, key, record.runId);
        o.office.immediate(() =>
          insertWorkerQuestion(o.office, {
            questionId: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
            runId: record.runId,
            agentId: "agt_1",
            text: "Which flag?",
            at: 1,
          }),
        );
        // The first discard journaled its op and released the claim, then crashed.
        o.office.immediate(() => insertEntry(o.office, discardOp(key, "TASK-1"), 1));
        const git = o.engineGit.forOffice(o.officeId) as OfficeGit;
        const released = await releaseForDiscard(
          { officeId: o.officeId, office: o.office, git, clock: o.s.clock },
          record,
        );
        expect(released.ok).toBe(true);
        const seq = lastSeq(o.office);

        expect(await discard(o, "TASK-1")).toMatchObject({ ok: true, changed: true });

        const park = o.office.get<{ how: string }>(
          "select resolved_how as how from parks where office_id = $office_id and park_id = 1",
        );
        expect(park?.how).toBe("discard");
        const question = o.office.get<{ how: string }>(
          "select closed_how as how from questions where office_id = $office_id",
        );
        expect(question?.how).toBe("ended");
        expect(entriesOf(o.office, "story.state", seq).map((d) => d["to"])).toEqual(["Refined"]);

        expect(await discard(o, "TASK-1")).toMatchObject({ ok: true, changed: false });
        expect(entriesOf(o.office, "story.state", seq)).toHaveLength(1);
      });
    });

    it("writes no Refined state and no backlog op for a claimed story the base says is Done", async () => {
      const seen = seenOf();
      await withReconcileOffice(
        { base: [{ id: "TASK-1", status: "Done" }], features: features(seen) },
        async (o) => {
          seen.office = o.office;
          seen.spawn = fakeBacklog(o.tables).spawn;
          const key = keyOf(o.office, "TASK-1");
          const record = await claim(o, o.office, "TASK-1", key, { active: false });
          await o.index.indexStories(o.officeId);
          const seq = lastSeq(o.office);

          expect(await discard(o, "TASK-1")).toMatchObject({ ok: true, changed: true });

          expect(existsSync(record.worktree)).toBe(false);
          expect(findClaim(o.office, record.runId)?.releaseReason).toBe("discard");
          expect(seen.ops).toEqual([]);
          expect(entriesOf(o.office, "story.state", seq)).toEqual([]);
        },
      );
    });
  });

  describe("work.discard touches only what it removed (DIPO-161 second review)", () => {
    it("leaves the leftovers of an earlier run, and their desk item, when it discards a live claim", async () => {
      const seen = seenOf();
      await withReconcileOffice({ base: PARKED, features: features(seen) }, async (o) => {
        seen.office = o.office;
        const key = keyOf(o.office, "TASK-1");
        // Leftovers of an earlier run of the story, settled with a kept worktree.
        o.office.run(
          `insert into done_elsewhere (office_id, run_id, key, story_id, branch, worktree, base,
           released_at, settled_at, worktree_kept, files)
         values ($office_id, 'run_earlier', $key, 'TASK-1', 'TASK-1/earlier', '/elsewhere/TASK-1',
           'main', 2, 3, 1, '["notes.txt"]')`,
          { key },
        );
        const record = await claim(o, o.office, "TASK-1", key, { active: false });

        expect(await discard(o, "TASK-1")).toMatchObject({ ok: true, changed: true });

        expect(findClaim(o.office, record.runId)?.releaseReason).toBe("discard");
        expect(findDoneElsewhere(o.office, "run_earlier" as RunId)?.clearedAt ?? null).toBeNull();
        expect(doneElsewhereDeskItems(o.office).map((item) => item.kind)).toEqual(["LEFTOVERS"]);
      });
    });

    it("never resolves a later park of another run, such as a hold, as discard on a re-run", async () => {
      const seen = seenOf();
      await withReconcileOffice({ base: PARKED, features: features(seen) }, async (o) => {
        seen.office = o.office;
        const key = keyOf(o.office, "TASK-1");
        const record = await claim(o, o.office, "TASK-1", key, { active: false });
        parkRow(o.office, key, record.runId);
        expect(await discard(o, "TASK-1")).toMatchObject({ ok: true, changed: true });
        // Later the story is held: a park without a run.
        o.office.run(
          `insert into parks (office_id, park_id, key, story_id, run_id, reason, detail, at)
         values ($office_id, 2, $key, 'TASK-1', null, 'by-maintainer', 'after M2', 9)`,
          { key },
        );

        expect(await discard(o, "TASK-1")).toMatchObject({ ok: true, changed: false });

        const hold = o.office.get<{ how: string | null }>(
          "select resolved_how as how from parks where office_id = $office_id and park_id = 2",
        );
        expect(hold?.how).toBeNull();
      });
    });
  });
}
