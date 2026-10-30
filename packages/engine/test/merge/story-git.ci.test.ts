// CI only (0017 section 1): real git repositories and processes, too slow for the local run.
// The auto-merge of a story PR on real git (0002), the pinned Backlog CLI and a bare remote under
// DIPO_TMP, with an in-memory code host whose auto-merge really squash-merges on the remote, on a
// migrated state database built from fixtures:
//
// - a story PR whose review approved its head and whose checks are green gets the close-out commit
//   (final summary, modified files, status Done), one push, and auto-merge at exactly that head;
// - the close-out removes a park record, and writes the summary and modified files again later;
// - the release path read from git: CODEOWNERS from the base as last fetched, the PR's diff from its
//   merge base with the base; such a PR never gets auto-merge.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "bun:test";

import { type OfficeId, type RunId, StoryId } from "@dipsaus-orchestrator/contract";
import { git, type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import {
  AutoMerge,
  gitStoryMergeOps,
  mergeGatesOfRun,
  RELEASE_PATH_HOLD,
  writeCloseOutSummary,
} from "../../src/merge";
import type { HostPr, RequiredCheck } from "../../src/platform/host";
import { recordReviewVerdict } from "../../src/review/store";
import { gitParkWriter } from "../../src/run/park";
import { findRun, insertRun } from "../../src/records/run-records";
import { reviewedAt } from "../run/in-review";
import { findStoryPr, insertStoryPr, updateStoryPr } from "../../src/story-pr/records";
import { addStory } from "../../src/stories/keys";
import type { StoryEditor } from "../../src/story-store/store";
import { claimStory } from "../../src/worktree";
import { publish, squashMergeOnRemote } from "../backlog/lane/helpers";
import { FakeHost } from "../backlog/pr/helpers";
import {
  BACKLOG_FIXTURE,
  BRANCH_1,
  byHandOn,
  claimSetup,
  TASK_1,
  TASK_FILE_1,
} from "../worktree/helpers";

import { APPROVED, TITLE } from "./story-helpers";
import { backlogStoryStore } from "../../src/backlog/store";
import { backlogLayout } from "../story-store/backlog";

const REPO = "o/r";
const PR = 7;

/**
 * A host whose PR #7 shows the remote branch's tip, and whose auto-merge, with green checks,
 * squash-merges on the remote at once at the head it was given.
 */
class RemoteHost extends FakeHost {
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
      mergeable: "mergeable",
      autoMerge: false,
    };
  }

  override async requiredChecks(): Promise<RequiredCheck[]> {
    return [];
  }

  async prLabels(): Promise<string[]> {
    return [];
  }

  override async enableAutoMerge(
    _repo: string,
    _number: number,
    merge: { readonly headSha: string; readonly subject: string },
  ): Promise<void> {
    // --match-head-commit: only the head the host shows merges.
    if (merge.headSha !== (await this.#tip())) throw new Error("Head branch was modified.");
    this.merges.push({ headSha: merge.headSha, subject: merge.subject });
    await squashMergeOnRemote(this.repo, BRANCH_1);
    this.merged = true;
  }
}

async function scenario(
  repo: TempRepoWithRemote,
  fn: (w: {
    readonly merge: AutoMerge;
    readonly host: RemoteHost;
    readonly officeId: OfficeId;
    readonly run: RunId;
    readonly head: string;
    readonly tree: (head: string) => Promise<string | null>;
    readonly s: Awaited<ReturnType<typeof claimSetup>>;
    readonly mergeGit: ReturnType<typeof gitStoryMergeOps>;
  }) => Promise<void>,
  /** The worker's change in a checkout of the story branch, staged; by default a new export.txt. */
  change: (checkout: string, repo: TempRepoWithRemote) => Promise<void> = writeExport,
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
  const head = await byHandOn(repo, BRANCH_1, async (dir) => {
    await change(dir, repo);
    await git(dir, repo.home, "commit", "--quiet", "-m", "feat: export as CSV");
    await git(dir, repo.home, "push", "--quiet", "origin", BRANCH_1);
    return (await git(dir, repo.home, "rev-parse", "HEAD")).trim();
  });
  const mergeGit = gitStoryMergeOps({ git: () => s.git, stories: backlogStoryStore(s.cli) });
  const tree = (at: string) => mergeGit.treeKey(officeId, TASK_1, at);
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
    reviewedAt(office, run, now);
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
  const merge = new AutoMerge({
    host,
    offices: { get: () => office, config: () => OFFICE_DEFAULTS },
    clock: s.t.clock,
    stories: {
      stories: backlogLayout,
      git: mergeGit,
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
    },
  });
  await fn({ merge, host, officeId, run, head, tree, s, mergeGit });
}

/** The default worker change: a new export.txt. */
async function writeExport(checkout: string, repo: TempRepoWithRemote): Promise<void> {
  writeFileSync(join(checkout, "export.txt"), "csv\n");
  await git(checkout, repo.home, "add", "export.txt");
}

// The release path on real git: CODEOWNERS read from the base as last fetched, the PR's diff from
// its merge base with the base, and the held PR never gets auto-merge.

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

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("auto-merge of a story PR on real git", () => {
    it("closes out, pushes once and turns auto-merge on at the pushed head with the PR title", async () => {
      await withBareRemote(
        async (repo) =>
          scenario(repo, async ({ merge, host, officeId }) => {
            await merge.tick(officeId);
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
  });

  describe("the close-out commit of a story that held a park record", () => {
    it("removes the F16 park block through the single field write path in the commit that sets Done", async () => {
      await withBareRemote(
        async (repo) =>
          scenario(repo, async ({ officeId, run, s }) => {
            const stored = findRun(s.office, run)!;
            // A park whose record stayed on the branch (DIPO-129's stale block).
            await gitParkWriter({ git: () => s.git, stories: backlogStoryStore(s.cli) }).write(
              officeId,
              {
                story: TASK_1,
                branch: BRANCH_1,
                reason: "conflict",
                note: "base moved during merge 3 times",
              },
            );
            const parked = await git(
              repo.dir,
              repo.home,
              "show",
              `refs/heads/${BRANCH_1}:${TASK_FILE_1}`,
            );
            expect(parked).toMatch(/^park:$/m);
            const mergeGit = gitStoryMergeOps({
              git: () => s.git,
              stories: backlogStoryStore(s.cli),
            });
            const commit = await mergeGit.closeOut(
              officeId,
              {
                runId: run,
                story: TASK_1,
                branch: BRANCH_1,
                startSha: stored.startSha as string,
              },
              (story) => story.setFinalSummary("Done by the close-out."),
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

  describe("a later close-out commit", () => {
    it("writes the final summary and the modified files again when the story is Done already", async () => {
      await withBareRemote(
        async (repo) =>
          scenario(repo, async ({ officeId, run, s }) => {
            const stored = findRun(s.office, run)!;
            const mergeRun = {
              runId: run,
              story: TASK_1,
              branch: BRANCH_1,
              startSha: stored.startSha as string,
            };
            const mergeGit = gitStoryMergeOps({
              git: () => s.git,
              stories: backlogStoryStore(s.cli),
            });
            let summary = "first stay";
            const write = (story: StoryEditor) => story.setFinalSummary(summary);
            const first = await mergeGit.closeOut(officeId, mergeRun, write);
            expect(first).not.toBeNull();
            // A fix round added code since; the next close-out writes again.
            await byHandOn(repo, BRANCH_1, async (dir) => {
              writeFileSync(join(dir, "later.txt"), "later\n");
              await git(dir, repo.home, "add", "later.txt");
              await git(dir, repo.home, "commit", "--quiet", "-m", "feat: later");
            });
            summary = "second stay";
            const second = await mergeGit.closeOut(officeId, mergeRun, write);
            expect(second).not.toBeNull();
            const task = await git(repo.dir, repo.home, "show", `${second}:${TASK_FILE_1}`);
            expect(task).toContain("status: Done");
            expect(task).toContain("later.txt");
            expect(task).toContain("second stay");
            expect(task).not.toContain("first stay");
            // Nothing new: no commit.
            expect(await mergeGit.closeOut(officeId, mergeRun, write)).toBeNull();
          }),
        { fixture: BACKLOG_FIXTURE },
      );
    });
  });

  describe("the release path of a story PR on real git", () => {
    it("holds a PR that changes a workflow, also when it edits CODEOWNERS to leave itself out", async () => {
      await withBareRemote(
        async (repo) => {
          releaseBase(repo);
          await scenario(
            repo,
            async ({ merge, host, officeId, run, head, s, mergeGit }) => {
              expect(await mergeGit.releasePaths(officeId, head)).toEqual([
                ".github/CODEOWNERS",
                ".github/workflows/ci.yml",
              ]);
              // Fail closed: a head git cannot read has no answer, and nothing gets auto-merge.
              expect(await mergeGit.releasePaths(officeId, "0".repeat(40))).toBeNull();
              await merge.tick(officeId);
              await merge.tick(officeId);
              expect(host.merges).toEqual([]);
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
              const main = await git(
                repo.remote,
                repo.home,
                "show",
                "main:.github/workflows/ci.yml",
              );
              expect(main).toBe("name: ci\n");
            },
            async (checkout) => {
              writeFileSync(join(checkout, ".github/workflows/ci.yml"), "name: ci\non: push\n");
              writeFileSync(join(checkout, ".github/CODEOWNERS"), "# nobody owns anything\n");
              await git(checkout, repo.home, "add", ".github");
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
            async ({ merge, host, officeId, head, mergeGit }) => {
              expect(await mergeGit.releasePaths(officeId, head)).toEqual(["install.sh"]);
              await merge.tick(officeId);
              expect(host.merges).toEqual([]);
            },
            async (checkout) => {
              mkdirSync(join(checkout, "scripts"), { recursive: true });
              await git(checkout, repo.home, "mv", "install.sh", "scripts/install.sh");
            },
          );
        },
        { fixture: BACKLOG_FIXTURE },
      );
    });

    it("holds a PR whose only change to install.sh is its mode", async () => {
      await withBareRemote(
        async (repo) => {
          releaseBase(repo);
          await scenario(
            repo,
            async ({ merge, host, officeId, head, mergeGit }) => {
              expect(await mergeGit.releasePaths(officeId, head)).toEqual(["install.sh"]);
              await merge.tick(officeId);
              expect(host.merges).toEqual([]);
            },
            async (checkout) => {
              chmodSync(join(checkout, "install.sh"), 0o755);
              await git(checkout, repo.home, "update-index", "--chmod=+x", "install.sh");
            },
          );
        },
        { fixture: BACKLOG_FIXTURE },
      );
    });

    it("holds a PR that deletes an owned file", async () => {
      await withBareRemote(
        async (repo) => {
          releaseBase(repo);
          await scenario(
            repo,
            async ({ merge, host, officeId, head, mergeGit }) => {
              expect(await mergeGit.releasePaths(officeId, head)).toEqual([
                ".github/workflows/ci.yml",
              ]);
              await merge.tick(officeId);
              expect(host.merges).toEqual([]);
            },
            async (checkout) => {
              await git(checkout, repo.home, "rm", "--quiet", ".github/workflows/ci.yml");
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
          await scenario(repo, async ({ merge, host, officeId, run, head, s, mergeGit }) => {
            expect(await mergeGit.releasePaths(officeId, head)).toEqual([]);
            await merge.tick(officeId);
            expect(host.merges).toHaveLength(1);
            expect(mergeGatesOfRun(s.office, run)[0]).toMatchObject({ handMerge: null });
          });
        },
        { fixture: BACKLOG_FIXTURE },
      );
    });
  });
}
