// CI only (0017 section 1, DIPO-225): real git repositories and processes, too slow for the local
// run.
// A story Done on the base through another branch (DIPO-161; 0020 section 10), with real git and a
// bare remote and the scripted Backlog CLI of helpers.ts: the DIPO-105 replay, a branch that adds
// nothing, a live worker, an own-branch teardown a crash interrupted, and the Done poll.

import { describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, type RunId, type StoryKey } from "@dipsaus-orchestrator/contract";

import { OFFICE_DEFAULTS } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import type { OfficeGit } from "../../src/git/office";
import { insertWorkerQuestion } from "../../src/hooks/questions";
import { reconcileOffice, type ReconcileReport } from "../../src/reconcile";
import { insertStoryPr, latestStoryPr } from "../../src/story-pr/records";
import { StoryTeardown } from "../../src/worktree/done";
import {
  DONE_ELSEWHERE_DESK,
  DONE_ELSEWHERE_NOTICES,
  doneElsewhereDeskItems,
  findDoneElsewhere,
} from "../../src/worktree/done-elsewhere";
import {
  type ClaimRecord,
  findClaim,
  liveClaimOf,
  openReleasedBranches,
  releaseClaim,
} from "../../src/worktree/records";
import { SlotTable } from "../../src/worktree/slots";
import { lastSeq } from "../stories/helpers";
import {
  claim,
  fakeBacklog,
  type FakeTask,
  keyOf,
  noticesAfter,
  type ReconcileOffice,
  setBranch,
  withReconcileOffice,
} from "./helpers";

const DONE: readonly FakeTask[] = [{ id: "TASK-1", status: "Done" }];

interface Closed {
  readonly repo: string;
  readonly number: number;
  readonly comment: string;
}

function hostOf(): {
  closePr: (repo: string, n: number, c: string) => Promise<void>;
  closed: Closed[];
} {
  const closed: Closed[] = [];
  return {
    closed,
    closePr: async (repo, number, comment) => {
      closed.push({ repo, number, comment });
    },
  };
}

function gitOf(o: ReconcileOffice): OfficeGit {
  const git = o.engineGit.forOffice(o.officeId);
  if (git === undefined) throw new Error("the office git is not attached");
  return git;
}

/** One reconcile at start with a fresh index pass. */
async function reconcile(
  o: ReconcileOffice,
  host = hostOf(),
  boxes = { n: 0 },
): Promise<{ report: ReconcileReport; host: ReturnType<typeof hostOf> }> {
  const slots = new SlotTable(join(o.repo.root, "slots.json"));
  const pass = await o.index.indexStories(o.officeId);
  const report = await reconcileOffice(
    {
      officeId: o.officeId,
      office: o.office,
      git: gitOf(o),
      clock: o.s.clock,
      slots,
      host,
      finishBoxes: async () => {
        boxes.n += 1;
      },
    },
    { trigger: "rescan", pass, reindex: () => o.index.indexStories(o.officeId) },
  );
  return { report, host };
}

