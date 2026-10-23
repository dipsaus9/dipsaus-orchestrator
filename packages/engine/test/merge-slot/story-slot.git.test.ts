// The story merge slot on real git, the pinned Backlog CLI and a bare remote under DIPO_TMP, with
// an in-memory code host whose squash merge really merges on the remote (DIPO-150; 0019 sections
// 6 and 9), on a migrated state database built from fixtures:
//
// - a story PR whose review approved its head and whose checks are green goes through the
//   close-out commit (final summary, modified files, status Done), the sync (nothing to merge: no
//   conflict), one push, the checks of the pushed head and a squash merge with
//   `--match-head-commit` at exactly that head;
// - after the host refused because the base moved, the slot merges the base cleanly, records the
//   merge, and the approval of the head before it carries to the merged head (only that merge and
//   a task-file commit lie between them) with no new review round; the PR merges at that head.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "bun:test";

import { type OfficeId, type RunId, StoryId } from "@dipsaus-orchestrator/contract";
import { git, type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { setFinalSummary } from "../../src/backlog/fields/summary";
import type { StoryTarget } from "../../src/backlog/fields/write";
import { OFFICE_DEFAULTS } from "../../src/config";
import {
  gitStorySlotOps,
  MergeSlot,
  mergeGatesOfRun,
  RELEASE_PATH_HOLD,
  slotOccupant,
  writeCloseOutSummary,
} from "../../src/merge-slot";
import { CodeHostError, type HostPr, type RequiredCheck } from "../../src/platform/host";
import { recordReviewVerdict, reviewVerdictForTree } from "../../src/review/store";
import { StoryConflicts } from "../../src/run/conflicts";
import { gitParkWriter } from "../../src/run/park";
import { endRun, findRun, insertRun, REVIEWED_END, runRoundCounts } from "../../src/run/records";
import { findStoryPr, insertStoryPr, updateStoryPr } from "../../src/story-pr/records";
import { addStory } from "../../src/stories/keys";
import { claimStory } from "../../src/worktree";
import { otherClone, publish, squashMergeOnRemote } from "../backlog/lane/helpers";
import { FakeHost } from "../backlog/pr/helpers";
import { BACKLOG_FIXTURE, BRANCH_1, claimSetup, TASK_1, TASK_FILE_1 } from "../worktree/helpers";

import { APPROVED, TITLE } from "./story-helpers";

const REPO = "o/r";
const PR = 7;

/** A host whose PR #7 shows the remote branch's tip, and whose squash merge merges on the remote. */
class RemoteHost extends FakeHost {
  refusals = 0;
  onRefuse: () => Promise<void> = async () => {};
  readonly merges: { headSha: string; subject: string }[] = [];
  merged = false;

  constructor(readonly repo: TempRepoWithRemote) {
    super();
  }

  async #tip(): Promise<string> {
    return (
      await git(this.repo.remote, this.repo.home, "rev-parse", `refs/heads/${BRANCH_1}`)
    ).trim();
  }

  override async viewPr(): Promise<HostPr> {
    return {
      number: PR,
      url: `https://github.com/${REPO}/pull/${PR}`,
      state: this.merged ? "merged" : "open",
      head: BRANCH_1,
      headSha: await this.#tip(),
      base: "main",
      title: TITLE,
      mergeCommit: null,
    };
  }

  override async requiredChecks(): Promise<RequiredCheck[]> {
    return [];
  }

  async prLabels(): Promise<string[]> {
    return [];
  }

  override async squashMerge(
    _repo: string,
    _number: number,
    merge?: { headSha: string; subject: string },
  ): Promise<void> {
    if (this.refusals > 0) {
      this.refusals -= 1;
      await this.onRefuse();
      throw new CodeHostError("failed", "Base branch was modified.");
    }
    // --match-head-commit: only the head the host shows merges.
    if (merge?.headSha !== (await this.#tip())) {
      throw new CodeHostError("failed", "Head branch was modified.");
    }
    this.merges.push({ headSha: merge.headSha, subject: merge.subject });
    await squashMergeOnRemote(this.repo, BRANCH_1);
    this.merged = true;
  }
}

async function scenario(
  repo: TempRepoWithRemote,
  fn: (w: {
    readonly slot: MergeSlot;
    readonly host: RemoteHost;
    readonly officeId: OfficeId;
    readonly run: RunId;
    readonly head: string;
    readonly tree: (head: string) => Promise<string | null>;
    readonly s: Awaited<ReturnType<typeof claimSetup>>;
    readonly slotGit: ReturnType<typeof gitStorySlotOps>;
  }) => Promise<void>,
  /** The worker's change in the story worktree, staged; by default a new export.txt. */
  change: (worktree: string, repo: TempRepoWithRemote) => Promise<void> = writeExport,
): Promise<void> {
  await publish(repo);
  const s = await claimSetup(repo);
  const office = s.office;
  const officeId = office.officeId as OfficeId;
  const { key } = office.immediate(() =>
    addStory(office, s.t.ids, { story: StoryId.parse(TASK_1) }, s.t.clock.now()),
  );
  const request = s.request(key);
  const outcome = await claimStory(s.deps(), request);
  if (!outcome.ok) throw new Error(`the claim was skipped: ${outcome.reason}`);
  const claim = outcome.claim;
  // The worker's code, committed on the story branch (as a part would be).
  await change(claim.worktree, repo);
  await git(claim.worktree, repo.home, "commit", "--quiet", "-m", "feat: export as CSV");
  await git(claim.worktree, repo.home, "push", "--quiet", "origin", BRANCH_1);
  const head = (await git(claim.worktree, repo.home, "rev-parse", "HEAD")).trim();
  const slotGit = gitStorySlotOps({ git: () => s.git, cli: s.cli });
  const tree = (at: string) => slotGit.treeKey(officeId, TASK_1, at);
  const run = request.runId;
  const now = s.t.clock.now();
  const codeTree = (await tree(head)) as string;
  office.immediate(() => {
    insertRun(office, {
      runId: run,
      kind: "story",
      key,
      story: TASK_1,
      tier: "M",
      role: "developer",
      model: "sonnet",
      startSha: claim.startSha,
      branch: BRANCH_1,
      worktree: claim.worktree,
      slot: null,
      budgetUnit: "tokens",
      budgetLimit: 1_000_000,
      loopCap: 3,
      maxTurns: 100,
      maxMinutes: 60,
      reviewRoundCap: 3,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: now,
    });
    office.run(
      `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at,
         ended_at, end_reason)
       values ($office_id, $agent, $run, 'developer', 'sonnet', 's', $at, $at, 'exited')`,
      { agent: s.t.ids.next("agt"), run, at: now },
    );
    endRun(office, run, now, REVIEWED_END);
    insertStoryPr(office, {
      runId: run,
      key,
      number: PR,
      url: `https://github.com/${REPO}/pull/${PR}`,
      branch: BRANCH_1,
      base: "main",
      headSha: head,
      state: "open",
      title: TITLE,
      bodyHash: "hash",
      openedAt: now,
      closedAt: null,
    });
    recordReviewVerdict(office, s.t.ids, {
      runId: run,
      key,
      round: 1,
      agent: null,
      model: "opus",
      commit: head,
      codeTreeKey: codeTree,
      judged: APPROVED,
      at: now,
    });
  });
  const host = new RemoteHost(repo);
  const conflicts = new StoryConflicts({
    clock: s.t.clock,
    ids: s.t.ids,
    offices: { get: () => office, config: () => OFFICE_DEFAULTS },
    git: () => s.git,
  });
  const slot = new MergeSlot({
    host,
    prs: { recheck: () => Promise.reject(new Error("no backlog PR here")) },
    lane: () => undefined,
    offices: { get: () => office, config: () => OFFICE_DEFAULTS },
    clock: s.t.clock,
    stories: {
      git: slotGit,
      ids: s.t.ids,
      labels: host,
      // The PR poll saw the checks of the stored head green.
      ci: () => ({ kind: "green", head: findStoryPr(office, run)?.headSha ?? "" }),
      prSync: async () => {
        const tip = (await git(repo.dir, repo.home, "rev-parse", `refs/heads/${BRANCH_1}`)).trim();
        office.immediate(() =>
          updateStoryPr(office, run, { headSha: tip, title: TITLE, bodyHash: "hash" }),
        );
      },
      summary: writeCloseOutSummary,
      recordMerge: (_office, stored, merged) =>
        conflicts.recorded(
          {
            runId: stored.runId,
            office: officeId,
            story: TASK_1,
            branch: BRANCH_1,
            startSha: claim.startSha,
            box: "none",
          },
          merged,
          { strict: true },
        ),
    },
  });
  await fn({ slot, host, officeId, run, head, tree, s, slotGit });
}

/** The default worker change: a new export.txt. */
async function writeExport(worktree: string, repo: TempRepoWithRemote): Promise<void> {
  writeFileSync(join(worktree, "export.txt"), "csv\n");
  await git(worktree, repo.home, "add", "export.txt");
}

describe("the story merge slot on real git", () => {
  it("closes out, pushes once and squash-merges at the pushed head with the PR title", async () => {
    await withBareRemote(
      async (repo) =>
        scenario(repo, async ({ slot, host, officeId }) => {
          expect(await slot.tick(officeId)).toBe("merged");
          const tip = (
            await git(repo.remote, repo.home, "rev-parse", `refs/heads/${BRANCH_1}`)
          ).trim();
          expect(host.merges).toEqual([{ headSha: tip, subject: TITLE }]);
          // The close-out commit is the merged head: the task file alone, status Done.
          const subject = await git(repo.remote, repo.home, "log", "-1", "--format=%s", tip);
          expect(subject.trim()).toBe(`${TASK_1}: status Done`);
          const files = await git(
            repo.remote,
            repo.home,
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            tip,
          );
          expect(files.trim()).toBe(TASK_FILE_1);
          const task = await git(repo.remote, repo.home, "show", `${tip}:${TASK_FILE_1}`);
          expect(task).toContain("status: Done");
          expect(task).toContain("export.txt");
          expect(task).toContain("Final Summary");
          // Merged on the remote's main.
          const main = await git(repo.remote, repo.home, "show", "main:export.txt");
          expect(main).toBe("csv\n");
        }),
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("carries the approval over the slot's clean merge of a moved base and a task-file commit, with no review round", async () => {
    await withBareRemote(
      async (repo) =>
        scenario(repo, async ({ slot, host, officeId, run, head, tree, s }) => {
          // The base moves while the PR is in the slot: the host refuses once.
          host.refusals = 1;
          host.onRefuse = async () => {
            const other = await otherClone(repo);
            writeFileSync(join(other, "README.md"), "moved on\n");
            await git(other, repo.home, "add", "README.md");
            await git(other, repo.home, "commit", "--quiet", "-m", "another change");
            await git(other, repo.home, "push", "--quiet", "origin", "HEAD:main");
          };
          expect(await slot.tick(officeId)).toBe("merged");
          const tip = (
            await git(repo.remote, repo.home, "rev-parse", `refs/heads/${BRANCH_1}`)
          ).trim();
          // The merged head is the slot's clean merge of the moved base.
          const parents = (
            await git(repo.remote, repo.home, "rev-list", "--parents", "-n", "1", tip)
          )
            .trim()
            .split(" ");
          expect(parents).toHaveLength(3);
          expect(host.merges).toEqual([{ headSha: tip, subject: TITLE }]);
          // The approval of the reviewed head carried to the merged head's code tree.
          const carried = reviewVerdictForTree(s.office, run, (await tree(tip)) as string);
          expect(carried).toMatchObject({
            verdict: "approved",
            carriedFrom: head,
            agent: null,
            commit: tip,
          });
          expect(runRoundCounts(s.office, run).reviewRounds).toBe(0);
          expect(slotOccupant(s.office)).toBeNull();
        }),
      { fixture: BACKLOG_FIXTURE },
    );
  });
});

describe("the close-out commit of a story that held a park record (DIPO-324, 0019 section 9)", () => {
  it("removes the F16 park block through the single field write path in the commit that sets Done", async () => {
    await withBareRemote(
      async (repo) =>
        scenario(repo, async ({ officeId, run, s }) => {
          const stored = findRun(s.office, run)!;
          const worktree = stored.worktree as string;
          // A park whose record stayed on the branch (DIPO-129's stale block).
          await gitParkWriter({ git: () => s.git, cli: s.cli }).write(officeId, {
            story: TASK_1,
            branch: BRANCH_1,
            worktree,
            reason: "conflict",
            note: "base moved during merge 3 times",
          });
          const parked = await git(
            repo.dir,
            repo.home,
            "show",
            `refs/heads/${BRANCH_1}:${TASK_FILE_1}`,
          );
          expect(parked).toMatch(/^park:$/m);
          const slotGit = gitStorySlotOps({ git: () => s.git, cli: s.cli });
          const commit = await slotGit.closeOut(
            officeId,
            {
              runId: run,
              story: TASK_1,
              branch: BRANCH_1,
              worktree,
              startSha: stored.startSha as string,
            },
            (target) => setFinalSummary(target, "Done by the slot."),
          );
          expect(commit).not.toBeNull();
          const closed = await git(repo.dir, repo.home, "show", `${commit}:${TASK_FILE_1}`);
          expect(closed).toMatch(/^status: Done$/m);
          expect(closed).not.toMatch(/^park:$/m);
          expect(closed).not.toContain("base moved during merge");
          // One commit of the task file alone.
          const files = await git(
            repo.dir,
            repo.home,
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            commit as string,
          );
          expect(files.trim().split("\n")).toEqual([TASK_FILE_1]);
        }),
      { fixture: BACKLOG_FIXTURE },
    );
  });
});

describe("the close-out commit on a later stay in the slot", () => {
  it("writes the final summary and the modified files again when the story is Done already", async () => {
    await withBareRemote(
      async (repo) =>
        scenario(repo, async ({ officeId, run, s }) => {
          const stored = findRun(s.office, run)!;
          const slotRun = {
            runId: run,
            story: TASK_1,
            branch: BRANCH_1,
            worktree: stored.worktree as string,
            startSha: stored.startSha as string,
          };
          const slotGit = gitStorySlotOps({ git: () => s.git, cli: s.cli });
          let summary = "first stay";
          const write = (target: StoryTarget) => setFinalSummary(target, summary);
          const first = await slotGit.closeOut(officeId, slotRun, write);
          expect(first).not.toBeNull();
          // A fix round added code since; the next stay closes out again.
          await git(slotRun.worktree, repo.home, "checkout", "--quiet", "--", ".");
          writeFileSync(join(slotRun.worktree, "later.txt"), "later\n");
          await git(slotRun.worktree, repo.home, "add", "later.txt");
          await git(slotRun.worktree, repo.home, "commit", "--quiet", "-m", "feat: later");
          summary = "second stay";
          const second = await slotGit.closeOut(officeId, slotRun, write);
          expect(second).not.toBeNull();
          const task = await git(repo.dir, repo.home, "show", `${second}:${TASK_FILE_1}`);
          expect(task).toContain("status: Done");
          expect(task).toContain("later.txt");
          expect(task).toContain("second stay");
          expect(task).not.toContain("first stay");
          // Nothing new: no commit.
          expect(await slotGit.closeOut(officeId, slotRun, write)).toBeNull();
        }),
      { fixture: BACKLOG_FIXTURE },
    );
  });
});

// The release path on real git (DIPO-331): CODEOWNERS read from the base as last fetched, the PR's
// diff from its merge base with the base, and the held PR never merged.

const CODEOWNERS = readFileSync(join(import.meta.dir, "../../../../.github/CODEOWNERS"), "utf8");

/** The base the fixture publishes: the repository's own CODEOWNERS, a workflow and install.sh. */
function releaseBase(repo: TempRepoWithRemote, extra: Record<string, string> = {}): void {
  const files: Record<string, string> = {
    ".github/CODEOWNERS": CODEOWNERS,
    ".github/workflows/ci.yml": "name: ci\n",
    "install.sh": "#!/bin/sh\n",
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  }
}

describe("the release path of a story PR on real git", () => {
  it("holds a PR that changes a workflow, also when it edits CODEOWNERS to leave itself out", async () => {
    await withBareRemote(
      async (repo) => {
        releaseBase(repo);
        await scenario(
          repo,
          async ({ slot, host, officeId, run, head, s, slotGit }) => {
            expect(await slotGit.releasePaths(officeId, head)).toEqual([
              ".github/CODEOWNERS",
              ".github/workflows/ci.yml",
            ]);
            // Fail closed: a head git cannot read has no answer, and the slot then merges nothing.
            expect(await slotGit.releasePaths(officeId, "0".repeat(40))).toBeNull();
            expect(await slot.tick(officeId)).toBe("idle");
            expect(await slot.tick(officeId)).toBe("idle");
            expect(host.merges).toEqual([]);
            expect(slotOccupant(s.office)).toBeNull();
            const gates = mergeGatesOfRun(s.office, run);
            expect(gates).toHaveLength(1);
            expect(gates[0]).toMatchObject({
              head,
              waitingOn: "maintainer",
              handMerge: RELEASE_PATH_HOLD,
              decision: null,
            });
            expect(gates[0]?.summary).toContain(".github/CODEOWNERS, .github/workflows/ci.yml");
            // Nothing reached the remote's main.
            const main = await git(repo.remote, repo.home, "show", "main:.github/workflows/ci.yml");
            expect(main).toBe("name: ci\n");
          },
          async (worktree) => {
            writeFileSync(join(worktree, ".github/workflows/ci.yml"), "name: ci\non: push\n");
            writeFileSync(join(worktree, ".github/CODEOWNERS"), "# nobody owns anything\n");
            await git(worktree, repo.home, "add", ".github");
          },
        );
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("counts a file moved out of the release path as a change to it", async () => {
    await withBareRemote(
      async (repo) => {
        releaseBase(repo);
        await scenario(
          repo,
          async ({ slot, host, officeId, head, slotGit }) => {
            expect(await slotGit.releasePaths(officeId, head)).toEqual(["install.sh"]);
            expect(await slot.tick(officeId)).toBe("idle");
            expect(host.merges).toEqual([]);
          },
          async (worktree) => {
            mkdirSync(join(worktree, "scripts"), { recursive: true });
            await git(worktree, repo.home, "mv", "install.sh", "scripts/install.sh");
          },
        );
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("merges a PR outside the release path; the first CODEOWNERS location on the base counts", async () => {
    await withBareRemote(
      async (repo) => {
        // A root CODEOWNERS that would own everything: GitHub reads .github/CODEOWNERS first.
        releaseBase(repo, { CODEOWNERS: "* @someone\n" });
        await scenario(repo, async ({ slot, host, officeId, run, head, s, slotGit }) => {
          expect(await slotGit.releasePaths(officeId, head)).toEqual([]);
          expect(await slot.tick(officeId)).toBe("merged");
          expect(host.merges).toHaveLength(1);
          expect(mergeGatesOfRun(s.office, run)[0]).toMatchObject({ handMerge: null });
        });
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});