async function tipOf(o: ReconcileOffice, ref: string): Promise<string | null> {
  const result = await o.repo.run(["git", "rev-parse", "--verify", "--quiet", ref], o.repo.dir);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function remoteTip(o: ReconcileOffice, branch: string): Promise<string> {
  return (await o.repo.git("ls-remote", "origin", `refs/heads/${branch}`)).split("\t")[0] ?? "";
}

/** The commit of `origin/main` that last changed TASK-1's task file. */
async function taskCommit(o: ReconcileOffice): Promise<string> {
  return (
    await o.repo.git("log", "-1", "--format=%H", "origin/main", "--", "backlog/tasks")
  ).trim();
}

function endRun(office: OfficeHandle, runId: RunId, at = 1): void {
  office.run(
    "update runs set ended_at = $at, end_kind = 'parked' where office_id = $office_id and run_id = $run",
    { run: runId, at },
  );
}

/** The branch merged into `main` on the remote by hand, and fetched: it adds nothing to the base. */
async function mergeOnRemote(o: ReconcileOffice, record: ClaimRecord): Promise<void> {
  await o.repo.git("push", "--quiet", "origin", `${record.branch}:main`);
  await o.repo.git("fetch", "--quiet", "origin");
}

function parkRow(office: OfficeHandle, key: StoryKey, runId: RunId): void {
  office.run(
    `insert into parks (office_id, park_id, key, story_id, run_id, reason, detail, last_good_commit, at)
     values ($office_id, 1, $key, 'TASK-1', $run, 'budget-exceeded', 'turn cap 61 of 60', null, 1)`,
    { key, run: runId },
  );
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("a story Done on the base through another branch (DIPO-161)", () => {
    it("replays DIPO-105: the parked claim is released, the dirty worktree and the branch are kept, one leftovers item is on the desk", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const key = keyOf(o.office, "TASK-1");
        const record = await claim(o, o.office, "TASK-1", key, { active: false });
        // Parked on its branch: the park commit, then work left uncommitted, pushed as dipo did.
        await setBranch(o, record, {
          id: "TASK-1",
          status: "Parked",
          fields: ['park: {reason: "budget-exceeded", from: "In Progress", note: "turn cap"}'],
        });
        await o.repo.git("push", "--quiet", "origin", record.branch);
        parkRow(o.office, key, record.runId);
        o.office.immediate(() =>
          insertWorkerQuestion(o.office, {
            questionId: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
            runId: record.runId,
            agentId: "agt_1",
            text: "Keep the old flag?",
            at: 1,
          }),
        );
        o.office.immediate(() =>
          insertStoryPr(o.office, {
            runId: record.runId,
            key,
            number: 105,
            url: "https://github.com/o/r/pull/105",
            branch: record.branch,
            base: "main",
            headSha: record.claimSha ?? "",
            state: "open",
            title: "feat(TASK-1): x",
            bodyHash: "h",
            openedAt: 1,
            closedAt: null,
          }),
        );
        writeFileSync(join(record.worktree, "README.md"), "changed by the worker\n");
        writeFileSync(join(record.worktree, "new-file.ts"), "export {};\n");
        const local = await tipOf(o, `refs/heads/${record.branch}`);
        const remote = await remoteTip(o, record.branch);
        const commit = await taskCommit(o);
        const seq = lastSeq(o.office);

        const { host } = await reconcile(o);

        // The claim is released with its run ended; the park and the question are closed.
        const released = findClaim(o.office, record.runId);
        expect(released?.releaseReason).toBe("done-elsewhere");
        expect(liveClaimOf(o.office, key)).toBeNull();
        const park = o.office.get<{ how: string }>(
          "select resolved_how as how from parks where office_id = $office_id and park_id = 1",
        );
        expect(park?.how).toBe("done-elsewhere");
        const question = o.office.get<{ how: string }>(
          "select closed_how as how from questions where office_id = $office_id",
        );
        expect(question?.how).toBe("ended");
        // The story is Done, with a notice naming the base commit that last changed its task file.
        const states = o.office
          .all<{ delta: string }>(
            "select delta from change_log where office_id = $office_id and seq > $seq and type = 'story.state'",
            { seq },
          )
          .map((row) => JSON.parse(row.delta) as { from: string; to: string });
        expect(states.some((state) => state.from === "Parked" && state.to === "Done")).toBe(true);
        const notices = noticesAfter(o.office, seq);
        const releasedNotice = notices.find((n) => n.code === DONE_ELSEWHERE_NOTICES.released);
        expect(releasedNotice?.text).toContain(commit.slice(0, 12));
        // dipo's open story PR is closed with a comment naming that commit.
        expect(host.closed).toEqual([
          { repo: "o/r", number: 105, comment: expect.stringContaining(commit.slice(0, 12)) },
        ]);
        expect(latestStoryPr(o.office, key)?.state).toBe("closed");
        // The worktree with uncommitted files and the branch are kept, locally and on the remote.
        expect(existsSync(join(record.worktree, "new-file.ts"))).toBe(true);
        expect(await tipOf(o, `refs/heads/${record.branch}`)).toBe(local);
        expect(await remoteTip(o, record.branch)).toBe(remote);
        expect(openReleasedBranches(o.office, key).map((r) => [r.branch, r.reason])).toEqual([
          [record.branch, "done-elsewhere"],
        ]);
        // One leftovers item, with the commits not on the base, the dirty files and the action.
        const items = doneElsewhereDeskItems(o.office);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          kind: DONE_ELSEWHERE_DESK.leftovers,
          key,
          story: "TASK-1",
          actions: [{ command: "work.discard", cli: 'dipo discard TASK-1 --note "<why>"' }],
        });
        expect(items[0]?.commits.map((c) => c.subject)).toEqual([
          "TASK-1: status Parked",
          "TASK-1: status In Progress",
        ]);
        expect(items[0]?.files.toSorted()).toEqual(["README.md", "new-file.ts"]);
        // A second reconcile changes nothing: leftovers are never deleted automatically.
        await reconcile(o);
        expect(existsSync(join(record.worktree, "new-file.ts"))).toBe(true);
        expect(doneElsewhereDeskItems(o.office)).toHaveLength(1);
      }));

    it("leaves a story merged through its own branch to the Done poll, which tears it down as done (DIPO-332)", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const key = keyOf(o.office, "TASK-1");
        const record = await claim(o, o.office, "TASK-1", key, { active: false });
        await o.repo.git("push", "--quiet", "origin", record.branch);
        await mergeOnRemote(o, record);
        const seq = lastSeq(o.office);

        await reconcile(o);

        // Not Done elsewhere: its own branch merged, so reconcile releases nothing.
        expect(liveClaimOf(o.office, key)).not.toBeNull();
        expect(findDoneElsewhere(o.office, record.runId)).toBeNull();
        expect(existsSync(record.worktree)).toBe(true);

        const teardown = new StoryTeardown({
          git: () => gitOf(o),
          host: null,
          cli: { spawn: fakeBacklog(o.tables).spawn },
          offices: { get: () => o.office, config: () => OFFICE_DEFAULTS },
          statusOf: async () => "Done",
        });
        teardown.track(o.officeId as OfficeId, o.office, o.s.clock);
        const report = await teardown.poll(o.officeId as OfficeId);
        teardown.stop();

        expect(report.tornDown.map((c) => c.runId)).toEqual([record.runId]);
        expect(findClaim(o.office, record.runId)?.releaseReason).toBe("done");
        expect(existsSync(record.worktree)).toBe(false);
        expect(await tipOf(o, `refs/heads/${record.branch}`)).toBeNull();
        expect(await remoteTip(o, record.branch)).toBe("");
        expect(findDoneElsewhere(o.office, record.runId)).toBeNull();
        expect(doneElsewhereDeskItems(o.office)).toEqual([]);
        const codes = noticesAfter(o.office, seq).map((n) => n.code);
        expect(codes).not.toContain(DONE_ELSEWHERE_NOTICES.released);
      }));

    it("flags a live worker once with a DONE ELSEWHERE item and releases it only at the run's next end", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const key = keyOf(o.office, "TASK-1");
        const record = await claim(o, o.office, "TASK-1", key);
        const seq = lastSeq(o.office);

        await reconcile(o);
        await reconcile(o);

        expect(liveClaimOf(o.office, key)).not.toBeNull();
        expect(existsSync(record.worktree)).toBe(true);
        const live = noticesAfter(o.office, seq).filter(
          (n) => n.code === DONE_ELSEWHERE_NOTICES.live,
        );
        expect(live).toHaveLength(1);
        expect(live[0]?.text).toContain("dipo park TASK-1");
        expect(doneElsewhereDeskItems(o.office)).toMatchObject([
          {
            kind: DONE_ELSEWHERE_DESK.live,
            key,
            actions: [{ cli: 'dipo park TASK-1 --note "<why>"' }],
          },
        ]);

        // The run ends (a park, In Review or a stop): the next reconcile releases the claim.
        endRun(o.office, record.runId);
        await reconcile(o);

        expect(findClaim(o.office, record.runId)?.releaseReason).toBe("done-elsewhere");
        expect(findDoneElsewhere(o.office, record.runId)?.releasedAt).not.toBeNull();
        expect(
          doneElsewhereDeskItems(o.office).filter((i) => i.kind === DONE_ELSEWHERE_DESK.live),
        ).toEqual([]);
      }));

    it("deletes the kept branch of an own-branch teardown a crash interrupted, released as done, when it adds nothing", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const key = keyOf(o.office, "TASK-1");
        const record = await claim(o, o.office, "TASK-1", key, { active: false });
        await o.repo.git("push", "--quiet", "origin", record.branch);
        await mergeOnRemote(o, record);
        // The teardown removed the worktree and crashed; DIPO-216 released the claim as done, and
        // the branch stayed, locally and on the remote.
        await o.repo.git("worktree", "unlock", record.worktree);
        await o.repo.git("worktree", "remove", record.worktree);
        gitOf(o).unpinWorktree(record.worktree);
        o.office.immediate(() => {
          o.office.run(
            "update claims set teardown_started_at = 5 where office_id = $office_id and run_id = $run",
            { run: record.runId },
          );
          releaseClaim(o.office, record.runId, { at: 6, reason: "done", keepBranch: false });
        });
        expect(await tipOf(o, `refs/heads/${record.branch}`)).not.toBeNull();

        await reconcile(o);

        expect(await tipOf(o, `refs/heads/${record.branch}`)).toBeNull();
        expect(await remoteTip(o, record.branch)).toBe("");
        expect(findClaim(o.office, record.runId)?.releaseReason).toBe("done");
        expect(findDoneElsewhere(o.office, record.runId)).toMatchObject({ branchKept: false });
      }));
  });

  describe("the Done poll reads a claimed story's status on the base (DIPO-161)", () => {
    it("releases a parked claim whose story is Done on the base and leaves one that is not", () =>
      withReconcileOffice(
        {
          base: [
            { id: "TASK-1", status: "Done" },
            { id: "TASK-2", status: "Ready" },
          ],
        },
        async (o) => {
          const one = await claim(o, o.office, "TASK-1", keyOf(o.office, "TASK-1"), {
            active: false,
          });
          const two = await claim(o, o.office, "TASK-2", keyOf(o.office, "TASK-2"), {
            active: false,
          });
          await o.index.indexStories(o.officeId);
          const host = hostOf();
          const boxes = { n: 0 };
          const teardown = new StoryTeardown({
            git: () => gitOf(o),
            host: null,
            cli: { spawn: fakeBacklog(o.tables).spawn },
            offices: { get: () => o.office, config: () => OFFICE_DEFAULTS },
            prCloser: host,
            finishBoxes: async () => {
              boxes.n += 1;
            },
          });
          teardown.track(o.officeId as OfficeId, o.office, o.s.clock);

          const report = await teardown.poll(o.officeId as OfficeId);

          expect(report.released?.map((c) => c.runId)).toEqual([one.runId]);
          expect(findClaim(o.office, one.runId)?.releaseReason).toBe("done-elsewhere");
          expect(liveClaimOf(o.office, two.key as StoryKey)).not.toBeNull();
          expect(existsSync(two.worktree)).toBe(true);
          // The released run's box is deleted too (0021 section 6).
          expect(boxes.n).toBe(1);
          teardown.stop();
        },
      ));
  });

  describe("a story Done elsewhere: the box and the remote branch (DIPO-161 review)", () => {
    it("deletes the released run's box after the release in reconcile", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const key = keyOf(o.office, "TASK-1");
        await claim(o, o.office, "TASK-1", key, { active: false });
        const boxes = { n: 0 };
        await reconcile(o, hostOf(), boxes);
        expect(boxes.n).toBe(1);
      }));

    it("keeps a branch that adds nothing when its remote tip holds commits neither local nor on the base, and lists them", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const key = keyOf(o.office, "TASK-1");
        const record = await claim(o, o.office, "TASK-1", key, { active: false });
        await o.repo.git("push", "--quiet", "origin", record.branch);
        await mergeOnRemote(o, record);
        // An own-branch teardown a crash interrupted after the worktree removal, released as done:
        // its kept branch is settled by reconcile (a live claim merged through its own branch is the
        // Done poll's, DIPO-332).
        await o.repo.git("worktree", "unlock", record.worktree);
        await o.repo.git("worktree", "remove", record.worktree);
        gitOf(o).unpinWorktree(record.worktree);
        o.office.immediate(() => {
          o.office.run(
            "update claims set teardown_started_at = 5 where office_id = $office_id and run_id = $run",
            { run: record.runId },
          );
          releaseClaim(o.office, record.runId, { at: 6, reason: "done", keepBranch: false });
        });
        // Someone pushes a commit with a change of their own to the branch on the host.
        const elsewhere = join(o.repo.root, "elsewhere");
        await o.repo.git(
          "worktree",
          "add",
          "--quiet",
          "--detach",
          elsewhere,
          record.claimSha ?? "",
        );
        writeFileSync(join(elsewhere, "theirs.txt"), "their change\n");
        for (const args of [
          ["git", "add", "--", "theirs.txt"],
          ["git", "commit", "--quiet", "--no-verify", "-m", "theirs on the host"],
        ] as const) {
          await o.repo.run(args, elsewhere);
        }
        const theirs = (await o.repo.run(["git", "rev-parse", "HEAD"], elsewhere)).stdout.trim();
        await o.repo.git("push", "--quiet", "origin", `${theirs}:refs/heads/${record.branch}`);
        await o.repo.git("worktree", "remove", "--force", elsewhere);

        await reconcile(o);

        expect(await tipOf(o, `refs/heads/${record.branch}`)).toBe(record.claimSha);
        expect(await remoteTip(o, record.branch)).toBe(theirs);
        const row = findDoneElsewhere(o.office, record.runId);
        expect(row?.branchKept).toBe(true);
        expect(row?.commits.map((c) => c.subject)).toEqual(["theirs on the host"]);
        expect(doneElsewhereDeskItems(o.office).map((i) => i.kind)).toEqual([
          DONE_ELSEWHERE_DESK.leftovers,
        ]);
      }));
  });
}
